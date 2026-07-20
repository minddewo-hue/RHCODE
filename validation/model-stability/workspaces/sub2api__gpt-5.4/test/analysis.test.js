import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSector, detectRisks, maxDrawdown, momentum, parseCSV, rsi, scoreTrend, sma, sortStocks, toCSV } from "../src/analysis.js";
import { generateDemoData } from "../src/demo-data.js";

const header = "date,code,name,close,change_pct,volume,amount,category";
const row = "2026-01-02,000001,测试股份,10.5,1.2,1000,10500,服务器";

test("parses valid CSV and round-trips quoted fields", () => {
  const parsed = parseCSV(`${header}\n2026-01-02,000001,\"测试,股份\",10.5,1.2,1000,10500,服务器`);
  assert.equal(parsed[0].name, "测试,股份");
  assert.deepEqual(parseCSV(toCSV(parsed)), parsed);
});

test("reports strict CSV errors", () => {
  assert.throws(() => parseCSV(""), /为空/);
  assert.throws(() => parseCSV("date,code\n2026-01-01,1"), /缺少必填列/);
  assert.throws(() => parseCSV(`${header}\n2026-02-30,1,A,10,0,1,10,x`), /日期无效/);
  assert.throws(() => parseCSV(`${header}\n2026-01-02,1,A,no,0,1,10,x`), /不是有效数字/);
  assert.throws(() => parseCSV(`${header}\n${row}\n${row}`), /重复记录/);
  assert.throws(() => parseCSV(`${header},extra\n${row},x`), /未知列/);
});

test("computes indicator boundaries", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.equal(momentum([10, 11, 12], 2)[2], 20);
  assert.equal(rsi([1, 2, 3, 4, 5], 3)[3], 100);
  assert.equal(maxDrawdown([100, 110, 88, 99]), -20);
});

test("generates deterministic complete demo data", () => {
  const first = generateDemoData();
  const second = generateDemoData();
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((item) => item.code)).size, 8);
  assert.ok(new Set(first.map((item) => item.date)).size >= 130);
  assert.ok(new Set(first.map((item) => item.category)).size >= 5);
});

test("analyzes sector and produces reproducible trend rules", () => {
  const analysis = analyzeSector(generateDemoData());
  assert.equal(analysis.index[0].value, 1000);
  assert.ok(analysis.index.length >= 130);
  assert.ok(["偏强", "震荡", "偏弱"].includes(analysis.trend.label));
  assert.ok(analysis.trend.score >= 0 && analysis.trend.score <= 100);
  assert.equal(analysis.trend.contributions.length, 6);
  assert.equal(analysis.stocks.length, 8);
  assert.ok(Number.isFinite(analysis.stats.volatility20));
});

test("classifies strong and weak rule sets", () => {
  const strong = scoreTrend({ latest: { value: 120, ma5: 118, ma20: 110, momentum20: 12, rsi14: 62, breadth: .8 }, volumeRatio: 1.3 });
  const weak = scoreTrend({ latest: { value: 80, ma5: 82, ma20: 90, momentum20: -12, rsi14: 32, breadth: .2 }, volumeRatio: .6 });
  assert.equal(strong.label, "偏强");
  assert.equal(weak.label, "偏弱");
  assert.ok(strong.score > weak.score);
});

test("detects all four transparent risk signals", () => {
  const index = Array.from({ length: 25 }, (_, itemIndex) => ({
    momentum20: itemIndex === 24 ? 8 : null,
    breadth: itemIndex === 19 ? 0.7 : itemIndex === 24 ? 0.2 : 0.5,
  }));
  const risks = detectRisks(index, { volumeRatio: 0.7, drawdown: -9, volatility: 40 });
  assert.deepEqual(risks, [
    "趋势与量能背离",
    "板块上涨但市场宽度下降",
    "20 日回撤超过 8%",
    "年化波动率异常偏高",
  ]);
});

test("sorts and filters stock summaries", () => {
  const stocks = analyzeSector(generateDemoData()).stocks;
  const sorted = sortStocks(stocks, "momentum20");
  assert.ok(sorted[0].momentum20 >= sorted.at(-1).momentum20);
  assert.ok(stocks.filter((stock) => stock.category === "光模块").length >= 2);
});

test("requires enough data for analysis", () => {
  assert.throws(() => analyzeSector(parseCSV(`${header}\n${row}`)), /至少需要 21/);
});
