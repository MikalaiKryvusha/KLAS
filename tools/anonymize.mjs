#!/usr/bin/env node
// tools/anonymize.mjs — анонимное разворачивание KLAS (идея 07, по образцу KAIF 1.2 «Anonymous»).
//
// Превращает СВЕЖИЙ КЛОН KLAS в обезличенную копию: вычищает личность автора (имена, ники, GitHub,
// Tailscale-хост), схлопывает расшифровки акронимов (как KAIF: «не расшифровывай»), рвёт связь с
// origin (проект больше не тянется из репозитория автора). После анонимизации установить, кто автор,
// по файлам проекта нельзя.
//
// ⚠️ ЗАПУСКАТЬ ТОЛЬКО НА СВЕЖЕМ КЛОНЕ, НЕ на рабочем репозитории автора (сотрёт его атрибуцию)!
//   node tools/anonymize.mjs               ← DRY-RUN: показывает, что изменится
//   node tools/anonymize.mjs --apply       ← выполнить (правит файлы, origin, .kaif)
//   node tools/anonymize.mjs --apply --reinit-git   ← + стереть .git-историю (полная анонимность)

import {
  existsSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const REINIT_GIT = process.argv.includes('--reinit-git');
const act = (m) => console.log(`${APPLY ? '▶' : '[dry-run]'} ${m}`);

// ── Карта замен (ПОРЯДОК ВАЖЕН: сперва расшифровки акронимов, потом имена, потом одиночный «Krinik») ──
// Схлопываем «Krinik Local Agent System» → «KLAS» (акроним НЕ раскрываем — приём KAIF 1.2), затем
// вычищаем имена/ники/ссылки, затем добиваем одиночные Krinik/Криник.
const REPLACEMENTS = [
  // Схлопывание «KLAS — Krinik Local Agent System» / «KLAS (Krinik …)» → «KLAS» (без задвоения «KLAS — KLAS»)
  [/KLAS\s*[—–-]\s*Krinik Local Agent System/g, 'KLAS'],
  [/KLAS\s*\(Krinik Local Agent System\)/g, 'KLAS'],
  [/Krinik Local Agent System/g, 'KLAS'],
  [/KAIF\s*[—–-]\s*Krinik AI Framework/g, 'KAIF'],
  [/KAIF\s*\(Krinik AI Framework\)/g, 'KAIF'],
  [/Krinik AI Framework/g, 'KAIF'],
  // Полная авторская строка (обе aka-формы вместе) → один нейтральный вариант, без задвоения
  [/Николай Кривуша aka Кот Криник \(Mikalai Kryvusha aka KOT KRINIK\)/g, 'независимый разработчик'],
  [/Mikalai Kryvusha aka KOT KRINIK · Николай Кривуша aka Кот Криник/g, 'независимый разработчик'],
  [/Mikalai Kryvusha aka KOT KRINIK/g, 'независимый разработчик'],
  [/Николай Кривуша aka Кот Криник/g, 'независимый разработчик'],
  [/https?:\/\/github\.com\/MikalaiKryvusha\/KLAS(\.git)?/g, 'КLAS (локальная копия, origin удалён)'],
  [/https?:\/\/github\.com\/MikalaiKryvusha\/KAIF/g, 'KAIF (upstream)'],
  [/github\.com\/MikalaiKryvusha/g, '(origin удалён)'],
  [/MikalaiKryvusha/g, 'anon'],
  [/Mikalai Kryvusha/g, 'независимый разработчик'],
  [/Николай Кривуша/g, 'независимый разработчик'],
  [/KOT KRINIK/g, 'ANON'],
  [/Кот Криник/g, 'аноним'],
  [/kotkrinik@yandex\.ru|nikolai\.kryvusha@nogamelabs\.com/g, ''],
  [/kotkrinik/g, 'anon'],
  [/krinikspc\.forest-ratio\.ts\.net/g, '<ваша-машина>.ts.net'],
  [/krinikspc/g, '<ваша-машина>'],
  // Одиночные Krinik/Криник (после схлопывания расшифровок) — остатки авторского алиаса
  [/\bKrinik\b/g, ''],
  [/\bКриник\b/g, ''],
  // Финальная чистка задвоений после замен
  [/независимый разработчик \(независимый разработчик\)/g, 'независимый разработчик'],
  [/независимый разработчик · независимый разработчик/g, 'независимый разработчик'],
];

const TEXT_EXT = new Set(['.md', '.bat', '.cmd', '.ps1', '.yml', '.yaml', '.json', '.mjs', '.js', '.txt', '.example']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'LLMs', 'kiwixdb', 'llamacpp', 'homepage', 'caddy', 'nssm', 'mcp']);
// origin-привязанные скиллы (по KAIF 1.2: не разворачиваются при анонимной установке)
const ORIGIN_SKILLS = ['kaif-update', 'kaif-fork', 'kaif-switch-origin'];

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

