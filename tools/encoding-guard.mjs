#!/usr/bin/env node
/**
 * encoding-guard.mjs — ОХРАННИК КОДИРОВОК И ОКОНЧАНИЙ СТРОК на Windows.
 *
 * Зачем. Правила этой платформы противоречат друг другу, и запомнить их нельзя — только проверять:
 *
 *   | файл            | требование            | что бывает, когда нарушено                        |
 *   |-----------------|-----------------------|---------------------------------------------------|
 *   | `.ps1` с не-ASCII | UTF-8 **С BOM**     | PS 5.1 читает файл как ANSI; кириллица рассыпается, |
 *   |                 |                       | а тире «—» рвёт строковый литерал — скрипт даже не |
 *   |                 |                       | разбирается (оплачено 2026-08-01)                  |
 *   | `.json`         | UTF-8 **БЕЗ BOM**     | `JSON.parse` падает на первом символе; читатели    |
 *   |                 |                       | глотают ошибку и работают с пустым состоянием      |
 *   | `.bat` / `.cmd` | **CRLF**              | LF ломает разборщик cmd (EXP-0002)                 |
 *
 * ⚠️ Обрати внимание на первые две строки: для `.ps1` BOM ОБЯЗАТЕЛЕН, для `.json` ЗАПРЕЩЁН. Правила
 * прямо противоположны, и оба уже кусали проект.
 *
 * Почему охранник, а не запись в EXPERIENCE. Правило про `.ps1` В ПРОЕКТЕ УЖЕ БЫЛО — в сноске
 * «Не для:» у EXP-0002, заметки про `.bat` от 3 июля. Знание, лежащее там, где его не ищут, садясь
 * писать новый файл, не работает: 2026-08-01 агент написал `.ps1` с кириллицей без BOM и потерял
 * заход владельца к микрофону. Знание, которое надо ПОМНИТЬ, рано или поздно забывается; знание,
 * которое ПРОВЕРЯЕТСЯ, — нет.
 *
 * Запуск: node tools/encoding-guard.mjs            (проверить дерево проекта)
 *         node tools/encoding-guard.mjs --selftest (проверить самого охранника)
 *         npm run guard:encoding
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = 'F:\\KLAS';
const SKIP = new Set([
  'node_modules', '.git', 'venv', 'venv-wakeword', 'screenrec', 'models', 'dist',
  '.venv', '__pycache__', 'corpus', 'sources', 'openwakeword',
]);

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Проверить ОДИН файл. Возвращает список нарушений — пустой, если всё в порядке. */
export function checkFile(file, buf) {
  const ext = path.extname(file).toLowerCase();
  const out = [];
  const hasBom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM);

  if (ext === '.ps1') {
    // Не-ASCII ищем в байтах, а не в декодированной строке: файл, уже испорченный ANSI-записью,
    // декодируется без ошибок и выглядел бы чистым.
    const nonAscii = buf.some((b) => b > 0x7f);
    if (nonAscii && !hasBom) {
      out.push('.ps1 содержит не-ASCII, но записан БЕЗ BOM — PS 5.1 прочитает его как ANSI');
    }
  }

  if (ext === '.json' && hasBom) {
    out.push('.json записан С BOM — JSON.parse падает на первом символе');
  }

  if (ext === '.bat' || ext === '.cmd') {
    const text = buf.toString('utf8');
    const lf = (text.match(/(?<!\r)\n/g) || []).length;
    if (lf > 0) out.push(`${ext} содержит ${lf} строк с LF вместо CRLF — cmd не разберёт`);
  }

  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ps1|json|bat|cmd)$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

/**
 * Выбросить всё, что git игнорирует. Так охранник судит ТОЛЬКО наши файлы: под `voice/` лежат
 * вендорные бинари (WolvenKit и прочие), и их `appsettings.json` с BOM — не наш дефект, а чужое
 * решение, которое .NET читает без возражений. Правило «исключение по имени» здесь хуже: список
 * чужих файлов растёт сам, а `.gitignore` и так ведётся.
 * ⚠️ Фильтруем именно игнорируемые, а НЕ «неотслеживаемые»: файл, который агент только что написал,
 * ещё не в индексе — а он-то и есть главная цель проверки.
 */
