// tools/render-pdf.mjs — рендер Markdown → PDF (KLAS).
//
// Зачем: держать PDF-копии README (в репозитории) и документа ключей `LINKS.local.md` (вне git,
// чтобы удобно скинуть родным). Markdown → HTML (marked) → PDF через headless Chrome (без тяжёлых
// зависимостей: Chrome уже есть в системе, marked — единственный npm-пакет, dev-зависимость).
//
// Использование:
//   node tools/render-pdf.mjs <input.md> [output.pdf]     — один файл
//   node tools/render-pdf.mjs --all                       — README.md + LINKS.local.md (канон KLAS)
//
// Требует: Node 18+, установленный Chrome (или переменная CHROME с путём к chrome.exe), `npm i`.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";

// ── Поиск Chrome: переменная CHROME или стандартные пути Windows ──────────────
function findChrome() {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("Не найден Chrome/Edge. Укажи путь в переменной окружения CHROME.");
}

// ── Оболочка HTML с аккуратным печатным стилем (читаемо, таблицы, код) ────────
function htmlShell(title, body, baseHref) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<base href="${baseHref}">
<title>${title}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.55 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; max-width: 100%; }
  h1,h2,h3,h4 { line-height: 1.25; margin: 1.1em 0 0.5em; page-break-after: avoid; }
  h1 { font-size: 21pt; border-bottom: 2px solid #ddd; padding-bottom: .2em; }
  h2 { font-size: 16pt; border-bottom: 1px solid #eee; padding-bottom: .15em; }
  h3 { font-size: 13pt; }
  code { background: #f3f3f3; padding: .1em .35em; border-radius: 4px; font-family: "Consolas", monospace; font-size: .9em; }
  pre { background: #f6f8fa; padding: .8em 1em; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  a { color: #0b5cad; text-decoration: none; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; margin: .8em 0; font-size: .95em; }
  th, td { border: 1px solid #ccc; padding: .45em .6em; text-align: left; vertical-align: top; }
  th { background: #f2f4f7; }
  blockquote { margin: .8em 0; padding: .4em 1em; border-left: 4px solid #cbd5e1; background: #f8fafc; color: #334155; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.4em 0; }
</style></head><body>${body}</body></html>`;
}

function render(inputMd, outputPdf) {
  const inAbs = resolve(inputMd);
  if (!existsSync(inAbs)) throw new Error(`Нет файла: ${inputMd}`);
  const out = resolve(outputPdf || inAbs.replace(/\.md$/i, ".pdf"));
  let md = readFileSync(inAbs, "utf-8");
  // Убираем цветные эмодзи ДЛЯ PDF (не трогая сам .md): headless Chrome кодирует их как Type3-шрифты
  // с паттернами, на которых спотыкаются старые PDF.js-вьюверы (напр. расширение VS Code, PDF.js 2.10:
  // "Requesting object that isn't resolved yet pattern_… / showType3Text"). Без эмодзи Type3 не возникает.
  md = md
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "") // региональные индикаторы (флаги)
    .replace(/[️‍]/g, "") // variation selector-16 и ZWJ
    .replace(/[ \t]{2,}/g, " ");
  // <base> = папка исходника → относительные картинки (логотип и т.п.) резолвятся
  const baseHref = pathToFileURL(dirname(inAbs) + "/").href;
  const html = htmlShell(basename(inAbs), marked.parse(md), baseHref);
  const tmpHtml = out.replace(/\.pdf$/i, ".tmp.html");
  writeFileSync(tmpHtml, html, "utf-8");
  try {
    execFileSync(
      findChrome(),
      [
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        `--print-to-pdf=${out}`,
        pathToFileURL(tmpHtml).href,
      ],
      { stdio: "ignore" }
    );
  } finally {
    if (existsSync(tmpHtml)) unlinkSync(tmpHtml);
  }
  console.log(`OK  ${inputMd}  ->  ${out}`);
}

// ── Точка входа ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args[0] === "--all" || args.length === 0) {
  // Канон KLAS: README (в репозиторий) + документ ключей (вне git).
  render("README.md", "README.pdf");
  if (existsSync("LINKS.local.md")) render("LINKS.local.md", "LINKS.local.pdf");
  else console.log("LINKS.local.md не найден — пропускаю документ ключей.");
} else {
  render(args[0], args[1]);
}
