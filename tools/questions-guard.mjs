#!/usr/bin/env node
// tools/questions-guard.mjs — ВТОРАЯ ПОЛОВИНА ПРАВИЛА «МЕСТО ВОПРОСОВ».
//
// Первая половина стережёт `interviews/` и `homeworks/` изнутри (`tools/owner-questions.mjs`:
// кто ждёт ответа, где статус разошёлся с содержимым). Эта половина смотрит СНАРУЖИ: не осели ли
// вопросы владельцу там, где им запрещено быть, — в `plans/`, `bugs/`, `ideas/`, `researches/`.
//
// Канон (`AGENT_GUIDE.md` → «Место вопросов»): всё, чего агент хочет ОТ владельца, живёт ТОЛЬКО в
// `interviews/` и `homeworks/`. Полевой факт: это правило нарушают даже агенты, которые его ЗНАЮТ,
// потому что вопрос в хвосте плана дешевле в моменте. Дисциплина в теряющих контекст сессиях —
// худшее из хранилищ, поэтому правило нуждается в машине.
//
// ⛔ ГЛАВНОЕ КОНСТРУКТИВНОЕ РЕШЕНИЕ — БАЗОВАЯ ЛИНИЯ (ratchet).
//   Замер ДО кода (2026-08-02, грепом по четырём директориям): 32 попадания, из них ≈16 настоящих
//   очередей вопросов. То есть страж, красный с рождения, показывал бы шестнадцать нарушений на
//   первом же прогоне — и был бы не воротами, а фоновым шумом, который учит себя игнорировать
//   (грабли №5 регламента `/owner-reviews`: ложная тревога хуже пропуска).
//   Поэтому: унаследованный долг снимается СЛЕПКОМ в `tools/questions-baseline.json`, страж КРАСНЕЕТ
//   ТОЛЬКО НА НОВОМ, а размер долга печатается КАЖДЫЙ раз числом, которое обязано убывать.
//   Ключ строки — `файл + sha1(текст строки)`, а не номер строки: правка вопроса означает, что до
//   него дошли руки, и он снова проходит правило.
//
// Запуск:
//   node tools/questions-guard.mjs                 ← показать долг и упасть на НОВЫХ нарушениях
//   node tools/questions-guard.mjs --baseline      ← пересnять базовую линию (осознанная операция)
//   node tools/questions-guard.mjs --selftest      ← доказать, что страж умеет краснеть
//
// [TESTED: 2026-08-02 · самопроверка 9/9 + замер на живом дереве]

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE = join(ROOT, 'tools', 'questions-baseline.json');
// Директории, где вопросов владельцу быть НЕ ДОЛЖНО. `interviews/` и `homeworks/` — законное место,
// их стережёт другая половина (`owner-questions.mjs`).
const DIRS = ['plans', 'bugs', 'ideas', 'researches'];

// ── ЧТО ЛОВИМ: две сильные приметы вместо десяти слабых ──────────────────────
// Контракт поля: узко, а не широко. Слабые приметы дают шум, шум учит игнорировать.

/** (1) ЗАГОЛОВОК-ОЧЕРЕДЬ — раздел с вопросами внутри плана/бага/идеи/исследования.
 *  Самый дешёвый и самый сильный сигнал: это буквально то, что канон запрещает. */
const HEADING_QUEUE =
  /^#{1,6}\s+.*(открыт\p{L}*\s+вопрос|вопрос\p{L}*\s+владельц|что надо решить|ждёт\s+владельц|ждет\s+владельц)/iu;

/** (2) ОБРАЩЕНИЕ В НАЧАЛЕ СТРОКИ — висящий вопрос объявляет себя сразу, а ссылка на вопрос лежит
 *  глубоко в прозе. Ищем в первых ~40 знаках СОДЕРЖАНИЯ строки (после маркеров списка, цитаты,
 *  эмодзи и жирного). */
const INLINE_MARKERS =
  /(ждёт\s+владельц|ждет\s+владельц|ждёт\s+ответа\s+владельц|вопрос\s+владельцу|PENDING:)/iu;
const LEAD = 40;

