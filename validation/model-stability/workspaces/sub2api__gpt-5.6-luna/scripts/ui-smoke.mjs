import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.APP_URL || "http://127.0.0.1:4178";
const root = path.resolve(import.meta.dirname, "..");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#metrics .metric").first().waitFor();
  assert.equal(await page.locator("#metrics .metric").count(), 6);
  assert.equal(await page.locator("#stockTable tr").count(), 8);
  assert.ok(await page.locator("#trendScore").textContent());
  const canvasPixels = await page.locator("#trendChart").evaluate((canvas) => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) visible += 1;
    return visible;
  });
  assert.ok(canvasPixels > 1000, `Canvas only rendered ${canvasPixels} visible pixels`);

  await page.getByRole("button", { name: "60 日" }).click();
  await page.locator("#categoryFilter").selectOption({ label: "光模块" });
  assert.equal(await page.locator("#stockTable tr").count(), 2);
  await page.locator("#trendChart").hover({ position: { x: 320, y: 140 } });
  await page.locator("#tooltip:not([hidden])").waitFor();
  await page.getByRole("button", { name: "查看指标说明" }).click();
  await page.locator("#guideDialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#guideDialog").waitFor({ state: "hidden" });

  await page.locator("#csvInput").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("date,code\n2026-01-01,1", "utf8"),
  });
  await page.locator("#status.error").waitFor();
  assert.match(await page.locator("#status").textContent(), /缺少必填列/);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出演示数据/ }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "compute-sector-demo.csv");
  await page.screenshot({ path: path.join(root, "desktop-result.png"), fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await mobile.locator("#metrics .metric").first().waitFor();
  const mobileLayout = await mobile.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    chartWidth: document.querySelector("#trendChart").getBoundingClientRect().width,
    tableViewportWidth: document.querySelector(".table-wrap").getBoundingClientRect().width,
  }));
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 1, JSON.stringify(mobileLayout));
  assert.ok(mobileLayout.chartWidth > 300);
  await mobile.screenshot({ path: path.join(root, "mobile-result.png"), fullPage: true });
  assert.deepEqual(errors, []);

  console.log(JSON.stringify({ ok: true, canvasPixels, mobileLayout, screenshots: ["desktop-result.png", "mobile-result.png"] }, null, 2));
} finally {
  await browser.close();
}
