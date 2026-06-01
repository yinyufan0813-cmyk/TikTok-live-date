export function extractGmvMaxRecord({ labels, selectors }) {
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
      totalOrderAmount: firstText(selectors.totalOrderAmount, row),
      totalBudget: firstText(selectors.totalBudget, row)
    }));
  }

  function extractTableRows() {
    const rowNodes = Array.from(document.querySelectorAll("tr, [role='row']"));
    return rowNodes
      .map((row) => textOf(row))
      .filter((rowText) => rowText.includes("LIVE GMV Max_") && rowText.includes(" ID:") && rowText.includes("MYR"))
      .map((rowText, index) => {
        const values = Array.from(rowText.matchAll(/([\d,]+(?:\.\d+)?)\s+MYR/g)).map((item) => parseNumber(item[1]));
        if (values.length < 6) return null;

        const activeMatch = rowText.match(/\s(?:Active|已生效)\s/);
        const name = activeMatch?.index > 0 ? rowText.slice(0, activeMatch.index).trim() : `live-plan-${index + 1}`;
        const account = rowText.match(/\d+\s+(?:recommendations?|条建议)\s+(.*?)\s+ID:/i)?.[1]?.trim() || null;

        return {
          index: index + 1,
          account,
          name,
          totalSpend: moneyText(values[2]),
          totalBudget: moneyText(values[3]),
          netSpend: moneyText(values[4]),
          totalOrderAmount: moneyText(values[5])
        };
      })
      .filter(Boolean);
  }

  function parseNumber(value) {
    if (!value) return null;
    const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function moneyText(value) {
    return value == null ? null : `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MYR`;
  }

  function englishOverviewMetrics(bodyText) {
    const cost = bodyText.match(/\bCost\s+([\d,]+(?:\.\d+)?)\s+MYR\s+vs last/i);
    const grossRevenue = bodyText.match(/\bGross revenue \(Current shop\)\s+([\d,]+(?:\.\d+)?)\s+MYR\s+vs last/i);
    const chineseCost = bodyText.match(/(?:概览[\s\S]*?)?成本\s+([\d,]+(?:\.\d+)?)\s+MYR\s+较近/);
    const chineseGrossRevenue = bodyText.match(/总收入（当前店铺）\s+([\d,]+(?:\.\d+)?)\s+MYR\s+较近/);
    return {
      totalSpend: cost?.[1] ? `${cost[1]} MYR` : chineseCost?.[1] ? `${chineseCost[1]} MYR` : null,
      totalOrderAmount: grossRevenue?.[1] ? `${grossRevenue[1]} MYR` : chineseGrossRevenue?.[1] ? `${chineseGrossRevenue[1]} MYR` : null
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
      const planName = rowText.match(/^(.*?)\s+(?:Active|已生效)\s+/)?.[1] || `live-plan-${rows.length + 1}`;
      const account = rowText.match(/(?:recommendations?|条建议)\s+(.*?)\s+ID:/i)?.[1]?.trim() || rowText.match(/Available TikTok accounts\s+(.*?)\s+ID:/i)?.[1]?.trim() || null;
      rows.push({
        index: rows.length + 1,
        account,
        name: planName,
        netSpend: moneyText(values[grossRevenueIndex - 1]),
        totalSpend: moneyText(values[2]),
        totalBudget: moneyText(values[3]),
        totalOrderAmount: moneyText(values[grossRevenueIndex])
      });
    }
    return rows;
  }

  const bodyText = textOf(document.body).slice(0, 30000);
  const labelMetrics = Object.fromEntries(Object.entries(labels).map(([key, labelOptions]) => [key, valueAfterLabel(labelOptions)]));
  const englishMetrics = englishOverviewMetrics(bodyText);
  const plans = extractBySelectors();
  const tablePlans = extractTableRows();
  const englishPlans = englishLivePlans(bodyText);
  const parsedPlans = plans.length > 0 ? plans : tablePlans.length > 0 ? tablePlans : englishPlans;

  return {
    url: location.href,
    title: document.title,
    metrics: {
      newSpend: labelMetrics.newSpend || null,
      newOrderAmount: labelMetrics.newOrderAmount || null,
      totalSpend: labelMetrics.totalSpend || englishMetrics.totalSpend,
      totalOrderAmount: labelMetrics.totalOrderAmount || englishMetrics.totalOrderAmount,
      totalBudget: labelMetrics.totalBudget || parsedPlans.find((plan) => plan.totalBudget)?.totalBudget || null
    },
    plans: parsedPlans,
    pageState: {
      hasSystemError: /System error|No campaigns found/i.test(bodyText),
      planCount: parsedPlans.length
    },
    bodyText
  };
}
