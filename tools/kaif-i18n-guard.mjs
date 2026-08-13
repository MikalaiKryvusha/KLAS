#!/usr/bin/env node
// Охранник РУССКОЙ ОБЁРТКИ KAIF — гонять ПОСЛЕ КАЖДОГО обновления фреймворка.
//
// Зачем он существует (оплачено обновлением 1.6 → 2.1, 2026-07-31):
// модульная механика KAIF вклеивает АНГЛИЙСКИЕ модули шаблона прямо в переведённые русские
// документы, порождая полный дубль на двух языках (у нас: PHILOSOPHY.md 20.7 → 31.0 КБ, 21 английский
// модуль рядом с 21 русским; плюс скиллы /pause и /kaif-remove). Глазами это ловится плохо: файл
// выглядит нормальным, пока не дойдёшь до середины. Разбор — reports/KAIF_UPDATES/01_KAIF_2.1_UPDATE_REPORT.md, дефекты D1/D3.
//
// Проверяет две вещи, каждая из которых УЖЕ ловила настоящий дефект:
//   [1] двуязычное задвоение — секция без единой кириллической буквы внутри документа,
//       который в остальном русский (порог по длине, чтобы латинские заголовки-термины
//       KISS / DRY / Best practices не шумели);
//   [2] машиночитаемая строка «Trigger aliases (ru): …» есть у КАЖДОГО скилла — при обновлении 2.1
//       установщик отрапортовал «34 skills trigger-aliased», а записал 23.
//
// ⚠️ Пустая выборка = КРАСНЫЙ результат, а не зелёный (EXP-0042: «нет данных» ≠ «нет проблем»).
// Запуск: node tools/kaif-i18n-guard.mjs [--verbose]
// Коды выхода: 0 — чисто · 1 — найдены дефекты · 2 — проверять нечего (обёртка не на месте).
// [TESTED: 2026-07-31 · проверка [2] покраснела на 11 настоящих пропажах алиасов, после починки зелёная]

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RU = /[А-Яа-яЁё]/;
const MIN_MODULE_CHARS = 200;
const VERBOSE = process.argv.includes('--verbose');

const DOCS = ['AGENT_GUIDE.md', 'PHILOSOPHY.md', 'BUG_FIXING_FRAMEWORK.md', 'TESTING_FRAMEWORK.md',
  'EXPERIENCE.md', 'STATUS.md', 'PROJECT_HISTORY.md', 'KAIF_FRAMEWORK.md',
  'plans/README.md', 'ideas/README.md', 'bugs/README.md', 'researches/README.md',
  'interviews/README.md', 'homeworks/README.md'];

// Модуль = markdown-заголовок и всё до следующего заголовка (заголовки внутри ``` не считаются).
function splitModules(text) {
  const mods = [];
  let cur = { signature: '<preamble>', lines: [] };
  let inFence = false;
  for (const l of text.split('\n')) {
    if (/^```/.test(l)) inFence = !inFence;
    if (!inFence && /^#{1,6} /.test(l)) { mods.push(cur); cur = { signature: l.trim(), lines: [l] }; continue; }
    cur.lines.push(l);
  }
  mods.push(cur);
  return mods.filter((m) => m.signature !== '<preamble>');
}

let problems = 0;
const say = (s) => console.log(s);

// ---------------------------------------------------------------- [1] двуязычное задвоение
say('[1] Двуязычное задвоение (английский модуль внутри русского документа)');
const targets = [];
for (const d of DOCS) if (existsSync(join(ROOT, d))) targets.push(d);
const skillsDir = join(ROOT, '.claude/skills');
if (existsSync(skillsDir)) {
  for (const s of readdirSync(skillsDir)) {
    const p = join(skillsDir, s, 'SKILL.md');
    if (existsSync(p) && statSync(p).isFile()) targets.push(`.claude/skills/${s}/SKILL.md`);
  }
}
if (targets.length < 10) {
  console.error(`✖ проверять нечего: найдено ${targets.length} файлов обёртки — KAIF развёрнут?`);
  process.exit(2);
}
let dirty = 0;
for (const rel of targets) {
  const mods = splitModules(readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'));
  if (!mods.length) continue;
  const ruMods = mods.filter((m) => RU.test(m.lines.join('\n'))).length;
  if (!ruMods) continue;                                  // файл целиком английский (сферы) — не наш случай
  const suspects = mods.filter((m) => {
    const t = m.lines.join('\n');
    return !RU.test(t) && t.length >= MIN_MODULE_CHARS;
  });
  if (suspects.length) {
    dirty++; problems++;
    say(`  ❌ ${rel} — русских секций ${ruMods}, английских без кириллицы: ${suspects.length}`);
    for (const s of suspects) say(`       ${s.signature}  (${s.lines.join('\n').length} симв.)`);
  } else if (VERBOSE) say(`  ok ${rel} (${ruMods} русских секций)`);
}
if (!dirty) say(`  ✅ чисто: ${targets.length} файлов обёртки, англо-дублей нет`);

// ---------------------------------------------------------------- [2] машиночитаемые алиасы
say('\n[2] Строка «Trigger aliases (ru): …» у каждого скилла');
const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir).filter((s) => existsSync(join(skillsDir, s, 'SKILL.md')))
  : [];
if (!skills.length) {
  console.error('  ✖ скиллов не найдено — проверка вырождена, это КРАСНЫЙ результат');
  process.exit(2);
}
const noAlias = skills.filter((s) => !/Trigger aliases \(ru\):/.test(readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8')));
if (noAlias.length) {
  problems += noAlias.length;
  say(`  ❌ без строки алиасов ${noAlias.length} из ${skills.length}: ${noAlias.join(' ')}`);
} else {
  say(`  ✅ все ${skills.length} скиллов несут строку алиасов`);
}
// Задвоенные «ёлочки» — след неверной починки алиасов (наступали 2026-07-31).
const doubled = skills.filter((s) => /««|»»/.test(readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8')));
if (doubled.length) { problems += doubled.length; say(`  ❌ задвоенные кавычки в алиасах: ${doubled.join(' ')}`); }

say(`\n${problems ? `❌ ДЕФЕКТОВ: ${problems} — см. reports/KAIF_UPDATES/01_KAIF_2.1_UPDATE_REPORT.md, D1 и D3` : '✅ обёртка чиста'}`);
process.exit(problems ? 1 : 0);
