import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const DEFAULT_CONFIG = {
  url: "",
  mode: "attach",
  cdpEndpoint: "http://127.0.0.1:9222",
  intervalMinutes: 10,
  headless: false,
  profileDir: "./chrome-profile-win",
  outputDir: "./logs",
  locale: "zh-CN",
  timezoneId: "Asia/Kuala_Lumpur",
  tabMatch: {
    urlIncludes: ["ads.tiktok.com", "gmv-max/dashboard", "type=live"],
    titleIncludes: ["GMV"]
  },
  selectors: {
    planRows: "",
    planName: "",
    newSpend: "",
    newOrderAmount: "",
    totalSpend: "",
    totalOrderAmount: ""
  }
};

const LABELS = {
  newSpend: ["新增消耗", "New spend", "Additional spend"],
  newOrderAmount: ["新增成交金额", "新增成交额", "New GMV", "New revenue"],
  totalSpend: ["总消耗", "Total spend", "Cost"],
  totalOrderAmount: ["总成交金额", "总成交额", "Total GMV", "Total revenue", "Gross revenue"]
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = await loadConfig();
  const once = args.has("--once");
  const listTabs = args.has("--list-tabs");
  const intervalMs = Math.max(1, Number(config.intervalMinutes || 10)) * 60 * 1000;
  const outputDir = resolveProjectPath(config.outputDir);

  await fs.mkdir(outputDir, { recursive: true });

  const browserSession = await getBrowserSession(config);
  if (listTabs) {
    await printOpenTabs(browserSession);
    await browserSession.close();
    return;
  }

  const page = await findTargetPage(browserSession, config);
  console.log(`[GMVMAX-WIN] Attached tab: ${await page.title()} | ${page.url()}`);
  console.log(`[GMVMAX-WIN] Started. Refresh interval: ${config.intervalMinutes} minute(s).`);
  console.log("[GMVMAX-WIN] Keep the Chrome debugging window and TikTok GMV Max tab open.");

  do {
    await collectOnce(page, config, outputDir);
    if (once) break;
    await wait(intervalMs);
  } while (true);

  await page.close?.();
  await browserSession.close();
}

async function loadConfig() {
  const configPath = process.env.GMVMAX_CONFIG || path.join(PROJECT_ROOT, "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return mergeConfig(DEFAULT_CONFIG, {});
  }
}

function mergeConfig(base, override) {
  const envUrl = process.env.GMVMAX_URL;
  return {
    ...base,
    ...override,
    url: envUrl || override.url || base.url,
    tabMatch: {
      ...base.tabMatch,
      ...(override.tabMatch || {})
    },
    selectors: {
      ...base.selectors,
      ...(override.selectors || {})
    }
  };
}

