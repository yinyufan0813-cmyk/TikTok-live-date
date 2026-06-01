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

  function directValueAfterLabel(labelOptions, nextLabelOptions = [], valuePattern = "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M|%)?") {
    const labels = Array.isArray(labelOptions) ? labelOptions : [labelOptions];
    const nextLabels = Array.isArray(nextLabelOptions) ? nextLabelOptions : [nextLabelOptions];
    const nextPattern = nextLabels.filter(Boolean).map((label) => escapeRegExp(label).replace(/\s+/g, "\\s+")).join("|");

    for (const label of labels) {
      const escaped = escapeRegExp(label).replace(/\s+/g, "\\s+");
      const bounded = nextPattern
        ? new RegExp(`${escaped}\\s*[:：]?\\s*(${valuePattern})(?=\\s+(?:${nextPattern})|\\s*$)`, "i")
        : new RegExp(`${escaped}\\s*[:：]?\\s*(${valuePattern})`, "i");
      const match = bodyText.match(bounded);
      if (match?.[1]) return match[1].trim();
    }

    const all = Array.from(document.querySelectorAll("body *"));
    for (const node of all) {
      const ownText = textOf(node);
      if (!ownText || ownText.length > 120) continue;
      const matchedLabel = labels.find((label) => ownText.toLowerCase() === label.toLowerCase() || ownText.toLowerCase().startsWith(`${label.toLowerCase()} `));
      if (!matchedLabel) continue;
      if (matchedLabel.toLowerCase() === "tap-through rate" && /\(via\s+live/i.test(ownText)) continue;

      const localText = ownText.slice(matchedLabel.length).trim();
      const localMatch = localText.match(new RegExp(`^\\s*(${valuePattern})\\s*$`, "i"));
      if (localMatch?.[1]) return localMatch[1].trim();

      const parent = node.parentElement;
      const siblings = parent ? Array.from(parent.children) : [];
      const index = siblings.indexOf(node);
      const candidates = [
        node.nextElementSibling,
        ...siblings.slice(index + 1, index + 4),
        ...(parent ? Array.from(parent.querySelectorAll("*")).slice(0, 16) : [])
      ].filter(Boolean);

      for (const candidate of candidates) {
        if (candidate === node) continue;
        const candidateText = textOf(candidate);
        if (!candidateText || candidateText.length > 40 || labels.some((label) => candidateText.toLowerCase().includes(label.toLowerCase()))) continue;
        const match = candidateText.match(new RegExp(`^\\s*(${valuePattern})\\s*$`, "i"));
        if (match?.[1]) return match[1].trim();
      }
    }
    return null;
  }

  const currentViewers =
    valueFromSelector("currentViewers") ||
    valueBetweenLabels("Current viewers", "Impressions", "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M)?") ||
    valueAfterLabel(["Current viewers", "Current viewer", "实时在线人数", "当前观看人数"], "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M)?");

  const tapThroughRateViaLivePreview =
    valueFromSelector("tapThroughRateViaLivePreview") ||
    directValueAfterLabel(["Tap-through rate (via LIVE preview)", "Tap-through rate (via LIVE pre...", "Tap-through rate (via LIV"], ["Tap-through rate", "LIVE CTR"], "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*%");

  const tapThroughRate =
    valueFromSelector("tapThroughRate") ||
    directValueAfterLabel(["Tap-through rate", "商品点击率"], ["LIVE CTR", "Order rate", "Ads Cost"], "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*%") ||
    extractPlainTapThroughRate(bodyText);

  const adsCost =
    valueFromSelector("adsCost") ||
    valueBetweenLabels("Ads Cost", "GMV Max ROI", "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M|MYR|RM)?") ||
    valueAfterLabel(["Ads Cost", "Ad Cost", "广告消耗"], "[-+]?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:K|M|MYR|RM)?");

  const gmvMaxRoi =
    valueFromSelector("gmvMaxRoi") ||
    directValueAfterLabel(["GMV Max ROI", "GMV MAX ROI"], ["GMV per hour", "Avg. viewing duration per view", "Comment rate", "Follow rate", "Like rate", "> 1 min. views"], "[-+]?\\d[\\d,.]*(?:\\.\\d+)?");

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
      gmvMaxRoi
    },
    bodyText
  };
}
