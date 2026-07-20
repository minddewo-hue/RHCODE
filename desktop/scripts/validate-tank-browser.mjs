import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const url = process.argv[2] || "http://127.0.0.1:8080";
const outputDir = path.resolve(process.argv[3] || "validation/tank-battle");
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!fs.existsSync(chrome)) throw new Error(`Chrome is unavailable: ${chrome}`);

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-proxy-server", "--proxy-bypass-list=*"],
});
const results = [];
try {
  results.push(await verifyViewport("desktop", { width: 1440, height: 900 }));
  results.push(await verifyViewport("mobile", { width: 390, height: 844 }));
  process.stdout.write(`${JSON.stringify({ ok: true, url, results }, null, 2)}\n`);
} finally {
  await browser.close();
}

async function verifyViewport(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      errors.push(`${message.text()}${location.url ? ` (${location.url})` : ""}`);
    }
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("#game").waitFor();

  const initialCanvas = await canvasMetrics(page);
  if (initialCanvas.uniqueColors < 8 || initialCanvas.nonTransparentRatio < 0.99) {
    throw new Error(`${name}: canvas appears blank or incomplete.`);
  }
  const layout = await page.evaluate(() => {
    const canvas = document.querySelector("#game").getBoundingClientRect();
    const actions = document.querySelector(".actions").getBoundingClientRect();
    const touch = document.querySelector(".touch").getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      canvas: { width: canvas.width, height: canvas.height, bottom: canvas.bottom },
      actions: { top: actions.top, bottom: actions.bottom },
      touch: { display: getComputedStyle(document.querySelector(".touch")).display, bottom: touch.bottom },
    };
  });
  if (layout.scrollWidth > layout.viewportWidth + 1) throw new Error(`${name}: horizontal overflow detected.`);
  if (layout.actions.top < layout.canvas.bottom - 1) throw new Error(`${name}: action controls overlap the canvas.`);
  if (name === "mobile" && (layout.touch.display === "none" || layout.touch.bottom > viewport.height + 1)) {
    throw new Error("mobile: touch controls are not visible in the first viewport.");
  }

  await page.getByRole("button", { name: "开始战斗" }).click();
  await page.locator("#overlay").evaluate((element) => {
    if (!element.classList.contains("hidden")) throw new Error("Start overlay did not close.");
  });
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(220);
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.press("Space");
  await page.waitForTimeout(3_400);
  const activeCanvas = await canvasMetrics(page);
  if (activeCanvas.hash === initialCanvas.hash) throw new Error(`${name}: game canvas did not update after input.`);

  await page.keyboard.press("p");
  await page.getByText("已暂停", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续战斗" }).click();
  await page.locator("#overlay.hidden").waitFor({ state: "attached" });

  if (name === "mobile") {
    await page.locator('[data-key="right"]').click();
    await page.locator('[data-key="fire"]').click();
  }
  await page.getByRole("button", { name: /音效：开/ }).click();
  await page.getByRole("button", { name: /音效：关/ }).waitFor();
  await page.getByRole("button", { name: "重新开始" }).click();
  await page.getByRole("button", { name: "开始战斗" }).waitFor();

  const screenshotPath = path.join(outputDir, `qa-${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.close();
  if (errors.length > 0) throw new Error(`${name}: browser errors: ${errors.join(" | ")}`);
  return { name, viewport, initialCanvas, activeCanvas, layout, screenshotPath };
}

async function canvasMetrics(page) {
  return page.locator("#game").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    let opaque = 0;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0) opaque += 1;
      if (index % 64 === 0) {
        colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]},${pixels[index + 3]}`);
        hash ^= pixels[index] | (pixels[index + 1] << 8) | (pixels[index + 2] << 16);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      uniqueColors: colors.size,
      nonTransparentRatio: opaque / (pixels.length / 4),
      hash,
    };
  });
}
