import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.GMVMAX_DASHBOARD_PORT || 8787);
const host = process.env.GMVMAX_DASHBOARD_HOST || "127.0.0.1";
const execFileAsync = promisify(execFile);
const cdpEndpoint = process.env.GMVMAX_CDP_ENDPOINT || "http://127.0.0.1:9222";
const chromeProfile = process.env.GMVMAX_CHROME_PROFILE || path.join(process.env.HOME || rootDir, ".gmvmax-chrome-mac");
const sellerUrl = process.env.LIVE_ANALYTICS_URL || "https://seller-my.tiktok.com/compass/data-overview?shop_region=MY";
let ensurePromise = null;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".png", "image/png"]
]);

function safePath(urlPath) {
  const pathname = decodeURIComponent(urlPath === "/" ? "/dashboard.html" : urlPath);
  const resolved = path.resolve(rootDir, `.${pathname}`);
  if (!resolved.startsWith(rootDir)) return null;
  return resolved;
}

async function processRunning(pattern) {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command"]).catch(() => ({ stdout: "" }));
  return stdout.split("\n").some((line) => line.includes(pattern) && !line.includes("grep"));
}

async function cdpOpen() {
  try {
    const response = await fetch(`${cdpEndpoint.replace(/\/$/, "")}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp() {
  for (let i = 0; i < 30; i += 1) {
    if (await cdpOpen()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function latestGmvmaxUrl() {
  try {
    const config = JSON.parse(await fs.readFile(path.join(rootDir, "config.json"), "utf8"));
    if (config.url?.includes("ads.tiktok.com") && config.url.includes("gmv-max/dashboard")) return config.url;
  } catch {}

  try {
    const csv = await fs.readFile(path.join(rootDir, "logs", "gmvmax-plan-records.csv"), "utf8");
    const rows = csv.trim().split(/\r?\n/).reverse();
    for (const row of rows) {
      const match = row.match(/https:\/\/ads\.tiktok\.com\/[^"]*gmv-max\/dashboard[^"]*/);
      if (match) return match[0];
    }
  } catch {}

  return "https://ads.tiktok.com/i18n/gmv-max/dashboard?activated_tab_id=2&type=live&live_campaign_page=1&live_campaign_page_size=10";
}

async function openCdpUrl(targetUrl) {
  if (!targetUrl || !(await cdpOpen())) return;
  const base = cdpEndpoint.replace(/\/$/, "");
  try {
    const pages = await (await fetch(`${base}/json/list`)).json();
    if (pages.some((page) => page.url?.split("#")[0] === targetUrl.split("#")[0])) return;
  } catch {}
  await fetch(`${base}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" }).catch(() => {});
}

function spawnLogged(command, args, outFile, env = {}) {
  fsSync.mkdirSync(path.join(rootDir, "logs"), { recursive: true });
  const out = fsSync.openSync(path.join(rootDir, "logs", outFile), "a");
  const err = fsSync.openSync(path.join(rootDir, "logs", outFile.replace(".out.", ".err.")), "a");
  const child = spawn(command, args, {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, ...env }
  });
  child.unref();
}

async function ensureCollectors() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const gmvmaxUrl = process.env.GMVMAX_URL || await latestGmvmaxUrl();

    if (!(await cdpOpen())) {
      fsSync.mkdirSync(chromeProfile, { recursive: true });
      spawn("open", [
        "-na",
        "Google Chrome",
        "--args",
        "--remote-debugging-port=9222",
        `--user-data-dir=${chromeProfile}`,
        "--no-first-run",
        "--no-default-browser-check",
        sellerUrl
      ], { detached: true, stdio: "ignore" }).unref();
      await waitForCdp();
    }

    await openCdpUrl(sellerUrl);
    await openCdpUrl(gmvmaxUrl);

    if (!(await processRunning("node src/monitor.js"))) {
      spawnLogged("npm", ["start"], "monitor.out.log", { GMVMAX_URL: gmvmaxUrl });
    }
    if (!(await processRunning("node src/live-monitor.js"))) {
      spawnLogged("npm", ["run", "live"], "live-monitor.out.log");
    }
  })().finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname === "/" || url.pathname === "/dashboard.html") {
      ensureCollectors().catch((error) => console.error(`ensureCollectors failed: ${error.message}`));
    }
    const filePath = safePath(url.pathname);
    if (!filePath) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    const body = await fs.readFile(filePath);
    const type = contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store"
    });
    response.end(body);
  } catch (error) {
    const status = error.code === "ENOENT" ? 404 : 500;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "Not found" : error.message);
  }
});

server.listen(port, host, () => {
  console.log(`GMV Max dashboard server running at http://${host}:${port}/dashboard.html`);
});
