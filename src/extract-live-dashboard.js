export function extractLiveDashboardMetrics(config = {}) {
  const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const bodyText = textOf(document.body);
  const selectors = config.selectors || {};

  function firstText(selector) {
    if (!selector) return null;
    const node = document.querySelector(selector);
    return node ? textOf(node) : null;
  }

  function valueFromSelector(key) {
    return firstText(selectors[key]);
  }

  function valueAfterLabel(labelOptions, valuePattern = "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M|%)?") {
    const labels = Array.isArray(labelOptions) ? labelOptions : [labelOptions];
    for (const label of labels) {
      const escaped = escapeRegExp(label).replace(/\s+/g, "\\s+");
      const pattern = new RegExp(`${escaped}\\s*[:：]?\\s*(${valuePattern})`, "i");
      const match = bodyText.match(pattern);
      if (match?.[1]) return match[1].trim();
    }

    const all = Array.from(document.querySelectorAll("body *"));
    for (const node of all) {
      const ownText = textOf(node);
      if (!ownText || ownText.length > 180) continue;
      if (!labels.some((label) => ownText.toLowerCase().includes(label.toLowerCase()))) continue;

      const local = ownText.match(new RegExp(`(${valuePattern})`, "i"));
      if (local?.[1] && !labels.some((label) => local[1].toLowerCase().includes(label.toLowerCase()))) {
        return local[1].trim();
      }

      const parent = node.parentElement;
      const siblings = parent ? Array.from(parent.children) : [];
      const index = siblings.indexOf(node);
      const candidates = siblings.slice(index + 1, index + 5).concat(parent ? Array.from(parent.querySelectorAll("*")).slice(0, 12) : []);
      for (const candidate of candidates) {
        const candidateText = textOf(candidate);
        if (!candidateText || candidateText.length > 80) continue;
        const match = candidateText.match(new RegExp(`^\\s*(${valuePattern})\\s*$`, "i")) || candidateText.match(new RegExp(`(${valuePattern})`, "i"));
        if (match?.[1]) return match[1].trim();
      }
    }
    return null;
  }

  function titleFromPage() {
    const selectorTitle = firstText(selectors.roomName);
    if (selectorTitle) return selectorTitle;
    const handle = bodyText.match(/@[A-Za-z0-9._-]+/)?.[0];
    if (handle) return handle;
    const title = document.title.replace(/\s*[-|]\s*TikTok.*$/i, "").trim();
    return title || location.href;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractPlainTapThroughRate(text) {
    const matches = Array.from(text.matchAll(/Tap-through rate\s+([-+]?\d[\d,.]*(?:\.\d+)?\s*%)/gi));
    if (matches.length === 0) return null;
    const plain = matches.find((match) => {
      const start = Math.max(0, match.index - 32);
      const before = text.slice(start, match.index).toLowerCase();
      return !before.includes("via live preview") && !before.includes("via liv");
    });
    return (plain || matches.at(-1))?.[1]?.trim() || null;
  }

  function valueBetweenLabels(label, nextLabel, valuePattern = "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M|%)?") {
    const labelPattern = escapeRegExp(label).replace(/\s+/g, "\\s+");
    const nextPattern = escapeRegExp(nextLabel).replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`${labelPattern}\\s+(${valuePattern})\\s+${nextPattern}`, "i");
    return bodyText.match(pattern)?.[1]?.trim() || null;
  }

  function normalizeSplitDigits(value) {
    const compact = String(value || "").trim().replace(/\s+/g, "");
    return /^[-+]?\d[\d,.]*(?:\.\d+)?(?:K|M)?$/i.test(compact) ? compact : String(value || "").trim();
  }

  function parseMetricNumber(value) {
    const normalized = normalizeSplitDigits(value).replace(/,/g, "");
    const match = normalized.match(/^([-+]?\d+(?:\.\d+)?)(K|M)?$/i);
    if (!match) return null;
    const multiplier = match[2]?.toUpperCase() === "M" ? 1_000_000 : match[2]?.toUpperCase() === "K" ? 1_000 : 1;
    return Number(match[1]) * multiplier;
  }

  function attributedGmvValue() {
    const cleaned = bodyText.replace(/GMV\s*MAX\s*active/gi, "");
    const match = cleaned.match(/Attributed GMV \(RM\)\s+([\d\s,.]+(?:K|M)?)\s+Attributed items sold/i);
    return match?.[1] ? normalizeSplitDigits(match[1]) : null;
  }

  function calculatedRoi(attributedGmv, adsCost) {
    const gmv = parseMetricNumber(attributedGmv);
    const cost = parseMetricNumber(adsCost);
    if (!gmv || !cost) return null;
    return (gmv / cost).toFixed(2).replace(/\.00$/, "");
  }

  const currentViewers =
    valueFromSelector("currentViewers") ||
    valueBetweenLabels("Current viewers", "Impressions", "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M)?") ||
    valueAfterLabel(["Current viewers", "Current viewer", "实时在线人数", "当前观看人数"], "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M)?");

  const tapThroughRateViaLivePreview =
    valueFromSelector("tapThroughRateViaLivePreview") ||
    valueBetweenLabels("Tap-through rate (via LIVE preview)", "Tap-through rate") ||
    valueAfterLabel(["Tap-through rate (via LIVE preview)", "Tap-through rate (via LIV", "via LIVE preview", "LIVE preview"]);

  const tapThroughRate =
    valueFromSelector("tapThroughRate") ||
    valueBetweenLabels("Tap-through rate", "LIVE CTR") ||
    extractPlainTapThroughRate(bodyText) ||
    valueAfterLabel(["Tap-through rate", "商品点击率"]);

  const adsCost =
    valueFromSelector("adsCost") ||
    valueBetweenLabels("Ads Cost", "GMV Max ROI", "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M|MYR|RM)?") ||
    valueAfterLabel(["Ads Cost", "Ad Cost", "广告消耗"], "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M|MYR|RM)?");

  const attributedGmv = attributedGmvValue();

  return {
    url: location.href,
    title: document.title,
    roomName: titleFromPage(),
    metrics: {
      currentViewers,
      tapThroughRateViaLivePreview,
      tapThroughRate,
      liveCtr: valueFromSelector("liveCtr") || valueBetweenLabels("LIVE CTR", "Ads Cost") || valueAfterLabel(["LIVE CTR", "Live CTR"]),
      orderRateSkuOrders: valueFromSelector("orderRateSkuOrders") || valueBetweenLabels("Order rate (SKU orders)", "GMV per hour") || valueAfterLabel(["Order rate (SKU orders)", "Order rate", "SKU orders"]),
      adsCost,
      gmvMaxRoi: valueFromSelector("gmvMaxRoi") || valueBetweenLabels("GMV Max ROI", "Order rate (SKU orders)", "[-+]?\\d[\\d,.]*(?:\\.\\d+)?") || valueAfterLabel(["GMV Max ROI", "GMV MAX ROI", "ROI"], "[-+]?\\d[\\d,.]*(?:\\.\\d+)?") || calculatedRoi(attributedGmv, adsCost)
    },
    bodyText
  };
}