function dropIgnored(files, root) {
  // ⚠️ Пути идут ОТНОСИТЕЛЬНЫЕ и ЧЕРЕЗ ПРЯМОЙ СЛЭШ. Windows-путь `F:\KLAS\voice\tools\…` git
  // разбирает как строку с escape-последовательностями: `\v` и `\t` превращаются в управляющие
  // символы, и он отвечает `fatal: Invalid path 'F:/KLAS?oice⇥ools'` — то есть молча теряет ВЕСЬ
  // список, а охранник продолжает ругаться на чужие файлы (поймано 2026-08-01).
  const rel = files.map((f) => path.relative(root, f).split(path.sep).join('/'));
  let ignored = new Set();
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: root, input: rel.join('\n'), encoding: 'utf8',
    });
    ignored = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch (e) {
    // Код 1 у check-ignore означает «ничего не игнорируется» — это не ошибка. Любой другой сбой
    // (нет git, не репозиторий) оставляет список как есть: охранник скорее переругается, чем
    // промолчит о настоящем нарушении.
    if (!e || e.status !== 1) ignored = new Set();
  }
  return files.filter((_, i) => !ignored.has(rel[i]));
}

function scan(root) {
  const bad = [];
  for (const f of dropIgnored(walk(root), root)) {
    let buf;
    try {
      buf = fs.readFileSync(f);
    } catch {
      continue;
    }
    for (const why of checkFile(f, buf)) bad.push({ file: path.relative(root, f), why });
  }
  return bad;
}

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encguard-'));
  const cases = [
    // [имя, байты, должно ли ругаться, за что]
    ['bad.ps1', Buffer.from("Read-Host 'Готово — закрыть'", 'utf8'), true, 'кириллица без BOM'],
    ['good.ps1', Buffer.concat([BOM, Buffer.from("Read-Host 'Готово'", 'utf8')]), false, 'кириллица с BOM'],
    ['ascii.ps1', Buffer.from('Write-Host ok', 'utf8'), false, 'чистый ASCII без BOM — законно'],
    ['bad.json', Buffer.concat([BOM, Buffer.from('{"a":1}', 'utf8')]), true, 'json с BOM'],
    ['good.json', Buffer.from('{"a":1}', 'utf8'), false, 'json без BOM'],
    ['bad.bat', Buffer.from('echo one\necho two\n', 'utf8'), true, 'bat с LF'],
    ['good.bat', Buffer.from('echo one\r\necho two\r\n', 'utf8'), false, 'bat с CRLF'],
  ];

  let ok = 0;
  const fail = [];
  console.log('\n=== selftest encoding-guard ===');
  for (const [name, buf, shouldWarn, why] of cases) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, buf);
    const got = checkFile(f, fs.readFileSync(f)).length > 0;
    if (got === shouldWarn) {
      ok++;
      console.log(`  ✅ ${name} — ${why}`);
    } else {
      fail.push(name);
      console.log(`  ❌ ${name} — ${why}: ожидалось ${shouldWarn ? 'нарушение' : 'чисто'}`);
    }
  }

  // Самый важный случай: охранник обязан ловить ИМЕННО ТОТ файл, на котором проект споткнулся.
  const real = path.join(ROOT, 'tools', 'voice', 'record-window.ps1');
  if (fs.existsSync(real)) {
    const clean = checkFile(real, fs.readFileSync(real)).length === 0;
    if (clean) {
      ok++;
      console.log('  ✅ record-window.ps1 (тот самый файл) сейчас исправен');
    } else {
      fail.push('record-window.ps1');
      console.log('  ❌ record-window.ps1 всё ещё нарушает правило');
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  const total = ok + fail.length;
  console.log(`\n${ok}/${total} ` + (fail.length ? `— ПРОВАЛ: ${fail.join(', ')}` : '— охранник исправен'));
  return fail.length ? 1 : 0;
}

const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.slice(1));
if (IS_CLI) {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  const bad = scan(ROOT);
  if (!bad.length) {
    console.log('✅ кодировки и окончания строк в порядке');
    process.exit(0);
  }
  console.log(`❌ нарушений: ${bad.length}\n`);
  for (const b of bad) console.log(`  ${b.file}\n     ${b.why}`);
  process.exit(1);
}
