#!/usr/bin/env node
// tools/dry-run-guard.mjs — ОХРАННИК КЛАССА «инструмент вежливо репетирует вместо того, чтобы делать»
// (родился из bugs/23; смежное — bugs/21, EXP-0042 «бумажный охранник»).
//
// Класс дефекта, а не один его экземпляр:
//   В проекте есть инструменты с контрактом «по умолчанию DRY-RUN, работает только с --apply»
//   (`const APPLY = process.argv.includes('--apply')`). Такой инструмент, вызванный БЕЗ флага,
//   печатает красивый план, НИЧЕГО не делает и выходит кодом 0 — а вызывающая сторона принимает
//   ноль за успех и рисует экран «готово». Именно так «анонимная установка» в мастере оставляла
//   в копии имя, ссылки и origin автора: 41 файл с личностью при зелёном коде выхода (bugs/23).
//
// Что охранник делает:
//   1. Находит инструменты с dry-run-контрактом — читает их ИСХОДНИКИ, а не список в голове.
//   2. Ищет по коду проекта СТРОКИ ЗАПУСКА этих инструментов (spawn/exec/runInherit/node …).
//   3. Красит вызов без --apply, если он не объявлен намеренной репетицией маркером DRY-RUN-OK.
//
// Границы (осознанные, чтобы охранник не врал в обе стороны):
//   · Сканируются только ИСПОЛНЯЕМЫЕ файлы (.mjs/.js/.ps1/.bat/.cmd). Документация и README не
//     сканируются: там `node tools/deploy.mjs` — это инструкция человеку, а не вызов.
//   · Скрипты package.json тоже не сканируются: там намерение объявлено ИМЕНЕМ (`deploy` против
//     `deploy:apply`), и оба варианта законны.
//   · Комментарии игнорируются: упоминание инструмента в шапке — не вызов.
//   · Собственный файл охранника пропускается — иначе его же фикстуры самопроверки покраснели бы.
//
// Запуск:
//   node tools/dry-run-guard.mjs             ← проверить проект (exit 1 при находках)
//   node tools/dry-run-guard.mjs --selftest  ← доказать, что охранник УМЕЕТ краснеть
//   node tools/dry-run-guard.mjs --verbose   ← показать найденные dry-run-инструменты и все вызовы

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, basename, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const VERBOSE = process.argv.includes('--verbose');

// Контракт «по умолчанию репетирую»: ровно та строка, из-за которой и возможен весь класс.
const DRY_RUN_CONTRACT = /process\.argv\.includes\(['"]--apply['"]\)/;

// Строка ЗАПУСКА процесса. Без этого признака упоминание файла — это проверка существования
// (`existsSync(join(ROOT,'tools','anonymize.mjs'))`), импорт или строка пути, а не вызов.
const EXEC_HINT = /\b(spawnSync|spawn|execFileSync|execFile|execSync|exec|runInherit|Start-Process|node)\b/;

// Намеренная репетиция объявляется в коде явно — маркером в комментарии рядом с вызовом.
const MARKER = /DRY-RUN-OK/;

const CODE_EXT = new Set(['.mjs', '.js', '.ps1', '.bat', '.cmd']);
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'LLMs', 'kiwixdb', 'KiwixDB', 'llamacpp', 'llamacpp-b9538',
  'homepage', 'caddy', 'nssm', 'mcp', 'voice', 'screenrec', 'logs', '.deploy-cache',
]);

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

// Снять комментарий с конца строки. `//` после двоеточия не трогаем — это URL (https://…),
// а не комментарий; иначе охранник обрезал бы половину строки и выдумывал находки.
function stripComment(lineText) {
  return lineText
    .replace(/(^|[^:])\/\/.*$/, '$1')
    .replace(/(^|\s)#.*$/, '$1')
    .replace(/(^|\s)::.*$/i, '$1')
    .replace(/(^|\s)rem\s.*$/i, '$1');
}

const isCommentLine = (l) => /^\s*(\/\/|#|::|rem\s)/i.test(l);

/**
 * Чистая функция проверки одного файла — её же гоняет самопроверка на фикстурах.
 * Окно проверки — строка запуска ± 1 строка: вызов может быть разложен на несколько строк
 * (`runInherit('node', [\n  join(...), '--apply',\n])`), и однострочный взгляд его бы упустил.
 */
export function scanText(label, text, tools) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (isCommentLine(raw)) continue;
    const code = stripComment(raw);
    if (!EXEC_HINT.test(code)) continue;
    const from = Math.max(0, i - 1);
    const winRaw = lines.slice(from, i + 2);
    const winCode = winRaw.map(stripComment).join('\n');
    const tool = tools.find((t) => winCode.includes(t));
    if (!tool) continue;
    if (winCode.includes('--apply')) continue;            // исполнение, а не репетиция
    if (MARKER.test(winRaw.join('\n'))) continue;         // репетиция объявлена намеренно
    found.push({ file: label, line: i + 1, tool, text: raw.trim() });
  }
  return found;
}

