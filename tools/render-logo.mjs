// tools/render-logo.mjs — растеризация логотипа KLAS (Кот Криник) из logo/klas-cat.svg во все
// используемые размеры/имена. Правишь SVG — прогоняешь этот скрипт, и котик обновляется ВЕЗДЕ
// (favicon 16/32, apple-touch 180, android-chrome 192/512, homepage.ico). Зависимостей нет:
// SVG→PNG через headless Chrome, сборка .ico — вручную (ICO с PNG-полезной нагрузкой, Vista+).
//
// Использование:  node tools/render-logo.mjs

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.cwd());
const SVG = resolve(ROOT, "logo/klas-cat.svg");

function findChrome() {
  const c = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  for (const p of c) if (existsSync(p)) return p;
  throw new Error("Не найден Chrome/Edge — укажи путь в переменной CHROME.");
}
const CHROME = findChrome();
const svg = readFileSync(SVG, "utf-8");

// SVG → PNG размера N через headless Chrome (прозрачный фон вне скруглённого тайла).
function png(n, outPath) {
  const html = `<!doctype html><meta charset=utf-8><style>
    html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${n}px;height:${n}px}</style>${svg}`;
  const tmp = resolve(ROOT, `logo/.render-${n}.html`);
  writeFileSync(tmp, html, "utf-8");
  try {
    execFileSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        `--screenshot=${outPath}`,
        `--window-size=${n},${n}`,
        pathToFileURL(tmp).href,
      ],
      { stdio: "ignore" }
    );
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  console.log(`PNG ${n}x${n} -> ${outPath.replace(ROOT + "\\", "").replace(ROOT + "/", "")}`);
}

// Сборка .ico из готовых PNG-буферов (ICO может содержать PNG как есть, размеры 16/32/48).
function buildIco(pngPaths, outIco) {
  const imgs = pngPaths.map((p) => ({ size: p.size, data: readFileSync(p.path) }));
  const count = imgs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  imgs.forEach((img, i) => {
    const b = i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, b + 0); // width (0 = 256)
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, b + 1); // height
    dir.writeUInt8(0, b + 2); // palette
    dir.writeUInt8(0, b + 3); // reserved
    dir.writeUInt16LE(1, b + 4); // color planes
    dir.writeUInt16LE(32, b + 6); // bpp
    dir.writeUInt32LE(img.data.length, b + 8); // size of data
    dir.writeUInt32LE(offset, b + 12); // offset
    offset += img.data.length;
  });
  writeFileSync(outIco, Buffer.concat([header, dir, ...imgs.map((i) => i.data)]));
  console.log(`ICO -> ${outIco.replace(ROOT + "\\", "").replace(ROOT + "/", "")} (${count} размера)`);
}

// ── Все имена/размеры, как прописан котик в проекте (docker-compose монтирует их в homepage) ──
const L = (f) => resolve(ROOT, "logo", f);
png(16, L("favicon-16x16.png"));
png(32, L("favicon-32x32.png"));
png(180, L("apple-touch-icon.png"));
png(192, L("android-chrome-192x192.png"));
png(512, L("android-chrome-512x512.png"));

// homepage.ico — контейнерные размеры 16/32/48
const ico48 = L(".ico-48.png");
png(48, ico48);
buildIco(
  [
    { size: 16, path: L("favicon-16x16.png") },
    { size: 32, path: L("favicon-32x32.png") },
    { size: 48, path: ico48 },
  ],
  L("homepage.ico")
);
unlinkSync(ico48);
console.log("Готово. Котик проброшен во все имена.");
