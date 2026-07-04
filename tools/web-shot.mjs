// tools/web-shot.mjs — браузерный диагностический харнесс KLAS.
//
// Зачем: дать агенту «глаза и руки» в вебе — открыть страницу настоящим браузером, снять
// скриншот, СОБРАТЬ ошибки консоли и УПАВШИЕ сетевые запросы (главная криминалистика для багов
// UI, которые не видны в curl: пустая панель, красный статус, не грузятся ассеты/API).
// Это же — первый кирпич будущего «зрения» Jarvis (идея 05): наблюдение экрана программно.
//
// Использование:
//   node tools/web-shot.mjs <url> [out.png] [--width=1600] [--height=1000] [--full]
//   node tools/web-shot.mjs <url> --script=<file.mjs>   — сценарий кликов (см. клиентские хелперы)
//
// Требует: playwright (dev-зависимость), скачанный chromium (ms-playwright cache — уже есть).

import { chromium } from "playwright";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const out =
  args.filter((a) => !a.startsWith("--"))[1] ||
  resolve(process.env.TEMP || ".", "web-shot.png");
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const width = parseInt(opt("width", "1600"), 10);
const height = parseInt(opt("height", "1000"), 10);

if (!url) {
  console.error("Укажи URL: node tools/web-shot.mjs <url> [out.png]");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width, height } });

// --cookie=name=value[@domain] — задать cookie до загрузки (воспроизвести состояние браузера
// пользователя, напр. свёрнутую панель shadcn: --cookie=sidebar_state=false).
for (const a of args.filter((x) => x.startsWith("--cookie="))) {
  const spec = a.slice("--cookie=".length);
  const [nv, domain = "localhost"] = spec.split("@");
  const [name, value] = nv.split("=");
  await ctx.addCookies([{ name, value, domain, path: "/" }]);
}

const page = await ctx.newPage();

// ── Криминалистика: собираем всё, что обычно ломает SPA ──────────────────────
const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));
page.on("requestfailed", (r) =>
  failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`)
);
page.on("response", (r) => {
  if (r.status() >= 400)
    failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});

try {
  // domcontentloaded, а не networkidle: у SPA бывает вечный SSE/WebSocket (напр. /api/events
  // у llama-swap) — networkidle тогда никогда не наступает и ждём таймаут впустую.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
} catch (e) {
  console.error("goto:", e.message);
}
await page.waitForTimeout(2000); // дать SPA смонтироваться + отработать useEffect'ам

await page.screenshot({ path: out, fullPage: flag("full") });

// ── Отчёт для агента ─────────────────────────────────────────────────────────
console.log("URL:", url);
console.log("Скриншот:", out, `(${width}x${height}${flag("full") ? ", full" : ""})`);
console.log("Заголовок:", await page.title());
console.log(
  "Видимого текста (первые 300):",
  (await page.evaluate(() => document.body?.innerText || ""))
    .replace(/\s+/g, " ")
    .slice(0, 300)
);
console.log("\n=== Ошибки консоли (" + consoleErrors.length + ") ===");
consoleErrors.slice(0, 30).forEach((e) => console.log(" •", e));
console.log("\n=== Упавшие/4xx-5xx запросы (" + failedRequests.length + ") ===");
failedRequests.slice(0, 40).forEach((e) => console.log(" •", e));

await browser.close();
