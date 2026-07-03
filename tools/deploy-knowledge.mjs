#!/usr/bin/env node
// tools/deploy-knowledge.mjs — ОПЦИОНАЛЬНАЯ база знаний KLAS (идея 08, задача 3).
// .zim-библиотеки безумно тяжёлые (десятки ГБ), поэтому в общий деплой и репозиторий не входят —
// этот скрипт пользователь запускает ОТДЕЛЬНО, по желанию. Делает две вещи:
//   1) показывает рекомендованные .zim и качает выбранные в kiwixdb/ (docker-kiwix их сам подхватит);
//   2) готовит MCP-адаптер поиска по википедии для агента (openzim-mcp) — тянет docker-образ и
//      печатает конфиг для Zoo Code (см. mcp/openzim-mcp.json, homeworks/02).
//
// Запуск:
//   node tools/deploy-knowledge.mjs --list                 # рекомендованные .zim
//   node tools/deploy-knowledge.mjs --get wikipedia_ru      # скачать конкретную базу
//   node tools/deploy-knowledge.mjs --mcp                    # подготовить MCP-адаптер (образ + конфиг)

import { createWriteStream, existsSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZIMDIR = join(ROOT, 'kiwixdb');
const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] || true) : null; };

// Рекомендованные .zim с download.kiwix.org (ключ → путь к последнему maxi-архиву; уточняй на сайте).
const RECOMMENDED = {
  'wikipedia_ru': 'https://download.kiwix.org/zim/wikipedia/wikipedia_ru_all_maxi.zim',
  'wikipedia_en': 'https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi.zim',
  'wikibooks_ru': 'https://download.kiwix.org/zim/wikibooks/wikibooks_ru_all_maxi.zim',
  'wikisource_ru': 'https://download.kiwix.org/zim/wikisource/wikisource_ru_all_maxi.zim',
};

if (arg('--list') || process.argv.length <= 2) {
  console.log('Рекомендованные .zim (скачать: node tools/deploy-knowledge.mjs --get <ключ>):\n');
  for (const [k, u] of Object.entries(RECOMMENDED)) console.log(`  ${k.padEnd(14)} ${u}`);
  console.log('\nПолный каталог: https://download.kiwix.org/zim/  ·  уже в kiwixdb/:');
  try { for (const f of execFileSync('ls', [ZIMDIR], { encoding: 'utf8' }).split('\n').filter((x) => x.endsWith('.zim'))) console.log('  ✓ ' + f); } catch {}
  console.log('\nMCP-адаптер поиска для агента: node tools/deploy-knowledge.mjs --mcp');
}

if (arg('--get')) {
  const key = arg('--get');
  const url = RECOMMENDED[key];
  if (!url) { console.error(`Неизвестный ключ «${key}». Список: --list`); process.exit(1); }
  mkdirSync(ZIMDIR, { recursive: true });
  const dest = join(ZIMDIR, `${key}.zim`);
  const part = dest + '.part';
  const have = existsSync(part) ? statSync(part).size : 0;
  console.log(`↓ качаю ${url}${have ? ` (докачка с ${(have / 1e9).toFixed(1)} ГБ)` : ''} → ${dest}`);
  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' });
  if (!res.ok && res.status !== 206) { console.error(`✖ HTTP ${res.status}`); process.exit(1); }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part, { flags: res.status === 206 ? 'a' : 'w' }));
  renameSync(part, dest);
  console.log(`✓ готово. Перезапусти kiwix: docker restart kiwix_wikipedia`);
}

if (arg('--mcp')) {
  console.log('— MCP-адаптер поиска по локальной википедии (openzim-mcp) —');
  try {
    execFileSync('docker', ['pull', 'ghcr.io/cameronrye/openzim-mcp:latest'], { stdio: 'inherit' });
    console.log('\n✓ образ готов. Добавь в MCP-настройки Zoo Code блок из mcp/openzim-mcp.json');
    console.log('  (агент получит инструменты zim_query / zim_search / zim_get по нашей .zim-базе).');
    console.log('  Инструкция: homeworks/02_knowledge_base_mcp.md');
  } catch (e) { console.error(`✖ docker pull не удался (${e.message}). Установи docker или образ вручную.`); }
}
