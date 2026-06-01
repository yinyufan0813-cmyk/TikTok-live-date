import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { extractLiveDashboardMetrics } from "./extract-live-dashboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PREFIX = "LIVE-MONITOR";

const DEFAULT_CONFIG = {
  mode: "attach",
  cdpEndpoint: "http://127.0.0.1:9222",
  intervalMinutes: 10,
  headless: false,
  profileDir: "./chrome-profile-win",
  outputDir: "./logs",
  locale: "zh-CN",
  timezoneId: "Asia/Kuala_Lumpur",
  liveAnalytics: {
    overviewUrl: "https://seller-my.tiktok.com/compass/data-overview?shop_region=MY",
    maxRooms: 12,
    liveStreamsText: "LIVE streams",
    liveRoomTexts: [],
    discoverEveryRun: true,
    selectors: {
      liveStreamsTrigger: "",
      liveRoomItems: "",
      metricHover: "",
      roomName: "",
      currentViewers: "",
      tapThroughRateViaLivePreview: "",
      tapThroughRate: "",
      liveCtr: "",
      orderRateSkuOrders: "",
      adsCost: "",
      gmvMaxRoi: ""
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const args = new Set(process.argv.slice(2));
  const once = args.has("--once");
  const listTabs = args.has("--list-tabs");
  const config = await loadConfig();
  const outputDir = resolveProjectPath(config.outputDir);
  const intervalMs = Math.max(1, Number(config.liveAnalytics.intervalMinutes || config.intervalMinutes || 10)) * 60 * 1000;

  await fs.mkdir(outputDir, { recursive: true });

  const session = await getBrowserSession(config);
  if (listTabs) {
    await printOpenTabs(session.context);
    await session.close();
    return;
  }

  let overviewPage = await findOrOpenOverviewPage(session.context, config);
  const livePages = new Map();
  console.log(`[${PREFIX}] Attached overview: ${await safeTitle(overviewPage)} | ${overviewPage.url()}`);
  console.log(`[${PREFIX}] Started. Refresh interval: ${intervalMs / 60_000} minute(s).`);

  do {
    overviewPage = await collectOnce({ context: session.context, overviewPage, livePages, config, outputDir });
    if (once) break;
    await wait(intervalMs);
  } while (true);

  await session.close();
}

async function loadConfig() {
  const configPath = process.env.GMVMAX_CONFIG || path.join(PROJECT_ROOT, "config.json");
  let override = {};
  try {
    override = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return mergeConfig(DEFAULT_CONFIG, override);
}

function mergeConfig(base, override) {
  const liveOverride = override.liveAnalytics || {};
  return {
    ...base,
    ...override,
    outputDir: process.env.GMVMAX_OUTPUT_DIR || override.outputDir || base.outputDir,
    liveAnalytics: {
      ...base.liveAnalytics,
      ...liveOverride,
      overviewUrl: process.env.LIVE_ANALYTICS_URL || liveOverride.overviewUrl || base.liveAnalytics.overviewUrl,
      selectors: {
        ...base.liveAnalytics.selectors,
        ...(liveOverride.selectors || {})
      }
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
      viewport: { width: 1920, height: 1080 },
      args: ["--disable-blink-features=AutomationControlled"]
    });
    return { context, close: () => context.close() };
  }

  const browser = await chromium.connectOverCDP(config.cdpEndpoint);
  const context = browser.contexts()[0] || (await browser.newContext());
  return { context, close: async () => {} };
}

async function printOpenTabs(context) {
  const pages = context.pages();
  if (pages.length === 0) {
    console.log(`[${PREFIX}] No open pages found.`);
    return;
  }
  for (const [index, page] of pages.entries()) {
    console.log(`[${index + 1}] ${await safeTitle(page)} | ${page.url()}`);
  }
}

async function findOrOpenOverviewPage(context, config) {
  const overviewUrl = config.liveAnalytics.overviewUrl;
  const scored = [];
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const url = page.url();
    if (!url || url.startsWith("chrome://") || url.startsWith("devtools://")) continue;
    const score = scoreOverviewPage(url, overviewUrl);
    if (score > 0) scored.push({ page, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].page;

  const page = await context.newPage();
  await page.goto(overviewUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  return page;
}

function scoreOverviewPage(currentUrl, overviewUrl) {
  const current = safelyParseUrl(currentUrl);
  const overview = safelyParseUrl(overviewUrl);
  if (!current || !overview) return 0;
  let score = 0;
  if (current.host !== overview.host) return 0;
  if (!current.pathname.includes("/compass/data-overview")) return 0;
  score += 8;
  if (current.pathname === overview.pathname) score += 8;
  if (currentUrl === overviewUrl) score += 10;
  return score;
}

function safelyParseUrl(value) {
  try { return value ? new URL(value) : null; } catch { return null; }
}

async function collectOnce({ context, overviewPage, livePages, config, outputDir }) {
  const timestamp = new Date().toISOString();
  console.log(`[${PREFIX}] ${timestamp} discovering LIVE rooms...`);
  overviewPage = await ensureOverviewPage(context, overviewPage, config);

  let discoveredRoomCount = null;
  if (config.liveAnalytics.discoverEveryRun !== false) {
    discoveredRoomCount = await syncLivePages(context, overviewPage, livePages, config);
  } else {
    syncExistingLivePages(context, livePages);
  }

  if (config.liveAnalytics.discoverEveryRun !== false && discoveredRoomCount == null) {
    console.warn(`[${PREFIX}] Skipped this LIVE sample because the overview LIVE streams list was not rediscovered.`);
    return overviewPage;
  }

  if (livePages.size === 0) {
    console.warn(`[${PREFIX}] No LIVE dashboard pages found. Hover/click the LIVE streams list once or add selectors in config.json.`);
    return overviewPage;
  }

  await dedupeLivePages(context, overviewPage, livePages);

  const records = [];
  const seenRoomIds = new Set();
  for (const [key, entry] of livePages.entries()) {
    if (entry.page.isClosed()) {
      const replacement = findLivePageReplacement(context, entry);
      if (replacement) {
        entry.page = replacement;
        entry.url = replacement.url();
      } else {
        livePages.delete(key);
        continue;
      }
    }
    const roomId = liveRoomIdFromUrl(entry.page.url() || entry.url || "");
    if (roomId && seenRoomIds.has(roomId)) {
      await entry.page?.close?.().catch(() => {});
      livePages.delete(key);
      continue;
    }
    if (roomId) seenRoomIds.add(roomId);
    const record = await collectLivePage(entry.page, timestamp, config, outputDir, entry.label).catch(async (error) => {
      if (isClosedTargetError(error)) {
        const replacement = findLivePageReplacement(context, entry);
        if (replacement && replacement !== entry.page) {
          entry.page = replacement;
          entry.url = replacement.url();
          return collectLivePage(entry.page, timestamp, config, outputDir, entry.label).catch((retryError) => {
            console.warn(`[${PREFIX}] Failed to read ${key} after reattaching: ${retryError.message}`);
            return null;
          });
        }
      }
      console.warn(`[${PREFIX}] Failed to read ${key}: ${error.message}`);
      return null;
    });
    if (record) records.push(record);
  }

  await wait(1500);
  await closeUntrackedLiveDashboardPages(context, overviewPage, livePages);

  const uniqueRecords = dedupeLiveRecords(records);
  if (uniqueRecords.length === 0) return overviewPage;
  if (Number.isFinite(discoveredRoomCount) && uniqueRecords.length < discoveredRoomCount) {
    console.warn(`[${PREFIX}] Skipped partial LIVE sample: collected ${uniqueRecords.length}/${discoveredRoomCount} discovered room(s).`);
    return overviewPage;
  }
  await appendJsonl(path.join(outputDir, "live-room-records.jsonl"), { timestamp, records: uniqueRecords });
  await appendLiveCsv(path.join(outputDir, "live-room-records.csv"), uniqueRecords);
  console.log(`[${PREFIX}] Saved ${uniqueRecords.length} LIVE room record(s).`);
  await closeUntrackedLiveDashboardPages(context, overviewPage, livePages);
  return overviewPage;
}

async function ensureOverviewPage(context, overviewPage, config) {
  if (overviewPage && !overviewPage.isClosed()) return overviewPage;
  console.warn(`[${PREFIX}] Overview page was closed. Reopening ${config.liveAnalytics.overviewUrl}`);
  return findOrOpenOverviewPage(context, config);
}

function syncExistingLivePages(context, livePages) {
  for (const page of context.pages()) {
    const url = page.url();
    if (!isLiveDashboardUrl(url)) continue;
    const key = livePageKey(url);
    const existing = livePages.get(key);
    if (existing && existing.page !== page) continue;
    livePages.set(key, { page, label: existing?.label || liveLabelFromUrl(url), url });
  }
}

function isLiveDashboardUrl(url) {
  const parsed = safelyParseUrl(url);
  return parsed?.host === "seller-my.tiktok.com" && /^\/workbench\/live(?:\/overview)?$/.test(parsed.pathname);
}

function liveRoomIdFromUrl(url) {
  return safelyParseUrl(url)?.searchParams.get("room_id") || "";
}

function livePageKey(url) {
  return liveRoomIdFromUrl(url) || normalizeUrl(url);
}

function findLivePageReplacement(context, entry) {
  const roomId = liveRoomIdFromUrl(entry.url || entry.page?.url?.() || "");
  const pages = context.pages().filter((page) => !page.isClosed() && isLiveDashboardUrl(page.url()));
  return pages.find((page) => roomId && liveRoomIdFromUrl(page.url()) === roomId) || pages.find((page) => normalizeUrl(page.url()) === normalizeUrl(entry.url || "")) || null;
}

async function dedupeLivePages(context, keepPage, livePages) {
  const byRoomId = new Map();
  for (const [key, entry] of Array.from(livePages.entries())) {
    if (!entry.page || entry.page.isClosed()) {
      livePages.delete(key);
      continue;
    }
    const url = entry.page.url() || entry.url || "";
    if (!isLiveDashboardUrl(url)) {
      livePages.delete(key);
      continue;
    }
    const roomId = liveRoomIdFromUrl(url);
    if (!roomId) continue;
    const existing = byRoomId.get(roomId);
    if (!existing) {
      byRoomId.set(roomId, { key, entry });
      continue;
    }
    const existingHasHandle = /^@/.test(existing.entry.label || "");
    const currentHasHandle = /^@/.test(entry.label || "");
    const keepCurrent = currentHasHandle && !existingHasHandle;
    const remove = keepCurrent ? existing : { key, entry };
    if (keepCurrent) byRoomId.set(roomId, { key, entry });
    await remove.entry.page?.close?.().catch(() => {});
    livePages.delete(remove.key);
  }

  for (const [roomId, { key, entry }] of byRoomId.entries()) {
    if (key === roomId) continue;
    livePages.delete(key);
    livePages.set(roomId, entry);
  }
  await closeUntrackedLiveDashboardPages(context, keepPage, livePages);
}

function dedupeLiveRecords(records) {
  const byRoom = new Map();
  for (const record of records) {
    const roomId = liveRoomIdFromUrl(record.url || "");
    const key = roomId || record.url || record.room;
    const existing = byRoom.get(key);
    if (!existing) {
      byRoom.set(key, record);
      continue;
    }
    const existingHasHandle = /^@/.test(existing.room || "");
    const currentHasHandle = /^@/.test(record.room || "");
    if (currentHasHandle && !existingHasHandle) {
      byRoom.set(key, record);
    }
  }
  return Array.from(byRoom.values());
}

function isClosedTargetError(error) {
  return /Target page, context or browser has been closed|Target closed|Page closed/i.test(error?.message || "");
}

async function syncLivePages(context, overviewPage, livePages, config) {
  await overviewPage.goto(config.liveAnalytics.overviewUrl, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  await overviewPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await acceptVisibleDialogs(overviewPage);
  const menuOpened = await openLiveStreamsMenu(overviewPage, config).catch((error) => {
    console.warn(`[${PREFIX}] Could not open LIVE streams menu: ${error.message}`);
    return false;
  });
  if (!menuOpened) {
    syncExistingLivePages(context, livePages);
    if (livePages.size === 0) {
      console.warn(`[${PREFIX}] LIVE streams trigger was not found. No active LIVE rooms were discovered on the overview page.`);
    }
    return null;
  }
  const candidates = await collectLiveRoomCandidates(overviewPage, config);
  const filtered = filterCandidates(candidates, config).slice(0, config.liveAnalytics.maxRooms || 12);

  if (filtered.length === 0) {
    await closeLiveDashboardPages(context, overviewPage);
    livePages.clear();
    console.warn(`[${PREFIX}] LIVE streams menu opened, but no room candidates were found.`);
    return 0;
  }

  console.log(`[${PREFIX}] Found ${filtered.length} LIVE room candidate(s): ${filtered.map((candidate) => candidate.handle || candidate.key).join(", ")}`);
  const activeKeys = new Set(filtered.map((candidate, index) => candidate.key || candidate.href || `room-${index + 1}`));
  const activeLabels = new Set(filtered.map((candidate) => candidate.handle).filter(Boolean));
  for (const [key, entry] of livePages.entries()) {
    if (activeKeys.has(key)) continue;
    if (entry.label && activeLabels.has(entry.label)) continue;
    await entry.page?.close?.().catch(() => {});
    livePages.delete(key);
  }

  for (const [index, candidate] of filtered.entries()) {
    const key = candidate.key || candidate.href || `room-${index + 1}`;
    const existing = livePages.get(key) || Array.from(livePages.values()).find((entry) => entry.label && entry.label === candidate.handle);
    if (existing && !existing.page.isClosed() && isLiveDashboardUrl(existing.page.url())) {
      existing.label = candidate.handle || existing.label;
      existing.url = existing.page.url();
      console.log(`[${PREFIX}] Reusing LIVE room ${candidate.handle || key}: ${existing.page.url()}`);
      continue;
    }

    const page = await openLiveDashboardFromCandidate(context, config, candidate, index);
    if (page) {
      livePages.set(key, { page, label: candidate.handle || candidate.text || liveLabelFromUrl(page.url()), url: page.url() });
      console.log(`[${PREFIX}] Opened LIVE room ${candidate.handle || key}: ${page.url()}`);
    } else {
      console.warn(`[${PREFIX}] Could not open LIVE room ${candidate.handle || key}.`);
    }
  }
  await wait(1500);
  await closeUntrackedLiveDashboardPages(context, overviewPage, livePages);
  return filtered.length;
}

async function closeLiveDashboardPages(context, keepPage = null) {
  for (const page of context.pages()) {
    if (keepPage && page === keepPage) continue;
    if (!isLiveDashboardUrl(page.url())) continue;
    await page.close().catch(() => {});
  }
}

async function closeUntrackedLiveDashboardPages(context, keepPage, livePages) {
  const trackedPages = new Set(Array.from(livePages.values()).map((entry) => entry.page).filter(Boolean));
  const seenKeys = new Set();
  for (const page of context.pages()) {
    if (keepPage && page === keepPage) continue;
    if (!isLiveDashboardUrl(page.url())) continue;
    const key = livePageKey(page.url());
    if (trackedPages.has(page) && !seenKeys.has(key)) {
      seenKeys.add(key);
      continue;
    }
    await page.close().catch(() => {});
  }
}

async function openLiveStreamsMenu(page, config) {
  await dismissBlockingOverlays(page);
  await page.bringToFront().catch(() => {});
  const { selectors, liveStreamsText } = config.liveAnalytics;
  if (selectors.liveStreamsTrigger) {
    const trigger = page.locator(selectors.liveStreamsTrigger).first();
    const exists = await trigger.count().then((count) => count > 0).catch(() => false);
    if (!exists) return false;
    const hovered = await hoverElement(trigger);
    if (!hovered) return false;
    await page.waitForTimeout(1200);
    return true;
  }

  const moved = await hoverLiveStreamsByCoordinate(page, liveStreamsText || "LIVE streams");
  if (moved) return true;

  const labels = Array.from(new Set([liveStreamsText || "LIVE streams", "LIVE streams", "直播"])).filter(Boolean);
  for (const label of labels) {
    const trigger = page.getByText(label, { exact: false }).last();
    const exists = await trigger.count().then((count) => count > 0).catch(() => false);
    if (!exists) continue;
    const hovered = await hoverElement(trigger);
    if (!hovered) continue;
    await page.waitForTimeout(1200);
    return true;
  }
  await page.waitForTimeout(1200);
  return page.evaluate(() => /@[A-Za-z0-9._-]+/.test(document.body?.innerText || "")).catch(() => false);
}

async function hoverLiveStreamsByCoordinate(page, liveStreamsText) {
  const labels = Array.from(new Set([liveStreamsText || "LIVE streams", "LIVE streams", "直播"])).filter(Boolean);
  const rect = await page.evaluate((candidateLabels) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const nodes = Array.from(document.querySelectorAll("div,button,[role='button'],[tabindex]"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { text: textOf(node), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .filter((item) => item.width > 40 && item.height > 10 && item.x > window.innerWidth * 0.45)
      .filter((item) => {
        const text = item.text;
        if (/@[A-Za-z0-9._-]+/.test(text)) return false;
        if (/LIVE\s*streams\s*\+?\d*/i.test(text)) return true;
        if (/直播.*\+?\d*/.test(text)) return true;
        return candidateLabels.some((label) => text.includes(label) && /\+\s*\d+|\b\d+\b/.test(text));
      })
      .sort((a, b) => (a.width - b.width) || (b.x - a.x));
    return nodes[0] || null;
  }, labels).catch(() => null);

  if (!rect) return false;
  const y = Math.max(0, rect.y + rect.height / 2);
  const points = [
    rect.x + Math.min(12, rect.width / 3),
    rect.x + Math.min(60, rect.width / 2),
    rect.x + Math.max(rect.width - 18, rect.width / 2)
  ];
  for (const x of points) {
    await page.mouse.move(Math.max(0, x), y).catch(() => {});
    await page.waitForTimeout(700);
    const hasHandles = await page.evaluate(() => /@[A-Za-z0-9._-]+/.test(document.body?.innerText || "")).catch(() => false);
    if (hasHandles) return true;
  }
  await page.mouse.click(Math.max(0, points[0]), y).catch(() => {});
  await page.waitForTimeout(1000);
  return page.evaluate(() => /@[A-Za-z0-9._-]+/.test(document.body?.innerText || "")).catch(() => false);
}

async function hoverElement(locator) {
  try {
    await locator.hover({ timeout: 8000, force: true });
    return true;
  } catch {
    // Fall through to synthetic mouse events; some TikTok Shop rows ignore Playwright hover.
  }
  return locator.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["mouseenter", "mouseover", "mousemove"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }, undefined, { timeout: 3000 }).catch(() => false);
}

async function collectLiveRoomCandidates(page, config) {
  return page.evaluate(({ itemSelector }) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) !== 0;
    };
    const handlesIn = (value) => value.match(/@[A-Za-z0-9._-]+/g) || [];
    const looksLikeLiveListContainer = (value) => /LIVE\s*streams|What's ongoing|GMV rankings|直播/.test(value);
    const rowFor = (node, handle) => {
      let current = node;
      let fallback = null;
      while (current && current !== document.body) {
        const rect = current.getBoundingClientRect();
        const currentText = textOf(current);
        if (currentText.includes(handle) && rect.width >= 120 && rect.height >= 28 && rect.height <= 120) {
          if (handlesIn(currentText).length > 1 || looksLikeLiveListContainer(currentText)) {
            current = current.parentElement;
            continue;
          }
          const role = current.getAttribute("role") || "";
          const className = String(current.className || "");
          const clickable = typeof current.onclick === "function" || className.includes("cursor-pointer") || ["button", "link", "menuitem"].includes(role);
          if (clickable) return current;
          fallback ||= current;
        }
        current = current.parentElement;
      }
      return node.closest("a,button,[role='button'],[role='menuitem'],[tabindex]") || fallback || node;
    };
    const source = itemSelector
      ? Array.from(document.querySelectorAll(itemSelector))
      : Array.from(document.querySelectorAll("a,button,[role='button'],[role='menuitem'],[tabindex],div,span"));
    const seen = new Set();
    const candidates = [];
    const nodes = source
      .filter(visible)
      .map((node) => {
        const text = textOf(node);
        const handle = text.match(/@[A-Za-z0-9._-]+/)?.[0] || "";
        const rect = node.getBoundingClientRect();
        return { node, text, handle, area: rect.width * rect.height };
      })
      .filter((item) => item.handle && item.text && item.text.length <= 260)
      .sort((a, b) => a.area - b.area);

    for (const { node, text, handle } of nodes) {
      const clickable = rowFor(node, handle);
      const rect = clickable.getBoundingClientRect();
      if (rect.width < 100 || rect.width > 380 || rect.height < 28 || rect.height > 90) continue;
      if (rect.x < window.innerWidth * 0.55) continue;
      const clickableText = textOf(clickable);
      const rowHandles = handlesIn(clickableText);
      if (!clickableText.includes(handle)) continue;
      if (rowHandles.length !== 1 || rowHandles[0] !== handle) continue;
      if (looksLikeLiveListContainer(clickableText)) continue;
      const href = clickable.href || clickable.closest?.("a")?.href || "";
      const key = handle || href || text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const marker = `gmvmax-live-${candidates.length + 1}`;
      clickable.setAttribute("data-gmvmax-live-candidate", marker);
      candidates.push({
        marker,
        text,
        href,
        handle,
        key,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      });
    }
    return candidates;
  }, { itemSelector: config.liveAnalytics.selectors.liveRoomItems || "" });
}

function filterCandidates(candidates, config) {
  const wanted = config.liveAnalytics.liveRoomTexts || [];
  if (!wanted.length) return candidates;
  return candidates.filter((candidate) => wanted.some((part) => candidate.text.includes(part) || candidate.href.includes(part)));
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value || "";
  }
}

function liveLabelFromUrl(value) {
  const parsed = safelyParseUrl(value);
  const roomId = parsed?.searchParams.get("room_id");
  return roomId ? `room-${roomId.slice(-6)}` : "LIVE room";
}

async function openLiveDashboardFromCandidate(context, config, candidate, index) {
  if (candidate.href) {
    const page = await context.newPage();
    await page.goto(candidate.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    return page;
  }

  const page = await context.newPage();
  await page.goto(config.liveAnalytics.overviewUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await acceptVisibleDialogs(page);
  const menuOpened = await openLiveStreamsMenu(page, config);
  if (!menuOpened) {
    await page.close().catch(() => {});
    return null;
  }
  const freshCandidates = filterCandidates(await collectLiveRoomCandidates(page, config), config);
  const fresh = freshCandidates.find((item) => item.key === candidate.key || item.handle === candidate.handle) || freshCandidates[index];
  if (!fresh) {
    await page.close().catch(() => {});
    return null;
  }

  const beforeUrl = page.url();
  const newPagePromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
  await clickLiveCandidate(page, fresh);
  const opened = await newPagePromise;
  if (opened) {
    await opened.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    await page.close().catch(() => {});
    return opened;
  }
  await page.waitForURL((url) => url.toString() !== beforeUrl, { timeout: 30_000 }).catch(() => {});
  if (!isLiveDashboardUrl(page.url())) {
    await page.close().catch(() => {});
    return null;
  }
  return page;
}

async function clickLiveCandidate(page, candidate) {
  const locator = page.locator(`[data-gmvmax-live-candidate="${candidate.marker}"]`).first();
  await locator.click({ timeout: 10_000, force: true }).catch(() => {});
  await page.waitForTimeout(1000);
  if (isLiveDashboardUrl(page.url())) return;

  const rect = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }).catch(() => candidate.rect);
  if (!rect) {
    await locator.click({ timeout: 15_000, force: true });
    return;
  }
  const y = rect.y + rect.height / 2;
  await page.mouse.click(rect.x + Math.min(48, rect.width / 2), y).catch(() => {});
  await page.waitForTimeout(600);
  if (isLiveDashboardUrl(page.url())) return;
  await page.mouse.click(rect.x + Math.max(rect.width - 24, rect.width / 2), y).catch(() => {});
}

async function collectLivePage(page, timestamp, config, outputDir, labelOverride = "") {
  const originalUrl = page.url();
  await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  if (!isLiveDashboardUrl(page.url()) && isLiveDashboardUrl(originalUrl)) {
    await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  }
  if (!isLiveDashboardUrl(page.url())) {
    throw new Error(`Expected LIVE dashboard, got ${page.url()}`);
  }
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await acceptVisibleDialogs(page);
  await hoverMetricsPanel(page, config);
  await ensureTapThroughMetricsVisible(page);

  const extracted = await page.evaluate(extractLiveDashboardMetrics, {
    selectors: config.liveAnalytics.selectors
  });
  const metrics = extracted.metrics || {};
  const record = {
    timestamp,
    room: labelOverride || extracted.roomName,
    currentViewers: metrics.currentViewers || "",
    tapThroughRateViaLivePreview: metrics.tapThroughRateViaLivePreview || "",
    tapThroughRate: metrics.tapThroughRate || "",
    liveCtr: metrics.liveCtr || "",
    orderRateSkuOrders: metrics.orderRateSkuOrders || "",
    adsCost: metrics.adsCost || "",
    gmvMaxRoi: metrics.gmvMaxRoi || "",
    url: extracted.url
  };

  const missing = Object.entries(record).filter(([key, value]) => !["timestamp", "url"].includes(key) && !value);
  if (missing.length > 0) {
    const safeStamp = `${timestamp}-${slug(record.room || "live")}`.replace(/[:.]/g, "-");
    await fs.writeFile(path.join(outputDir, `live-debug-${safeStamp}.txt`), extracted.bodyText || "", "utf8");
    await page.screenshot({ path: path.join(outputDir, `live-debug-${safeStamp}.png`), fullPage: true }).catch(() => {});
    console.warn(`[${PREFIX}] Missing ${missing.map(([key]) => key).join(", ")} for ${record.room}. Debug files saved.`);
  }
  return record;
}

async function hoverMetricsPanel(page, config) {
  const selector = config.liveAnalytics.selectors.metricHover;
  if (selector) {
    await page.locator(selector).first().hover({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    return;
  }

  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(Math.floor(viewport.width * 0.52), Math.floor(viewport.height * 0.28)).catch(() => {});
  await page.waitForTimeout(1200);

  for (const label of ["Attributed GMV", "Current viewers", "GMV Max ROI", "Ads Cost"]) {
    const locator = page.getByText(label, { exact: false }).first();
    if (await locator.count().catch(() => 0)) {
      await locator.hover({ timeout: 5000, force: true }).catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }

  await page.mouse.move(Math.floor(viewport.width * 0.52), Math.floor(viewport.height * 0.44)).catch(() => {});
  await page.waitForTimeout(800);
}

async function ensureTapThroughMetricsVisible(page) {
  const hasTapThrough = await page.evaluate(() => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const keyMetricCard = Array.from(document.querySelectorAll("div"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) =>
        item.text.includes("Attributed GMV") &&
        item.text.includes("Current viewers") &&
        item.rect.width > 500 &&
        item.rect.height > 220
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    return /Tap-through rate/i.test(keyMetricCard?.text || "");
  }).catch(() => false);
  if (hasTapThrough) return;

  const editPoint = await page.evaluate(() => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const keyMetricCard = Array.from(document.querySelectorAll("div"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) =>
        item.text.includes("Attributed GMV") &&
        item.text.includes("Current viewers") &&
        item.rect.width > 500 &&
        item.rect.height > 220
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    if (!keyMetricCard) return null;

    const cardRect = keyMetricCard.rect;
    const editIcon = Array.from(keyMetricCard.node.querySelectorAll("svg, [class*='edit'], [class*='Edit']"))
      .map((node) => ({ node, rect: node.getBoundingClientRect(), className: String(node.className?.baseVal || node.className || "") }))
      .filter((item) => /edit/i.test(item.className) && item.rect.width >= 8 && item.rect.height >= 8)
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left)[0];
    if (editIcon) {
      const button = editIcon.node.closest("button, [role='button']");
      const rect = (button || editIcon.node).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }

    const buttons = Array.from(keyMetricCard.node.querySelectorAll("button, [role='button']"))
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: textOf(node) }))
      .filter((item) => item.rect.width >= 8 && item.rect.height >= 8)
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left);
    const target = buttons[0]?.rect;
    if (target) {
      return { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    }
    return { x: cardRect.right - 40, y: cardRect.top + 40 };
  }).catch(() => false);

  if (!editPoint) return;
  await page.mouse.click(editPoint.x, editPoint.y).catch(() => {});
  await page.waitForTimeout(1200);

  const editorOpened = await page.evaluate(() => /Select metrics \(up to 16\)|Custom metrics/i.test(document.body?.innerText || "")).catch(() => false);
  if (!editorOpened) {
    console.warn(`[${PREFIX}] Custom metrics editor did not open; Tap-through metrics remain hidden.`);
    return;
  }

  const requiredLabels = ["Tap-through rate (via LIVE preview)", "Tap-through rate"];
  const optionalLabels = [
    "New followers",
    "Comments",
    "Customers",
    "Product clicks",
    "Est. GMV",
    "Payment Rate",
    "GMV with subsidies",
    "AOV",
  ];

  const getSelectedMetricState = async () => page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const countMatch = bodyText.match(/(\d+)\s+metrics selected/i);
    const selectedText = bodyText.split(/\d+\s+metrics selected/i)[1]?.split(/\bCancel\b|\bApply\b|取消|应用|确定|确认/i)[0] || "";
    const selectedMetrics = selectedText
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return {
      count: countMatch ? Number(countMatch[1]) : 0,
      selectedText,
      selectedMetrics,
    };
  }).catch(() => ({ count: 0, selectedText: "", selectedMetrics: [] }));

  const isSelected = async (label) => {
    const state = await getSelectedMetricState();
    return state.selectedMetrics.some((metric) => metric === label);
  };

  const metricClickPoint = async (label, mode) => page.evaluate(({ label, mode }) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const isVisible = (rect) => rect.width > 2 && rect.height > 2 && rect.bottom > 0 && rect.right > 0;
    const modal = Array.from(document.querySelectorAll("div"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) =>
        item.text.includes("Custom metrics") &&
        item.text.includes("Select metrics") &&
        item.rect.width > 800 &&
        item.rect.height > 500 &&
        isVisible(item.rect)
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    if (!modal) return null;

    const modalRect = modal.rect;
    const selectedBoundary = modalRect.left + modalRect.width * 0.72;
    const matchesLabel = (text) => {
      if (text === label || text.startsWith(label)) return true;
      return label.includes("via LIVE") && text.includes("Tap-through rate") && text.includes("LIVE") && text.includes("preview");
    };

    const candidates = Array.from(modal.node.querySelectorAll("*"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) => matchesLabel(item.text) && isVisible(item.rect));

    const candidate = candidates
      .filter((item) => mode === "remove" ? item.rect.left > selectedBoundary : item.rect.left < selectedBoundary)
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    if (!candidate) return null;

    let row = candidate.node;
    for (let i = 0; i < 6 && row?.parentElement; i += 1) {
      const rect = row.getBoundingClientRect();
      const text = textOf(row);
      if (
        matchesLabel(text) &&
        rect.width > 120 &&
        rect.height >= 24 &&
        rect.height <= 90 &&
        isVisible(rect)
      ) {
        const x = mode === "remove" ? rect.right - 18 : rect.left + 12;
        return { x, y: rect.top + rect.height / 2 };
      }
      row = row.parentElement;
    }

    const rect = candidate.rect;
    const x = mode === "remove" ? rect.right + 24 : rect.left - 18;
    return { x, y: rect.top + rect.height / 2 };
  }, { label, mode }).catch(() => null);

  const clickMetric = async (label, mode) => {
    const point = await metricClickPoint(label, mode);
    if (!point) return false;
    await page.mouse.click(point.x, point.y).catch(() => {});
    await page.waitForTimeout(350);
    return true;
  };

  let changed = false;
  const initialState = await getSelectedMetricState();
  console.log(`[${PREFIX}] Custom metrics selected count before Tap-through sync: ${initialState.count}.`);
  for (const label of optionalLabels) {
    const missingRequiredCount = (await Promise.all(requiredLabels.map(async (required) => !(await isSelected(required))))).filter(Boolean).length;
    const state = await getSelectedMetricState();
    if (missingRequiredCount === 0 || state.count <= 16 - missingRequiredCount) break;
    if (await isSelected(label)) {
      const removed = await clickMetric(label, "remove");
      console.log(`[${PREFIX}] ${removed ? "Removed" : "Could not remove"} optional metric: ${label}`);
      changed = removed || changed;
    }
  }

  for (const label of requiredLabels) {
    if (!(await isSelected(label))) {
      const selected = await clickMetric(label, "select");
      console.log(`[${PREFIX}] ${selected ? "Selected" : "Could not select"} required metric: ${label}`);
      changed = selected || changed;
    }
  }

  const finalState = await getSelectedMetricState();
  const hasRequired = requiredLabels.every((label) =>
    finalState.selectedMetrics.some((metric) => metric === label)
  );
  if (!hasRequired) {
    console.warn(`[${PREFIX}] Tap-through metrics were not selected. Current selected metrics: ${finalState.selectedText.replace(/\s+/g, " ").trim()}`);
    const cancel = page.getByText(/Cancel|取消/).last();
    if (await cancel.count().catch(() => 0)) await cancel.click({ timeout: 2000, force: true }).catch(() => {});
    return;
  }

  const apply = page.getByText(/Apply|应用|确定|确认/).last();
  if (await apply.count().catch(() => 0)) {
    await apply.click({ timeout: 3000, force: true }).catch(() => {});
    changed = true;
  }

  if (changed) {
    await page.waitForTimeout(1800);
    await hoverMetricsPanel(page, { liveAnalytics: { selectors: {} } }).catch(() => {});
  }
}

