import { analyzeSector, parseCSV, sortStocks, toCSV } from "/src/analysis.js";
import { DEMO_NOTICE, generateDemoData } from "/src/demo-data.js";

const state = {
  rows: generateDemoData(),
  source: "演示数据 · 非实时行情",
  window: localStorage.getItem("compute.window") || "120",
  category: localStorage.getItem("compute.category") || "all",
  sort: localStorage.getItem("compute.sort") || "momentum20",
  movingAverages: new Set(JSON.parse(localStorage.getItem("compute.ma") || "[5,20]")),
  analysis: null,
};

const elements = {
  canvas: document.querySelector("#trendChart"),
  tooltip: document.querySelector("#tooltip"),
  metrics: document.querySelector("#metrics"),
  sourceLabel: document.querySelector("#sourceLabel"),
  status: document.querySelector("#status"),
  category: document.querySelector("#categoryFilter"),
  sort: document.querySelector("#sortField"),
  stockTable: document.querySelector("#stockTable"),
  stockCount: document.querySelector("#stockCount"),
  latestDate: document.querySelector("#latestDate"),
  trendLabel: document.querySelector("#trendLabel"),
  trendScore: document.querySelector("#trendScore"),
  scoreFill: document.querySelector("#scoreFill"),
  contributions: document.querySelector("#contributions"),
  risks: document.querySelector("#risks"),
  legend: document.querySelector("#chartLegend"),
  csvInput: document.querySelector("#csvInput"),
  dialog: document.querySelector("#guideDialog"),
};

initialize();

function initialize() {
  document.querySelectorAll("[data-window]").forEach((button) => {
    button.classList.toggle("active", button.dataset.window === state.window);
    button.addEventListener("click", () => {
      state.window = button.dataset.window;
      localStorage.setItem("compute.window", state.window);
      document.querySelectorAll("[data-window]").forEach((entry) => entry.classList.toggle("active", entry === button));
      render();
    });
  });
  document.querySelectorAll("[data-ma]").forEach((checkbox) => {
    checkbox.checked = state.movingAverages.has(Number(checkbox.dataset.ma));
    checkbox.addEventListener("change", () => {
      const period = Number(checkbox.dataset.ma);
      checkbox.checked ? state.movingAverages.add(period) : state.movingAverages.delete(period);
      localStorage.setItem("compute.ma", JSON.stringify([...state.movingAverages]));
      drawChart();
    });
  });
  elements.category.addEventListener("change", () => {
    state.category = elements.category.value;
    localStorage.setItem("compute.category", state.category);
    renderTable();
  });
  elements.sort.addEventListener("change", () => {
    state.sort = elements.sort.value;
    localStorage.setItem("compute.sort", state.sort);
    renderTable();
  });
  document.querySelector("#importButton").addEventListener("click", () => elements.csvInput.click());
  elements.csvInput.addEventListener("change", importCSV);
  document.querySelector("#exportButton").addEventListener("click", exportDemo);
  document.querySelector("#restoreButton").addEventListener("click", restoreDemo);
  document.querySelector("#guideButton").addEventListener("click", () => elements.dialog.showModal());
  document.querySelector("#closeGuide").addEventListener("click", () => elements.dialog.close());
  elements.dialog.addEventListener("click", (event) => {
    const bounds = elements.dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) elements.dialog.close();
  });
  window.addEventListener("resize", drawChart);
  elements.canvas.addEventListener("mousemove", showTooltip);
  elements.canvas.addEventListener("mouseleave", () => { elements.tooltip.hidden = true; });
  render();
  showStatus(DEMO_NOTICE, false, 5000);
}

function render() {
  try {
    state.analysis = analyzeSector(state.rows);
    elements.sourceLabel.textContent = state.source;
    populateCategories();
    renderMetrics();
    renderTrend();
    renderTable();
    drawChart();
  } catch (error) {
    showStatus(error.message, true);
  }
}

