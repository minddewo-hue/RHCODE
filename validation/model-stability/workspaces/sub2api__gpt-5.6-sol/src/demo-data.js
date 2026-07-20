const STOCKS = [
  ["000977", "浪潮信息", "服务器", 34, 0.0014, 0.4, 18500000],
  ["603019", "中科曙光", "服务器", 42, 0.0011, 1.2, 16200000],
  ["300308", "中际旭创", "光模块", 118, 0.0018, 2.1, 13900000],
  ["300502", "新易盛", "光模块", 76, 0.0016, 2.8, 12100000],
  ["300499", "高澜股份", "液冷", 17, 0.0008, 3.2, 9400000],
  ["300442", "润泽科技", "IDC", 31, 0.0009, 4.0, 8200000],
  ["600602", "云赛智联", "算力租赁", 15, 0.0007, 4.8, 11200000],
  ["000938", "紫光股份", "网络设备", 25, 0.0010, 5.4, 14600000],
];

export const DEMO_NOTICE = "内置数据为确定性演示数据，不代表真实或实时行情。";

export function generateDemoData(dayCount = 160) {
  const dates = businessDates("2025-09-01", dayCount);
  const rows = [];
  for (const [code, name, category, base, drift, phase, baseVolume] of STOCKS) {
    let previous = base;
    dates.forEach((date, index) => {
      const cycle = Math.sin(index / 9 + phase) * 0.028 + Math.sin(index / 23 + phase * 0.7) * 0.04;
      const shock = index > 104 && index < 114 ? -0.018 * (1 - Math.abs(109 - index) / 6) : 0;
      const close = base * Math.exp(drift * index + cycle + shock);
      const change = index === 0 ? 0 : ((close - previous) / previous) * 100;
      const volume = Math.round(baseVolume * (1 + 0.22 * Math.sin(index / 6 + phase) + Math.abs(change) * 0.035));
      rows.push({
        date,
        code,
        name,
        category,
        close: Number(close.toFixed(2)),
        change_pct: Number(change.toFixed(3)),
        volume,
        amount: Number((volume * close).toFixed(2)),
      });
      previous = close;
    });
  }
  return rows;
}

function businessDates(start, count) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  while (dates.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