/** Что снимается с начала строки, прежде чем мерить «первые 40 знаков». */
const stripLead = (l) => l.replace(/^[\s>|*\-+#\d.)\][❓⛔🔴🟡🟢⚠️✅📌💬🏠❗•]+/u, '').trim();

// ── ЧТО НЕ ЛОВИМ ─────────────────────────────────────────────────────────────
/** Строка уже показывает на место вопросов — вопрос доехал куда следовало. */
const ROUTED = /interviews\/|интервью\s*[№#]?\s*\d|\/interview\b|homeworks\//iu;
/** Закрытые формулировки: вопрос назван, но тут же снят. */
const CLOSED = /закрыт|снят|отвечен|получен ответ|решено|не блокер/iu;

// ── ИСКЛЮЧЕНИЯ — только явные, с причиной В СТРОКЕ ───────────────────────────
// ⚠️ Маркер с ПУСТОЙ причиной сам является нарушением: иначе он станет способом заткнуть стража.
const EXCEPT = /<!--\s*ВОПРОС-ОК:\s*(?<reason>[^>]*?)\s*-->/u;

const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);
const key = (file, text) => `${file}#${sha1(text.trim())}`;

/**
 * Разбор ОДНОГО файла. Чистая функция — её же гоняет самопроверка на строках-фикстурах.
 * Возвращает найденные нарушения и отдельно — маркеры-исключения с пустой причиной.
 */
export function scanText(file, text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  const emptyReasons = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Исключение действует на СВОЕЙ строке или на строке НИЖЕ (как пишут маркеры в markdown).
    const own = EXCEPT.exec(line);
    const above = i > 0 ? EXCEPT.exec(lines[i - 1]) : null;
    const mark = own ?? above;
    // ⚠️ Пустая причина считается ТОЛЬКО со СВОЕЙ строки маркера. Первая редакция считала и с
    // строки НИЖЕ (куда маркер действует) — и один и тот же маркер попадал в отчёт дважды.
    // Страж, который двоит нарушения, врёт о размере долга ровно так же, как тот, что их пропускает.
    if (own && !own.groups.reason) emptyReasons.push({ line: i + 1, text: line.trim() });

    const isHeading = HEADING_QUEUE.test(line);
    const lead = stripLead(line).slice(0, LEAD);
    const isInline = INLINE_MARKERS.test(lead);
    if (!isHeading && !isInline) continue;

    // Вопрос, уже адресованный в место вопросов, нарушением не является — он доехал.
    if (ROUTED.test(line)) continue;
    if (CLOSED.test(line)) continue;
    // Явное исключение с ПРИЧИНОЙ снимает срабатывание; с пустой — нет (см. emptyReasons выше).
    if (mark && mark.groups.reason) continue;

    hits.push({ file, line: i + 1, kind: isHeading ? 'заголовок-очередь' : 'обращение', text: line.trim(), key: key(file, line) });
  }
  return { hits, emptyReasons };
}

function walk() {
  const out = [];
  for (const dir of DIRS) {
    const full = join(ROOT, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full).sort()) {
      if (!name.endsWith('.md') || name === 'README.md') continue;
      // Закрытые документы — история проекта, а не живой долг. Вопрос в `_DONE_` уже не ждёт никого.
      if (name.includes('_DONE_')) continue;
      const p = join(full, name);
      if (!statSync(p).isFile()) continue;
      out.push({ rel: `${dir}/${name}`, text: readFileSync(p, 'utf8') });
    }
  }
  return out;
}