async function acceptVisibleDialogs(page) {
  const buttons = ["Accept all", "Accept", "同意", "接受", "我知道了", "Got it", "Dismiss", "Skip", "Not now", "Later"];
  await page.evaluate((names) => {
    const elements = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const element of elements) {
      const text = (element.innerText || element.textContent || "").trim();
      if (names.some((name) => text.includes(name))) element.click();
    }
  }, buttons).catch(() => {});
  await dismissBlockingOverlays(page);
}

async function dismissBlockingOverlays(page) {
  await page.evaluate(() => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const overlays = Array.from(document.querySelectorAll("[class*='popover'], [class*='tour'], [class*='tooltip'], [role='dialog']"));
    for (const overlay of overlays) {
      const text = textOf(overlay);
      if (!/low stock|tour|guide|notification|products with low stock/i.test(text)) continue;
      const close = Array.from(overlay.querySelectorAll("button, [role='button'], svg, [class*='close']"))
        .find((node) => /close|dismiss|skip|got it|我知道|关闭/i.test(textOf(node)) || node.tagName.toLowerCase() === "svg");
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      if (overlay.isConnected) overlay.style.pointerEvents = "none";
    }
  }).catch(() => {});
}

async function appendJsonl(filePath, value) {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function appendLiveCsv(filePath, records) {
  const exists = await fileExists(filePath);
  if (!exists) {
    await fs.appendFile(filePath, [
      "timestamp",
      "room",
      "current_viewers",
      "tap_through_rate_via_live_preview",
      "tap_through_rate",
      "live_ctr",
      "order_rate_sku_orders",
      "ads_cost",
      "gmv_max_roi",
      "url"
    ].join(",") + "\n", "utf8");
  }

  for (const record of records) {
    const row = [
      record.timestamp,
      record.room,
      record.currentViewers,
      record.tapThroughRateViaLivePreview,
      record.tapThroughRate,
      record.liveCtr,
      record.orderRateSkuOrders,
      record.adsCost,
      record.gmvMaxRoi,
      record.url
    ].map(csvCell);
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

function slug(value) {
  return String(value || "").replace(/[^a-z0-9@._-]+/gi, "-").slice(0, 80);
}

async function safeTitle(page) {
  try { return await page.title(); } catch { return ""; }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
