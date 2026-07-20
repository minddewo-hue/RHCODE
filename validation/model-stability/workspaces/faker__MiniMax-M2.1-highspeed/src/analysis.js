const REQUIRED_COLUMNS = ["date", "code", "name", "close", "change_pct", "volume", "amount"];
const OPTIONAL_COLUMNS = ["category"];

export function parseCSV(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("CSV 文件为空。");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("CSV 没有数据记录。");
  const headers = parseCSVLine(lines[0]).map((value) => value.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) throw new Error(`CSV 缺少必填列：${missing.join(", ")}。`);
  const unknown = headers.filter((column) => !REQUIRED_COLUMNS.includes(column) && !OPTIONAL_COLUMNS.includes(column));
  if (unknown.length) throw new Error(`CSV 包含未知列：${unknown.join(", ")}。`);

  const seen = new Set();
  return lines.slice(1).map((line, index) => {
    const values = parseCSVLine(line);
    const lineNumber = index + 2;
    if (values.length !== headers.length) throw new Error(`CSV 第 ${lineNumber} 行列数不正确。`);
    const raw = Object.fromEntries(headers.map((header, valueIndex) => [header, values[valueIndex].trim()]));
    if (!isValidDate(raw.date)) throw new Error(`CSV 第 ${lineNumber} 行日期无效：${raw.date || "空值"}。`);
    for (const field of ["close", "change_pct", "volume", "amount"]) {
      if (raw[field] === "" || !Number.isFinite(Number(raw[field]))) {
        throw new Error(`CSV 第 ${lineNumber} 行 ${field} 不是有效数字。`);
      }
    }
    if (!raw.code || !raw.name) throw new Error(`CSV 第 ${lineNumber} 行股票代码或名称为空。`);
    if (Number(raw.close) <= 0 || Number(raw.volume) < 0 || Number(raw.amount) < 0) {
      throw new Error(`CSV 第 ${lineNumber} 行价格、成交量或成交额范围无效。`);
    }
    const key = `${raw.date}|${raw.code}`;
    if (seen.has(key)) throw new Error(`CSV 存在重复记录：${raw.date} ${raw.code}。`);
    seen.add(key);
    return {
      date: raw.date,
      code: raw.code,
      name: raw.name,
      category: raw.category || "未分类",
      close: Number(raw.close),
      change_pct: Number(raw.change_pct),
      volume: Number(raw.volume),
      amount: Number(raw.amount),
    };
  });
}

export function toCSV(rows) {
  const headers = [...REQUIRED_COLUMNS, "category"];
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n");
}

export function analyzeSector(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("没有可分析的数据。");
  const stockGroups = groupBy(rows, (row) => row.code);
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  if (dates.length < 21) throw new Error("至少需要 21 个交易日的数据。");

  const normalizedByCode = new Map();
  for (const [code, stockRows] of stockGroups) {
    const sorted = [...stockRows].sort(byDate);
    const base = sorted[0].close;
    normalizedByCode.set(code, new Map(sorted.map((row) => [row.date, (row.close / base) * 1000])));
  }

  const index = dates.map((date) => {
    const dayRows = rows.filter((row) => row.date === date);
    const normalized = dayRows.map((row) => normalizedByCode.get(row.code)?.get(date)).filter(Number.isFinite);
    return {
      date,
      value: average(normalized),
      volume: dayRows.reduce((sum, row) => sum + row.volume, 0),
      amount: dayRows.reduce((sum, row) => sum + row.amount, 0),
      breadth: dayRows.filter((row) => row.change_pct > 0).length / dayRows.length,
    };
  });

  const values = index.map((item) => item.value);
  const volumes = index.map((item) => item.volume);
  for (const period of [5, 10, 20, 60]) {
    const ma = sma(values, period);
    index.forEach((item, itemIndex) => { item[`ma${period}`] = ma[itemIndex]; });
  }
  const momentum5 = momentum(values, 5);
  const momentum20 = momentum(values, 20);
  const rsi14 = rsi(values, 14);
  index.forEach((item, itemIndex) => {
    item.momentum5 = momentum5[itemIndex];
    item.momentum20 = momentum20[itemIndex];
    item.rsi14 = rsi14[itemIndex];
  });

  const latest = index.at(-1);
  const start = index[0];
  const latest20 = index.slice(-20);
  const returns20 = dailyReturns(latest20.map((item) => item.value));
  const volumeRatio = average(volumes.slice(-5)) / average(volumes.slice(-20));
  const volatility = standardDeviation(returns20) * Math.sqrt(252) * 100;
  const drawdown = maxDrawdown(latest20.map((item) => item.value));
  const trend = scoreTrend({ latest, volumeRatio });
  const risks = detectRisks(index, { volumeRatio, volatility, drawdown });
  const sectorMomentum20 = latest.momentum20 || 0;
  const stocks = summarizeStocks(stockGroups, sectorMomentum20);

  return {
    index,
    latest,
    trend,
    risks,
    stocks,
    categories: [...new Set(rows.map((row) => row.category || "未分类"))].sort(),
    stats: {
      latestDate: latest.date,
      periodChange: percentageChange(start.value, latest.value),
      momentum20: sectorMomentum20,
      drawdown20: drawdown,
      volatility20: volatility,
      volumeRatio,
      breadth: latest.breadth,
      advanceRatio: latest.breadth,
    },
  };
}