function renderMetrics() {
  const stats = state.analysis.stats;
  const items = [
    ["板块指数", formatNumber(state.analysis.latest.value), stats.latestDate, classFor(stats.periodChange)],
    ["区间涨跌", formatPercent(stats.periodChange), `${state.analysis.index.length} 个交易日`, classFor(stats.periodChange)],
    ["20 日动量", formatPercent(stats.momentum20), "趋势速度", classFor(stats.momentum20)],
    ["20 日最大回撤", formatPercent(stats.drawdown20), "峰值至谷值", classFor(stats.drawdown20)],
    ["年化波动率", formatPercent(stats.volatility20), "基于近 20 日", stats.volatility20 > 35 ? "negative" : ""],
    ["市场宽度", formatPercent(stats.breadth * 100), "上涨家数占比", classFor(stats.breadth - 0.5)],
  ];
  elements.metrics.innerHTML = items.map(([label, value, note, tone]) => `<div class="metric"><span>${label}</span><strong class="${tone}">${value}</strong><small>${note}</small></div>`).join("");
}

function renderTrend() {
  const { trend, risks, stats } = state.analysis;
  const tone = trend.label === "偏强" ? "positive" : trend.label === "偏弱" ? "negative" : "";
  elements.trendLabel.textContent = trend.label;
  elements.trendLabel.className = tone;
  elements.trendScore.textContent = trend.score;
  elements.scoreFill.style.width = `${trend.score}%`;
  elements.contributions.innerHTML = trend.contributions.map((item) => `<div class="contribution"><span>${item.label}</span><b class="${classFor(item.points)}">${item.points > 0 ? "+" : ""}${item.points}</b></div>`).join("");
  elements.risks.innerHTML = risks.length
    ? risks.map((risk) => `<div class="risk">${risk}</div>`).join("")
    : '<div class="risk clear">当前规则未触发显著风险信号</div>';
  elements.latestDate.textContent = `更新至 ${stats.latestDate}`;
}

function renderTable() {
  const filtered = state.analysis.stocks.filter((stock) => state.category === "all" || stock.category === state.category);
  const stocks = sortStocks(filtered, state.sort, "desc");
  elements.stockCount.textContent = `${stocks.length} 只成分股`;
  elements.stockTable.innerHTML = stocks.map((stock) => `<tr>
    <td><strong>${escapeHTML(stock.name)}</strong><small>${stock.code}</small></td><td>${escapeHTML(stock.category)}</td>
    <td>${formatNumber(stock.close)}</td><td class="${classFor(stock.momentum20)}">${formatPercent(stock.momentum20)}</td>
    <td class="${classFor(stock.relativeStrength)}">${formatPercent(stock.relativeStrength)}</td><td>${formatPercent(stock.volatility20)}</td><td>${formatAmount(stock.amount)}</td>
  </tr>`).join("");
}

function populateCategories() {
  const previous = state.category;
  elements.category.innerHTML = '<option value="all">全部方向</option>' + state.analysis.categories.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("");
  state.category = state.analysis.categories.includes(previous) ? previous : "all";
  elements.category.value = state.category;
  elements.sort.value = state.sort;
}

function chartData() {
  const count = state.window === "all" ? state.analysis.index.length : Number(state.window);
  return state.analysis.index.slice(-count);
}