function resolveProjectPath(value) {
  if (!value) return PROJECT_ROOT;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

async function getBrowserSession(config) {
  if (config.mode === "launch") {
    await fs.mkdir(resolveProjectPath(config.profileDir), { recursive: true });
    const context = await chromium.launchPersistentContext(resolveProjectPath(config.profileDir), {
      channel: "chrome",
      headless: Boolean(config.headless),
      locale: config.locale,
      timezoneId: config.timezoneId,
      viewport: { width: 1440, height: 980 },
      args: ["--disable-blink-features=AutomationControlled"]
    });
    const page = context.pages()[0] ?? (await context.newPage());
    if (config.url) {
      await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    }
    return {
      kind: "playwright",
      pages: async () => context.pages(),
      connectPage: async (page) => page,
      close: () => context.close()
    };
  }

  try {
    const targets = await fetchCdpTargets(config.cdpEndpoint);
    return {
      kind: "cdp",
      pages: async () => targets.filter((target) => target.type === "page").map((target) => new CdpPageTarget(config.cdpEndpoint, target)),
      connectPage: async (target) => CdpPage.connect(target),
      close: async () => {}
    };
  } catch (error) {
    throw new Error(
      [
        `Cannot connect to Chrome at ${config.cdpEndpoint}.`,
        "On Windows 11, run this first:",
        "npm run start:chrome",
        "Then open the TikTok GMV Max page in that Chrome window and complete login.",
        `Original error: ${error.message}`
      ].join("\n")
    );
  }
}

async function printOpenTabs(browserSession) {
  const pages = await browserSession.pages();
  if (pages.length === 0) {
    console.log("[GMVMAX-WIN] No open pages found.");
    return;
  }
  for (const [index, page] of pages.entries()) {
    console.log(`[${index + 1}] ${await safeTitle(page)} | ${page.url()}`);
  }
}

async function findTargetPage(browserSession, config) {
  const pages = (await browserSession.pages()).filter((page) => isInspectablePage(page));
  if (pages.length === 0) throw new Error("No inspectable Chrome tabs found.");

  const scored = [];
  for (const page of pages) {
    const title = await safeTitle(page);
    const url = page.url();
    scored.push({ page, title, url, score: scorePage({ title, url }, config) });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) {
    const tabList = scored.map((item, index) => `[${index + 1}] ${item.title} | ${item.url}`).join("\n");
    throw new Error(`Could not find the TikTok GMV Max tab. Open tabs:\n${tabList}`);
  }
  if (isTikTokLoginPage(best.url)) {
    throw new Error("Found the TikTok Ads login tab. Complete login in Chrome first, then run the monitor again.");
  }
  const page = await browserSession.connectPage(best.page);
  await page.bringToFront().catch(() => {});
  return page;
}

function isInspectablePage(page) {
  const url = page.url();
  return url && !url.startsWith("chrome://") && !url.startsWith("devtools://");
}

async function safeTitle(page) {
  try { return await page.title(); } catch { return ""; }
}

function scorePage({ title, url }, config) {
  const targetUrl = config.url || "";
  const target = safelyParseUrl(targetUrl);
  const current = safelyParseUrl(url);
  let score = 0;
  if (target && current && current.host === target.host) score += 4;
  if (target && current && current.pathname === target.pathname) score += 6;
  if (targetUrl && url === targetUrl) score += 20;
  for (const part of config.tabMatch.urlIncludes || []) if (part && url.includes(part)) score += 3;
  for (const part of config.tabMatch.titleIncludes || []) if (part && title.toLowerCase().includes(part.toLowerCase())) score += 2;
  return score;
}

function safelyParseUrl(value) {
  try { return value ? new URL(value) : null; } catch { return null; }
}

function isTikTokLoginPage(url) {
  const parsed = safelyParseUrl(url);
  return parsed?.host === "ads.tiktok.com" && parsed.pathname.includes("/login");
}

async function fetchCdpTargets(endpoint) {
  const url = `${endpoint.replace(/\/$/, "")}/json/list`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Chrome DevTools returned ${response.status} ${response.statusText}`);
  return response.json();
}

class CdpPageTarget {
  constructor(endpoint, target) { this.endpoint = endpoint; this.target = target; }
  url() { return this.target.url || ""; }
  async title() { return this.target.title || ""; }
}

class CdpPage {
  constructor(target, socket) {
    this.target = target;
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => this.onMessage(event));
  }

  static async connect(pageTarget) {
    if (!pageTarget.target.webSocketDebuggerUrl) throw new Error(`Target has no webSocketDebuggerUrl: ${pageTarget.url()}`);
    const socket = new WebSocket(pageTarget.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const page = new CdpPage(pageTarget.target, socket);
    await page.command("Page.enable");
    await page.command("Runtime.enable");
    return page;
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  command(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  url() { return this.target.url || ""; }
  async title() { return (await this.evaluate(() => document.title)) || this.target.title || ""; }
  async bringToFront() { await this.command("Page.bringToFront"); }
  async reload() { await this.command("Page.reload", { ignoreCache: true }); await this.waitForTimeout(8000); }
  async waitForTimeout(ms) { await wait(ms); }
  async evaluate(fn, arg) {
    const expression = `(${fn})(${JSON.stringify(arg)})`;
    const result = await this.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Evaluation failed");
    return result.result?.value;
  }
  async screenshot({ path: screenshotPath }) {
    const result = await this.command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
    await fs.writeFile(screenshotPath, result.data, "base64");
  }
  async close() { this.socket.close(); }
}

async function collectOnce(page, config, outputDir) {
  const timestamp = new Date().toISOString();
  console.log(`[GMVMAX-WIN] ${timestamp} refreshing dashboard...`);
  await page.reload({ waitUntil: "networkidle", timeout: 120_000 });
  await acceptVisibleDialogs(page);
  await page.waitForTimeout(5000);

  const record = await page.evaluate(({ labels, selectors }) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const moneyRe = /(?:[$￥¥]|MYR|RM|USD|CNY|RMB)?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/;

    function firstText(selector, root = document) {
      if (!selector) return null;
      const node = root.querySelector(selector);
      return node ? textOf(node) : null;
    }

    function valueAfterLabel(labelOptions) {
      const all = Array.from(document.querySelectorAll("body *"));
      for (const node of all) {
        const ownText = textOf(node);
        if (!ownText || ownText.length > 500) continue;
        if (!labelOptions.some((label) => ownText.includes(label))) continue;
        const label = labelOptions.find((item) => ownText.includes(item));
        const localMatch = ownText.replace(label, "").match(moneyRe);
        if (localMatch) return localMatch[0].trim();
        const parent = node.parentElement;
        if (!parent) continue;
        const siblings = Array.from(parent.children);
        const index = siblings.indexOf(node);
        const candidates = siblings.slice(index + 1).concat(Array.from(parent.querySelectorAll("*")));
        for (const candidate of candidates) {
          const match = textOf(candidate).match(moneyRe);
          if (match) return match[0].trim();
        }
      }
      return null;
    }

    function extractBySelectors() {
      if (!selectors.planRows) return [];
      return Array.from(document.querySelectorAll(selectors.planRows)).map((row, index) => ({
        index: index + 1,
        account: firstText(selectors.account, row) || null,
        name: firstText(selectors.planName, row) || `plan-${index + 1}`,
        newSpend: firstText(selectors.newSpend, row),
        newOrderAmount: firstText(selectors.newOrderAmount, row),
        totalSpend: firstText(selectors.totalSpend, row),
        totalOrderAmount: firstText(selectors.totalOrderAmount, row)
      }));
    }

    function parseNumber(value) {
      if (!value) return null;
      const normalized = String(value).replace(/,/g, "");
      const match = normalized.match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    }

    function moneyText(value) {
      return value == null ? null : `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MYR`;
    }

    function englishOverviewMetrics(bodyText) {
      const cost = bodyText.match(/\bCost\s+([\d,]+(?:\.\d+)?)\s+MYR\s+vs last/i);
      const grossRevenue = bodyText.match(/\bGross revenue \(Current shop\)\s+([\d,]+(?:\.\d+)?)\s+MYR\s+vs last/i);
      return {
        totalSpend: cost?.[1] ? `${cost[1]} MYR` : null,
        totalOrderAmount: grossRevenue?.[1] ? `${grossRevenue[1]} MYR` : null
      };
    }

    function englishLivePlans(bodyText) {
      const rows = [];
      const rowPattern = /(LIVE GMV Max_[\s\S]*?)(?=\sLIVE GMV Max_| u user|\s*$)/g;
      let match;
      while ((match = rowPattern.exec(bodyText)) !== null) {
        const rowText = match[1].replace(/\s+/g, " ").trim();
        const values = Array.from(rowText.matchAll(/([\d,]+(?:\.\d+)?)\s+MYR/g)).map((item) => parseNumber(item[1]));
        if (values.length < 6) continue;
        const grossRevenueIndex = values.length >= 7 ? values.length - 5 : values.length - 4;
        const planName = rowText.match(/^(.*?)\s+Active\s+/)?.[1] || `live-plan-${rows.length + 1}`;
        const account = rowText.match(/recommendations?\s+(.*?)\s+ID:/i)?.[1] || rowText.match(/Available TikTok accounts\s+(.*?)\s+ID:/i)?.[1] || null;
        rows.push({
          index: rows.length + 1,
          account,
          name: planName,
          netSpend: moneyText(values[grossRevenueIndex - 1]),
          totalSpend: moneyText(values[2]),
          totalOrderAmount: moneyText(values[grossRevenueIndex])
        });
      }
      return rows;
    }

    const bodyText = textOf(document.body).slice(0, 30000);
    const labelMetrics = Object.fromEntries(Object.entries(labels).map(([key, labelOptions]) => [key, valueAfterLabel(labelOptions)]));
    const englishMetrics = englishOverviewMetrics(bodyText);
    const plans = extractBySelectors();
    const englishPlans = englishLivePlans(bodyText);
    const parsedPlans = plans.length > 0 ? plans : englishPlans;
    return {
      url: location.href,
      title: document.title,
      metrics: {
        newSpend: labelMetrics.newSpend || null,
        newOrderAmount: labelMetrics.newOrderAmount || null,
        totalSpend: labelMetrics.totalSpend || englishMetrics.totalSpend,
        totalOrderAmount: labelMetrics.totalOrderAmount || englishMetrics.totalOrderAmount
      },
      plans: parsedPlans,
      bodyText
    };
  }, { labels: LABELS, selectors: config.selectors });

  const result = { timestamp, url: record.url, title: record.title, liveGmvMax: record.metrics, plans: record.plans };
  await enrichPlanIncrements(path.join(outputDir, "gmvmax-records.jsonl"), result);
  await appendJsonl(path.join(outputDir, "gmvmax-records.jsonl"), result);
  await appendCsv(path.join(outputDir, "gmvmax-records.csv"), result);
  await appendPlanCsv(path.join(outputDir, "gmvmax-plan-records.csv"), result);

  const missing = Object.entries(result.liveGmvMax).filter(([, value]) => !value);
  if (missing.length > 0) {
    const safeStamp = timestamp.replace(/[:.]/g, "-");
    await fs.writeFile(path.join(outputDir, `debug-${safeStamp}.txt`), record.bodyText, "utf8");
    await page.screenshot({ path: path.join(outputDir, `debug-${safeStamp}.png`), fullPage: true });
    console.warn(`[GMVMAX-WIN] Some metrics were not found: ${missing.map(([key]) => key).join(", ")}`);
    console.warn("[GMVMAX-WIN] Saved debug text and screenshot in logs/. Add CSS selectors in config.json if needed.");
  }
  console.log(`[GMVMAX-WIN] Saved: ${JSON.stringify(result.liveGmvMax)}`);
}

async function enrichPlanIncrements(historyPath, result) {
  const previous = await readLatestRecordWithPlans(historyPath);
  const previousByAccount = new Map((previous?.plans || []).filter((plan) => plan.account).map((plan) => [plan.account, plan]));
  for (const plan of result.plans || []) {
    const key = plan.account || plan.name;
    const previousPlan = previousByAccount.get(key) || (previous?.plans || []).find((item) => (item.account || item.name) === key);
    const spendIncrease = previousPlan ? parseMoney(plan.totalSpend) - parseMoney(previousPlan.totalSpend) : 0;
    const orderAmountIncrease = previousPlan ? parseMoney(plan.totalOrderAmount) - parseMoney(previousPlan.totalOrderAmount) : 0;
    plan.intervalSpendIncrease = moneyText(Math.max(0, spendIncrease));
    plan.intervalOrderAmountIncrease = moneyText(Math.max(0, orderAmountIncrease));
  }
  const intervalSpend = (result.plans || []).reduce((sum, plan) => sum + parseMoney(plan.intervalSpendIncrease), 0);
  const intervalOrderAmount = (result.plans || []).reduce((sum, plan) => sum + parseMoney(plan.intervalOrderAmountIncrease), 0);
  result.liveGmvMax.newSpend = moneyText(intervalSpend);
  result.liveGmvMax.newOrderAmount = moneyText(intervalOrderAmount);
}

async function readLatestRecordWithPlans(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]);
      if (Array.isArray(record.plans) && record.plans.length > 0) return record;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

function parseMoney(value) {
  if (!value) return 0;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function moneyText(value) {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MYR`;
}

async function acceptVisibleDialogs(page) {
  const buttons = ["Accept all", "Accept", "同意", "接受", "我知道了", "Got it"];
  await page.evaluate((names) => {
    const elements = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const element of elements) {
      const text = (element.innerText || element.textContent || "").trim();
      if (names.some((name) => text.includes(name))) element.click();
    }
  }, buttons).catch(() => {});
}

async function appendJsonl(filePath, value) { await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8"); }

async function appendCsv(filePath, result) {
  const exists = await fileExists(filePath);
  const row = [result.timestamp, result.liveGmvMax.newSpend, result.liveGmvMax.newOrderAmount, result.liveGmvMax.totalSpend, result.liveGmvMax.totalOrderAmount, result.url].map(csvCell);
  if (!exists) await fs.appendFile(filePath, "timestamp,new_spend,new_order_amount,total_spend,total_order_amount,url\n", "utf8");
  await fs.appendFile(filePath, `${row.join(",")}\n`, "utf8");
}

async function appendPlanCsv(filePath, result) {
  const exists = await fileExists(filePath);
  if (!exists) await fs.appendFile(filePath, "timestamp,account,campaign,interval_spend_increase,interval_order_amount_increase,total_spend,total_order_amount,net_spend,url\n", "utf8");
  for (const plan of result.plans || []) {
    const row = [result.timestamp, plan.account, plan.name, plan.intervalSpendIncrease, plan.intervalOrderAmountIncrease, plan.totalSpend, plan.totalOrderAmount, plan.netSpend, result.url].map(csvCell);
    await fs.appendFile(filePath, `${row.join(",")}\n`, "utf8");
  }
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