export function sma(values, period) {
  return values.map((_, index) => index < period - 1
    ? null
    : average(values.slice(index - period + 1, index + 1)));
}

export function momentum(values, period) {
  return values.map((value, index) => index < period ? null : percentageChange(values[index - period], value));
}

export function rsi(values, period = 14) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  output[period] = averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(delta, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-delta, 0)) / period;
    output[index] = averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  }
  return output;
}

export function maxDrawdown(values) {
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, ((value - peak) / peak) * 100);
  }
  return worst;
}

export function scoreTrend({ latest, volumeRatio }) {
  const contributions = [
    contribution("价格相对 MA20", latest.value > latest.ma20 ? 15 : -15),
    contribution("短中期均线", latest.ma5 > latest.ma20 ? 10 : -10),
    contribution("20 日动量", latest.momentum20 > 0 ? 12 : -12),
    contribution("RSI 强弱", latest.rsi14 >= 55 && latest.rsi14 <= 75 ? 8 : latest.rsi14 < 40 ? -8 : 0),
    contribution("量能确认", volumeRatio > 1.1 && latest.momentum20 > 0 ? 8 : volumeRatio < 0.8 ? -6 : 0),
    contribution("市场宽度", latest.breadth >= 0.625 ? 10 : latest.breadth <= 0.375 ? -10 : 0),
  ];
  const score = clamp(50 + contributions.reduce((sum, item) => sum + item.points, 0), 0, 100);
  return { score, label: score >= 65 ? "偏强" : score <= 39 ? "偏弱" : "震荡", contributions };
}

export function detectRisks(index, metrics) {
  const latest = index.at(-1);
  const risks = [];
  if ((latest.momentum20 || 0) > 5 && metrics.volumeRatio < 0.8) risks.push("趋势与量能背离");
  const priorBreadth = index.at(-6)?.breadth;
  if ((latest.momentum20 || 0) > 0 && Number.isFinite(priorBreadth) && latest.breadth < priorBreadth - 0.15) {
    risks.push("板块上涨但市场宽度下降");
  }
  if (metrics.drawdown < -8) risks.push("20 日回撤超过 8%");
  if (metrics.volatility > 35) risks.push("年化波动率异常偏高");
  return risks;
}

export function sortStocks(stocks, field = "momentum20", direction = "desc") {
  const sign = direction === "asc" ? 1 : -1;
  return [...stocks].sort((left, right) => ((left[field] || 0) - (right[field] || 0)) * sign);
}

function summarizeStocks(groups, sectorMomentum20) {
  return [...groups.entries()].map(([code, rows]) => {
    const sorted = [...rows].sort(byDate);
    const closes = sorted.map((row) => row.close);
    const returns = dailyReturns(closes.slice(-21));
    const momentum20 = closes.length > 20 ? percentageChange(closes.at(-21), closes.at(-1)) : 0;
    return {
      code,
      name: sorted[0].name,
      category: sorted[0].category || "未分类",
      close: closes.at(-1),
      momentum20,
      volatility20: standardDeviation(returns) * Math.sqrt(252) * 100,
      amount: sorted.at(-1).amount,
      relativeStrength: momentum20 - sectorMomentum20,
    };
  });
}

function parseCSVLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { cells.push(value); value = ""; }
    else value += character;
  }
  if (quoted) throw new Error("CSV 引号没有闭合。");
  cells.push(value);
  return cells;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function contribution(label, points) { return { label, points }; }
function byDate(left, right) { return left.date.localeCompare(right.date); }
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percentageChange(start, end) { return start ? ((end - start) / start) * 100 : 0; }
function dailyReturns(values) { return values.slice(1).map((value, index) => (value - values[index]) / values[index]); }
function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}
function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const groupKey = key(value);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(value);
  }
  return groups;
}
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