// ── 1. Замена текста во всех текстовых файлах ────────────────────────────────
console.log(`\n═══ Анонимизация KLAS ═══ режим: ${APPLY ? 'APPLY' : 'DRY-RUN'} · корень: ${ROOT}\n`);
let changed = 0;
walk(ROOT, (p) => {
  if (!TEXT_EXT.has(extname(p).toLowerCase())) return;
  const before = readFileSync(p, 'utf8');
  let after = before;
  for (const [rx, to] of REPLACEMENTS) after = after.replace(rx, to);
  if (after !== before) { changed++; act(`scrub ${p.replace(ROOT, '.')}`); if (APPLY) writeFileSync(p, after); }
});
console.log(`  файлов с заменами: ${changed}`);

// ── 2. Структурные изменения ─────────────────────────────────────────────────
// .kaif/kaif.json: origin → нет, tracking → anonymous
const marker = join(ROOT, '.kaif', 'kaif.json');
if (existsSync(marker)) {
  act('.kaif/kaif.json: удалить origin, tracking → anonymous');
  if (APPLY) {
    const j = JSON.parse(readFileSync(marker, 'utf8'));
    delete j.origin; j.tracking = 'anonymous';
    writeFileSync(marker, JSON.stringify(j, null, 2) + '\n');
  }
}
// Удалить origin-привязанные скиллы (+ их зеркала в .roo/commands)
for (const s of ORIGIN_SKILLS) {
  for (const path of [join(ROOT, '.claude', 'skills', s), join(ROOT, '.roo', 'commands', `${s}.md`)]) {
    if (existsSync(path)) { act(`удалить скилл ${path.replace(ROOT, '.')}`); if (APPLY) rmSync(path, { recursive: true, force: true }); }
  }
}
// package.json: убрать origin-хендлы, repository, обезличить description
const pkg = join(ROOT, 'package.json');
if (existsSync(pkg)) {
  act('package.json: убрать kaif:update/fork/switch-origin, repository; обезличить description');
  if (APPLY) {
    const j = JSON.parse(readFileSync(pkg, 'utf8'));
    delete j.repository;
    for (const k of ['kaif:update', 'kaif:fork', 'kaif:switch-origin']) delete j.scripts?.[k];
    j.description = 'KLAS — self-hosted AI ecosystem: local LLM on gaming GPU, autonomous agents, web dashboard, offline knowledge base. KAIF-powered.';
    writeFileSync(pkg, JSON.stringify(j, null, 2) + '\n');
  }
}
// tools/kaif.mjs: убрать origin-скиллы из валидатора (иначе kaif:check упадёт)
const kaifjs = join(ROOT, 'tools', 'kaif.mjs');
if (existsSync(kaifjs)) {
  const before = readFileSync(kaifjs, 'utf8');
  const after = before.replace(/'kaif-fork', 'kaif-switch-origin', /g, '').replace(/'kaif-update', /g, '');
  if (after !== before) { act('tools/kaif.mjs: убрать origin-скиллы из проверки'); if (APPLY) writeFileSync(kaifjs, after); }
}

// ── 3. Git: разорвать origin (и по флагу — стереть историю) ──────────────────
try {
  const remotes = execFileSync('git', ['-C', ROOT, 'remote'], { encoding: 'utf8' });
  if (/\borigin\b/.test(remotes)) { act('git remote remove origin'); if (APPLY) execFileSync('git', ['-C', ROOT, 'remote', 'remove', 'origin']); }
} catch { /* git недоступен — пропускаем */ }
if (REINIT_GIT) {
  act('стереть .git (история с именем автора) и git init заново');
  if (APPLY) {
    rmSync(join(ROOT, '.git'), { recursive: true, force: true });
    execFileSync('git', ['-C', ROOT, 'init', '-q']);
  }
}

// ── 4. Валидация анонимности ─────────────────────────────────────────────────
console.log('\n— Проверка анонимности (ищем остатки личности) —');
const PROBES = ['Mikalai Kryvusha', 'MikalaiKryvusha', 'Николай Кривуша', 'KOT KRINIK', 'Кот Криник', 'kotkrinik', 'krinikspc', 'github.com/MikalaiKryvusha'];
let leaks = 0;
if (APPLY) {
  walk(ROOT, (p) => {
    if (!TEXT_EXT.has(extname(p).toLowerCase())) return;
    const c = readFileSync(p, 'utf8');
    for (const probe of PROBES) if (c.includes(probe)) { console.error(`  ✖ УТЕЧКА «${probe}» в ${p.replace(ROOT, '.')}`); leaks++; }
  });
  console.log(leaks === 0 ? '  ✅ личность автора не найдена — анонимность достигнута' : `  ⚠ найдено ${leaks} утечек — разберись вручную`);
} else {
  console.log('  (dry-run: валидация выполнится после --apply)');
}

console.log(`\n═══ ${APPLY ? 'ГОТОВО' : 'РЕПЕТИЦИЯ (ничего не изменено)'} ═══`);
if (!APPLY) console.log('Выполнить: node tools/anonymize.mjs --apply [--reinit-git]');
else if (leaks) process.exit(1);
