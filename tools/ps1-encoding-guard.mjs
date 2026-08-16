#!/usr/bin/env node
// tools/ps1-encoding-guard.mjs — охранник кодировки PowerShell-скриптов.
//
// ЗАЧЕМ. Правило «.ps1 с кириллицей — только UTF-8 с BOM» жило в AGENT_GUIDE прозой и было нарушено
// сессией, которая его ЗНАЛА (2026-08-16, скрипт установки прав: владелец увидел мозаику вместо
// текста, а скрипт развалился на середине — сломанный символ порвал кавычки и убил парсер).
// По правилу самого канона повторившийся урок обязан стать МЕХАНИЗМОМ, а не ещё одним абзацем.
// Симптом — 9.6 в AGENT_GUIDE. Урок — EXP-0066.
//
// ЧТО ПРОВЕРЯЕТ. Каждый .ps1 в проекте:
//   чисто ASCII                 -> ✅ (предпочтительно: работает в любой кодировке консоли)
//   не-ASCII + UTF-8 BOM        -> ✅ (PowerShell 5.1 прочитает верно)
//   не-ASCII БЕЗ BOM            -> ⛔ ДЕФЕКТ: PS 5.1 прочитает как ANSI и испортит и вывод, и код
//
// Запуск: node tools/ps1-encoding-guard.mjs [--fix] [путь ...]
//   без путей — обход всего проекта (ворота);
//   с путями — проверка конкретных файлов, В ТОМ ЧИСЛЕ ВНЕ РЕПОЗИТОРИЯ. Это не украшение:
//   дефект 2026-08-16 случился именно в одноразовом скрипте в scratchpad, куда ворота не смотрят,
//   поэтому агент обязан уметь проверить файл СРАЗУ ПОСЛЕ того, как его написал.
//   --fix дописывает BOM тем файлам, которым он нужен (содержимое не трогает).
// Код возврата 1 при найденных дефектах — годится как ворота.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.argv.includes('--fix');
const SKIP = new Set(['node_modules', '.git', 'LLMs', 'voice', 'llamacpp', '.deploy-cache', 'reports']);

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) collect(p, out);
    else if (name.toLowerCase().endsWith('.ps1')) out.push(p);
  }
  return out;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = explicit.length ? explicit : collect(ROOT);
const bad = [];
let okAscii = 0, okBom = 0, fixed = 0;

for (const f of files) {
  const buf = readFileSync(f);
  const hasBom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM);
  const body = hasBom ? buf.subarray(3) : buf;
  // Не-ASCII = любой байт >= 0x80. Проверяем БАЙТЫ, а не декодированную строку:
  // именно байты и читает PowerShell, когда решает, какая это кодировка.
  const nonAscii = body.some((b) => b >= 0x80);

  if (!nonAscii) { okAscii++; continue; }
  if (hasBom) { okBom++; continue; }

  if (FIX) {
    writeFileSync(f, Buffer.concat([BOM, buf]));
    fixed++;
  } else {
    // Покажем первую строку с не-ASCII — чтобы человек сразу увидел, о чём речь.
    const lines = body.toString('utf8').split(/\r?\n/);
    const idx = lines.findIndex((l) => /[^\x00-\x7F]/.test(l));
    bad.push({ file: relative(ROOT, f), line: idx + 1, text: (lines[idx] || '').trim().slice(0, 90) });
  }
}

console.log(`\n🔎 охранник кодировки .ps1 — проверено файлов: ${files.length}`);
console.log(`   чисто ASCII: ${okAscii} · не-ASCII с BOM: ${okBom}`);

if (FIX) {
  console.log(`   ✅ дописан BOM: ${fixed}`);
  process.exit(0);
}

if (bad.length === 0) {
  console.log('\n✅ дефектов нет: ни один .ps1 не несёт не-ASCII без BOM.\n');
  process.exit(0);
}

console.log(`\n⛔ .ps1 С НЕ-ASCII И БЕЗ BOM (${bad.length}) — PowerShell 5.1 прочитает их как ANSI:`);
for (const b of bad) console.log(`   · ${b.file}:${b.line} — ${b.text}`);
console.log(`\n   Лечение (одно из двух):`);
console.log(`   1) ПРЕДПОЧТИТЕЛЬНО — переписать вывод и комментарии латиницей (работает всегда);`);
console.log(`   2) либо дописать BOM: node tools/ps1-encoding-guard.mjs --fix`);
console.log(`\n   Симптом 9.6 в AGENT_GUIDE · урок EXP-0066\n`);
process.exit(1);