// ── Обнаружение dry-run-инструментов (по исходникам, а не по памяти) ─────────
function findDryRunTools() {
  const tools = [];
  walk(join(ROOT, 'tools'), (p) => {
    if (p === SELF) return;
    if (extname(p) !== '.mjs') return;
    if (DRY_RUN_CONTRACT.test(readFileSync(p, 'utf8'))) tools.push(basename(p));
  });
  return tools.sort();
}

// ── Самопроверка: охранник, который ни разу не краснел, не доказывает ничего ─
// Первой фикстурой подаётся ДОСЛОВНО строка, породившая bugs/23.
function selftest() {
  const tools = ['anonymize.mjs', 'deploy.mjs'];
  const cases = [
    {
      name: 'bugs/23 дословно: мастер зовёт анонимизацию без --apply',
      expect: 1,
      text: [
        "  if (answers.anonymous && existsSync(join(ROOT, 'tools', 'anonymize.mjs'))) {",
        "    line(`\\n${t('anonymizing')}`);",
        "    runInherit('node', [join(ROOT, 'tools', 'anonymize.mjs')]);",
        '  }',
      ].join('\n'),
    },
    {
      name: 'после фикса: тот же вызов с --apply',
      expect: 0,
      text: [
        "  if (answers.anonymous && existsSync(join(ROOT, 'tools', 'anonymize.mjs'))) {",
        "    if (!runInherit('node', [join(ROOT, 'tools', 'anonymize.mjs'), '--apply'])) return;",
        '  }',
      ].join('\n'),
    },
    {
      name: 'вызов разложен на несколько строк — флаг на соседней строке',
      expect: 0,
      text: [
        "  runInherit('node', [",
        "    join(ROOT, 'tools', 'deploy.mjs'), '--apply',",
        '  ]);',
      ].join('\n'),
    },
    {
      name: 'намеренная репетиция, объявленная маркером',
      expect: 0,
      text: [
        '  // DRY-RUN-OK: показываем пользователю план и ждём подтверждения',
        "  runInherit('node', [join(ROOT, 'tools', 'deploy.mjs')]);",
      ].join('\n'),
    },
    {
      name: 'проверка существования — не вызов, красить нельзя',
      expect: 0,
      text: "  if (existsSync(join(ROOT, 'tools', 'anonymize.mjs'))) ready = true;",
    },
    {
      name: 'упоминание в шапке-комментарии — не вызов',
      expect: 0,
      text: '//   node tools/anonymize.mjs               <- DRY-RUN: показывает, что изменится',
    },
    {
      name: 'PowerShell: голый вызов без флага',
      expect: 1,
      text: '  node tools\\deploy.mjs',
    },
  ];

  let bad = 0;
  console.log('\n=== Самопроверка охранника (умеет ли он краснеть) ===\n');
  for (const c of cases) {
    const got = scanText('<fixture>', c.text, tools).length;
    const ok = got === c.expect;
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK  ' : 'ПРОВАЛ'} ждали ${c.expect}, получили ${got} — ${c.name}`);
  }
  console.log(`\n=== ${cases.length - bad}/${cases.length} ===`);
  if (bad) { console.error('Охранник не проходит собственную самопроверку — верить его зелёному нельзя.'); process.exit(1); }
  process.exit(0);
}

if (process.argv.includes('--selftest')) selftest();

// ── Основной проход ──────────────────────────────────────────────────────────
const tools = findDryRunTools();
console.log(`\n=== Охранник dry-run ===  инструментов с контрактом «--apply»: ${tools.length ? tools.join(', ') : 'нет'}`);
if (!tools.length) { console.log('Нечего охранять.'); process.exit(0); }

const violations = [];
let scanned = 0;
walk(ROOT, (p) => {
  if (p === SELF) return;                                  // фикстуры самопроверки — не вызовы
  if (!CODE_EXT.has(extname(p).toLowerCase())) return;
  if (tools.includes(basename(p))) return;                 // сам инструмент: его шапка и вывод — не вызовы
  scanned++;
  const rel = relative(ROOT, p);
  const hits = scanText(rel, readFileSync(p, 'utf8'), tools);
  if (VERBOSE && hits.length === 0) return;
  violations.push(...hits);
});

console.log(`Просмотрено исполняемых файлов: ${scanned}`);
if (!violations.length) {
  console.log('OK — каждый вызов dry-run-инструмента из кода несёт --apply (или объявлен маркером DRY-RUN-OK).\n');
  process.exit(0);
}
console.error(`\nНАЙДЕНО ВЫЗОВОВ-РЕПЕТИЦИЙ: ${violations.length}\n`);
for (const v of violations) {
  console.error(`  x ${v.file}:${v.line} -> ${v.tool} без --apply`);
  console.error(`      ${v.text}`);
}
console.error('\nЛибо добавь --apply, либо объяви репетицию намеренной: комментарий с DRY-RUN-OK рядом с вызовом.\n');
process.exit(1);
