#!/usr/bin/env node
// tools/deploy.mjs — самораскрытие KLAS: «git clone + node tools/deploy.mjs --apply» (план 02, идея 03).
//
// Репозиторий — каркас; всё тяжёлое (движок, модель, docker-образы) этот скрипт скачивает сам
// по манифесту tools/deploy.manifest.json. ИДЕМПОТЕНТЕН: что уже есть и проходит check —
// пропускается; повторный запуск на живой системе безвреден и ничего не перекачивает.
//
// Запуск:  node tools/deploy.mjs           ← DRY-RUN: печатает план, ничего не меняет
//          node tools/deploy.mjs --apply   ← реальное выполнение
//
// Виды элементов манифеста (kind):
//   github-release — ассеты релиза GitHub (zip → распаковка в dest)
//   url            — прямое скачивание файла (докачка .part + проверка sha256)
//   winget         — установка пакета через winget
//   compose        — docker compose up -d (optional: пропускается без docker с предупреждением)

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, renameSync, rmSync, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');   // корень KLAS (репозиторий)
const APPLY = process.argv.includes('--apply');
const act = (m) => console.log(`${APPLY ? '▶' : '[dry-run]'} ${m}`);
const warnings = [];
const summary = { ok: [], done: [], skipped: [], failed: [] };

// ── Утилиты ────────────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {                       // тихий запуск команды → stdout|null
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
  catch { return null; }
}

function checkItem(item) {                                 // «уже сделано?» по манифестному check
  const c = item.check;
  if (!c) return false;
  if (c.file) {
    const p = join(ROOT, c.file);
    if (!existsSync(p)) return false;
    if (c.sizeBytes && statSync(p).size !== c.sizeBytes) return false;
    return true;
  }
  if (c.command) {
    try { execFileSync(c.command, { cwd: ROOT, shell: true, stdio: 'ignore' }); return true; }
    catch { return false; }
  }
  return false;
}

async function sha256File(path) {                          // потоковый хеш больших файлов
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex').toUpperCase();
}

async function download(url, destAbs, expectedSha) {       // скачивание с докачкой и проверкой
  mkdirSync(dirname(destAbs), { recursive: true });
  const part = destAbs + '.part';
  const have = existsSync(part) ? statSync(part).size : 0;
  const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
  act(`download ${url}${have ? ` (докачка с ${(have / 1e6).toFixed(0)} MB)` : ''}`);
  if (!APPLY) return;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} для ${url}`);
  const append = res.status === 206;                       // сервер поддержал докачку
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part, { flags: append ? 'a' : 'w' }));
  if (expectedSha) {
    const got = await sha256File(part);
    if (got !== expectedSha.toUpperCase()) { rmSync(part); throw new Error(`sha256 не совпал: ${got}`); }
  }
  renameSync(part, destAbs);
}

function unzip(zipAbs, destAbs) {                          // распаковка встроенным PowerShell
  act(`unzip ${zipAbs} → ${destAbs}`);
  if (!APPLY) return;
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipAbs}' -DestinationPath '${destAbs}' -Force`], { stdio: 'inherit' });
}

// ── Обработчики видов ──────────────────────────────────────────────────────
const handlers = {
  async 'github-release'(item) {
    const destAbs = join(ROOT, item.dest);
    for (const asset of item.assets) {
      const url = `https://github.com/${item.repo}/releases/download/${item.tag}/${asset}`;
      const zip = join(ROOT, '.deploy-cache', asset);
      await download(url, zip);
      unzip(zip, destAbs);
    }
  },
  async url(item) {
    await download(item.url, join(ROOT, item.dest), item.sha256);
  },
  async winget(item) {
    act(`winget install ${item.id}`);
    if (!APPLY) return;
    execFileSync('winget', ['install', item.id, '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit' });
  },
  async compose(item) {
    act(`docker compose -f ${item.file} up -d`);
    if (!APPLY) return;
    execFileSync('docker', ['compose', '-f', join(ROOT, item.file), 'up', '-d'], { stdio: 'inherit' });
  },
};

// ── 1. Предпроверки ────────────────────────────────────────────────────────
console.log(`\n═══ KLAS deploy ═══ режим: ${APPLY ? 'APPLY' : 'DRY-RUN (репетиция)'} · корень: ${ROOT}\n`);
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) { console.error(`✖ Нужен Node ≥20 (сейчас ${process.versions.node})`); process.exit(1); }
const hasDocker = run('docker', ['--version']) !== null;
const hasWinget = run('winget', ['--version']) !== null;
const hasNvidia = run('nvidia-smi', ['-L']) !== null;
console.log(`node ${process.versions.node} ✓ | winget ${hasWinget ? '✓' : '✖'} | docker ${hasDocker ? '✓' : '— (опциональные шаги пропустятся)'} | NVIDIA GPU ${hasNvidia ? '✓' : '⚠ не обнаружен'}`);
if (!hasNvidia) warnings.push('nvidia-smi не найден — стек рассчитан на NVIDIA GPU (драйвер поставить до работы LLM)');

// ── 2. Проход по манифесту ─────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(ROOT, 'tools', 'deploy.manifest.json'), 'utf8'));
for (const [name, item] of Object.entries(manifest.items)) {
  process.stdout.write(`\n— ${name} (${item.kind}) — `);
  if (checkItem(item)) { console.log('✓ уже на месте, пропуск'); summary.ok.push(name); continue; }
  if (item.kind === 'compose' && !hasDocker) { console.log('пропуск: docker недоступен (optional)'); summary.skipped.push(name); continue; }
  if (item.kind === 'winget' && !hasWinget) { console.log('✖ winget недоступен'); summary.failed.push(name); continue; }
  console.log('требуется установка:');
  try { await handlers[item.kind](item); summary[APPLY ? 'done' : 'skipped'].push(name); }
  catch (e) { console.error(`  ✖ ${e.message}`); summary.failed.push(name); }
}

// ── 3. Итог ────────────────────────────────────────────────────────────────
console.log(`\n═══ Итог ═══`);
console.log(`на месте: [${summary.ok}] · установлено: [${summary.done}] · к установке/пропущено: [${summary.skipped}] · провалено: [${summary.failed}]`);
for (const w of warnings) console.log(`⚠ ${w}`);
if (!APPLY) console.log('\nЕсли план устраивает: node tools/deploy.mjs --apply');
else console.log('\nПроверка стека: powershell -File tools/health-check.ps1, затем запуск llama-swap (см. llama-swap/config.yaml)');
if (summary.failed.length) process.exit(1);