// ── САМОПРОВЕРКА ─────────────────────────────────────────────────────────────
function selftest() {
  const cases = [
    ['заголовок-очередь ловится', 'x.md', '## Открытые вопросы владельцу\n\nтекст\n', (r) => r.hits.length === 1],
    ['заголовок «что надо решить ДО кода» ловится', 'x.md', '## Что надо решить ДО кода (вопросы владельцу)\n', (r) => r.hits.length === 1],
    ['обращение в начале строки ловится', 'x.md', '- ⛔ Ждёт владельца: какой голос ставим\n', (r) => r.hits.length === 1],
    // 🔴 Проза В СЕРЕДИНЕ абзаца — НЕ нарушение. Иначе страж кричит на каждом упоминании правила,
    // и его перестают читать (грабли №5). Замер дал почти столько же ложных, сколько настоящих.
    ['проза в середине строки НЕ ловится', 'x.md',
      'Итог: уши получают смесь «вопрос владельца + речь ассистента», и это чинится иначе.\n',
      (r) => r.hits.length === 0],
    // Вопрос, уже доехавший в место вопросов, — не нарушение, а исправная маршрутизация.
    ['вопрос со ссылкой на interviews/ НЕ ловится', 'x.md',
      '## Открытые вопросы владельцу — вынесены в `interviews/interview_009`\n', (r) => r.hits.length === 0],
    ['вопрос, названный закрытым, НЕ ловится', 'x.md',
      'Вопрос владельцу «может выключить?» закрыт замером.\n', (r) => r.hits.length === 0],
    // Явное исключение с ПРИЧИНОЙ гасит срабатывание…
    ['исключение с причиной гасит', 'x.md',
      '<!-- ВОПРОС-ОК: цитата шаблона, а не вопрос -->\n## Открытые вопросы владельцу\n', (r) => r.hits.length === 0],
    // …а с ПУСТОЙ причиной — само является нарушением, иначе маркер станет затычкой.
    ['исключение с ПУСТОЙ причиной само нарушение', 'x.md',
      '<!-- ВОПРОС-ОК: -->\n## Открытые вопросы владельцу\n',
      (r) => r.emptyReasons.length === 1],
    // Ключ привязан к ТЕКСТУ, а не к номеру строки: сдвиг файла не «сбрасывает» долг.
    ['ключ не зависит от номера строки', 'x.md', '\n\n\n## Открытые вопросы владельцу\n',
      (r) => r.hits[0]?.key === key('x.md', '## Открытые вопросы владельцу')],
  ];
  let bad = 0;
  console.log('\n=== Самопроверка стража места вопросов ===\n');
  for (const [name, file, text, check] of cases) {
    const r = scanText(file, text);
    const ok = check(r);
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}`);
  }
  console.log(`\n=== ${cases.length - bad}/${cases.length} ===`);
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

// ── ПРОГОН ───────────────────────────────────────────────────────────────────
const files = walk();
const hits = [];
const emptyReasons = [];
for (const f of files) {
  const r = scanText(f.rel, f.text);
  hits.push(...r.hits);
  emptyReasons.push(...r.emptyReasons.map((e) => ({ ...e, file: f.rel })));
}

// Пересъёмка базовой линии — ОСОЗНАННАЯ операция, а не побочный эффект прогона.
if (process.argv.includes('--baseline')) {
  const snap = { снято: new Date().toISOString().slice(0, 10), долг: hits.length, ключи: hits.map((h) => h.key).sort() };
  writeFileSync(BASELINE, JSON.stringify(snap, null, '\t') + '\n', 'utf8');
  console.log(`Базовая линия снята: ${hits.length} унаследованных вопросов вне interviews/.`);
  console.log(`Файл: ${relative(ROOT, BASELINE)}`);
  process.exit(0);
}

const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { ключи: [] };
const known = new Set(base.ключи ?? []);
const fresh = hits.filter((h) => !known.has(h.key));
const inherited = hits.filter((h) => known.has(h.key));

console.log('\n═══ МЕСТО ВОПРОСОВ: что осело ВНЕ interviews/ ═══\n');
for (const h of inherited) console.log(`  · ${h.file}:${h.line} — ${h.kind}\n    ${h.text.slice(0, 100)}`);

// 🔑 ЧИСЛО, КОТОРОЕ ОБЯЗАНО УБЫВАТЬ. Печатается КАЖДЫЙ раз — иначе долг незаметно застывает.
console.log(`\nУнаследованный долг: ${inherited.length} (базовая линия от ${base.снято ?? '—'}: ${base.долг ?? 0}).`);
if (inherited.length < (base.долг ?? 0)) {
  console.log(`✅ Долг убыл на ${(base.долг ?? 0) - inherited.length}. Пересними линию: node tools/questions-guard.mjs --baseline`);
}
console.log('Разносить их по темам в interviews/ — отдельная работа; сваливать в одно мега-интервью нельзя.');

let fail = 0;
if (emptyReasons.length) {
  fail++;
  console.error('\n⛔ МАРКЕР-ЗАТЫЧКА: <!-- ВОПРОС-ОК --> без причины. Причина обязательна в той же строке.');
  for (const e of emptyReasons) console.error(`   · ${e.file}:${e.line}`);
}
if (fresh.length) {
  fail++;
  console.error(`\n⛔ НОВЫЙ ВОПРОС ВЛАДЕЛЬЦУ ВНЕ МЕСТА ВОПРОСОВ (${fresh.length}):`);
  for (const h of fresh) console.error(`   · ${h.file}:${h.line} — ${h.text.slice(0, 100)}`);
  console.error('\n   Заведи `interviews/interview_NNN_<тема>.md` и открой страницей:');
  console.error('   node tools/review.mjs open interviews/interview_NNN_<тема>.md');
  console.error('   Либо, если это НЕ вопрос, объяви исключение с причиной: <!-- ВОПРОС-ОК: почему -->');
}
if (fail) {
  console.error('');
  process.exit(1);
}
console.log('\n✅ новых вопросов вне места вопросов нет.\n');