function drawChart() {
  if (!state.analysis) return;
  const data = chartData();
  const canvas = elements.canvas;
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  const width = bounds.width;
  const height = bounds.height;
  const padding = { top: 18, right: 16, bottom: 30, left: 50 };
  const series = [{ key: "value", label: "板块指数", color: "#263b31", width: 2 }];
  const colors = { 5: "#d24d42", 20: "#3477a8", 60: "#94733d" };
  for (const period of [...state.movingAverages].sort((a, b) => a - b)) series.push({ key: `ma${period}`, label: `MA${period}`, color: colors[period], width: 1.25 });
  const numericValues = data.flatMap((item) => series.map((entry) => item[entry.key])).filter(Number.isFinite);
  const minimum = Math.min(...numericValues);
  const maximum = Math.max(...numericValues);
  const range = maximum - minimum || 1;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const pointX = (index) => padding.left + (index / Math.max(1, data.length - 1)) * plotWidth;
  const pointY = (value) => padding.top + ((maximum - value) / range) * plotHeight;
  context.clearRect(0, 0, width, height);
  context.font = '11px "Microsoft YaHei", sans-serif';
  context.textAlign = "right";
  context.fillStyle = "#7b857e";
  context.strokeStyle = "#e5e8e5";
  for (let line = 0; line <= 4; line += 1) {
    const value = maximum - (range * line / 4);
    const y = padding.top + (plotHeight * line / 4);
    context.beginPath(); context.moveTo(padding.left, y); context.lineTo(width - padding.right, y); context.stroke();
    context.fillText(value.toFixed(0), padding.left - 8, y + 4);
  }
  context.textAlign = "center";
  [0, Math.floor((data.length - 1) / 2), data.length - 1].forEach((index) => context.fillText(data[index]?.date.slice(5) || "", pointX(index), height - 8));
  for (const entry of series) {
    context.beginPath(); context.strokeStyle = entry.color; context.lineWidth = entry.width; let started = false;
    data.forEach((item, index) => {
      if (!Number.isFinite(item[entry.key])) return;
      const x = pointX(index); const y = pointY(item[entry.key]);
      started ? context.lineTo(x, y) : context.moveTo(x, y); started = true;
    });
    context.stroke();
  }
  canvas._chart = { data, pointX, pointY, padding, plotWidth };
  elements.legend.innerHTML = series.map((entry) => `<span><i style="background:${entry.color}"></i>${entry.label}</span>`).join("");
}

function showTooltip(event) {
  const chart = elements.canvas._chart;
  if (!chart) return;
  const bounds = elements.canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const index = Math.round(((x - chart.padding.left) / chart.plotWidth) * (chart.data.length - 1));
  const item = chart.data[Math.max(0, Math.min(chart.data.length - 1, index))];
  if (!item) return;
  elements.tooltip.innerHTML = `<strong>${item.date}</strong><br>指数 ${formatNumber(item.value)}<br>20 日动量 ${formatPercent(item.momentum20 || 0)}<br>宽度 ${formatPercent(item.breadth * 100)}`;
  elements.tooltip.hidden = false;
  elements.tooltip.style.left = `${Math.min(bounds.width - 145, Math.max(4, x + 12))}px`;
  elements.tooltip.style.top = `${Math.max(4, event.clientY - bounds.top - 70)}px`;
}

async function importCSV() {
  const file = elements.csvInput.files?.[0];
  if (!file) return;
  try {
    const parsed = parseCSV(await file.text());
    analyzeSector(parsed);
    state.rows = parsed;
    state.source = `本地 CSV · ${file.name}`;
    state.category = "all";
    render();
    showStatus(`已导入 ${parsed.length} 条记录。`);
  } catch (error) { showStatus(error.message, true); }
  finally { elements.csvInput.value = ""; }
}

function restoreDemo() { state.rows = generateDemoData(); state.source = "演示数据 · 非实时行情"; state.category = "all"; render(); showStatus("已恢复演示数据。"); }
function exportDemo() {
  const blob = new Blob([`\uFEFF${toCSV(generateDemoData())}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "compute-sector-demo.csv"; link.click(); URL.revokeObjectURL(link.href);
  showStatus("演示 CSV 已导出。");
}
function showStatus(message, error = false, timeout = 4000) {
  elements.status.textContent = message; elements.status.className = `status visible${error ? " error" : ""}`;
  window.clearTimeout(showStatus.timer); if (timeout) showStatus.timer = window.setTimeout(() => { elements.status.className = "status"; }, timeout);
}
function classFor(value) { return value > 0 ? "positive" : value < 0 ? "negative" : ""; }
function formatPercent(value) { return `${value > 0 ? "+" : ""}${Number(value).toFixed(2)}%`; }
function formatNumber(value) { return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function formatAmount(value) { return value >= 1e8 ? `${(value / 1e8).toFixed(2)} 亿` : `${(value / 1e4).toFixed(0)} 万`; }
function escapeHTML(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
