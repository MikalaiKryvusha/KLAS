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
//   node tools/anonymize.mjs --selftest    ← прогнать себя на одноразовом КЛОНЕ и доказать, что
//                                            анонимность достигается, а сломанная версия краснеет

import {
  existsSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync, mkdtempSync, copyFileSync,
} from 'node:fs';
import { join, extname, dirname, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const APPLY = process.argv.includes('--apply');
const REINIT_GIT = process.argv.includes('--reinit-git');
const SELFTEST = process.argv.includes('--selftest');
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
  // Первая буква была КИРИЛЛИЧЕСКОЙ «К» (d0 9a) — анонимизированные документы получали смешанное
  // «КLAS», ломающее grep по бренду; валидатор PROBES этого не ловил (ревизия 2026-07-31)
  [/https?:\/\/github\.com\/MikalaiKryvusha\/KLAS(\.git)?/g, 'KLAS (локальная копия, origin удалён)'],
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
  // Одиночные Krinik/Криник (после схлопывания расшифровок) — остатки авторского алиаса.
  // ⚠️ Здесь были /\bKrinik\b/ и /\bКриник\b/, и КИРИЛЛИЧЕСКОЕ правило не срабатывало НИКОГДА:
  // `\b` в JS определён через `\w` = [A-Za-z0-9_], поэтому у слова «Криник», окружённого пробелами
  // или знаками препинания, обе стороны — не-`\w`, границы нет и совпадения не будет (bugs/24,
  // доказано запуском: ни «Привет, Криник!», ни «Кот Криник», ни «см. Криник —» не совпадали).
  // Лечение — не хитрее граница, а ПРОСТОЙ ЛИТЕРАЛ, как во всех соседних правилах. Две попытки
  // умных границ обе дали ложное зелёное: `(?!\p{L})` справа терял склонения («для Криника» —
  // 12 файлов), `(?<!\p{L})` слева терял алиас, стоящий сразу после `\b` в тексте ПРО саму
  // регулярку (5 файлов, среди них STATUS.md). Литерал заменяет основу, окончание остаётся:
  // «Криника» → «анонима», «Криником» → «анонимом» — «аноним» склоняется так же, и текст читаем.
  // Замена не пустая: пустая оставляла бы «Привет, !» и двойные пробелы, и она согласована с
  // соседними правилами (`Кот Криник` → «аноним», `kotkrinik` → «anon»).
  [/Krinik/g, 'anon'],
  [/Криник/g, 'аноним'],
  // Финальная чистка задвоений после замен
  [/независимый разработчик \(независимый разработчик\)/g, 'независимый разработчик'],
  [/независимый разработчик · независимый разработчик/g, 'независимый разработчик'],
];

// ── Что СКРАББЕР умеет править ───────────────────────────────────────────────
const TEXT_EXT = new Set(['.md', '.bat', '.cmd', '.ps1', '.yml', '.yaml', '.json', '.mjs', '.js', '.txt', '.example', '.svg']);
// Текстовые файлы БЕЗ расширения: у `.gitignore` `path.extname()` пуст, и по списку расширений
// такие файлы не находились вовсе — там жил funnel-хост владельца (bugs/24).
// ⚠️ `LICENSE` сюда СОЗНАТЕЛЬНО не входит: MIT требует сохранять уведомление об авторском праве в
// копиях, а замысел анонимной установки требует обратного. Развилка — у владельца
// (`interviews/interview_008`); до его ответа файл не трогаем, но и не прячем — см. KNOWN_EXCEPTIONS.
const TEXT_NAMES = new Set(['.gitignore', '.gitattributes']);
const isScrubbable = (p) => TEXT_EXT.has(extname(p).toLowerCase()) || TEXT_NAMES.has(basename(p));

// Пропуски делятся на два вида, и это НЕ придирка. Обход пропускал каталог по ИМЕНИ, и стоило
// добавить в список `voice` (гигабайты моделей и звука в корне), как вместе с ним ослеп и
// `tools/voice/` — код проекта, где живёт имя владельца. Поймано независимой сверкой сразу после
// правки; урок: пропуск, заданный именем, бьёт по всем одноимённым каталогам дерева.
const SKIP_ANYWHERE = new Set(['.git', 'node_modules']);   // служебные — где угодно
const SKIP_ROOT = new Set([                                 // тяжёлые/чужие — ТОЛЬКО в корне
  'LLMs', 'kiwixdb', 'KiwixDB', 'llamacpp', 'homepage', 'caddy', 'nssm', 'mcp',
  'voice', 'screenrec', 'logs', '.deploy-cache',
]);
// origin-привязанные скиллы (по KAIF 1.2: не разворачиваются при анонимной установке)
const ORIGIN_SKILLS = ['kaif-update', 'kaif-fork', 'kaif-switch-origin'];

// ── Что ВАЛИДАТОР ищет и где ────────────────────────────────────────────────
// ⚠️ ГЛАВНОЕ ПРАВИЛО (bugs/24): валидатор НЕ ДЕЛИТ фильтр со скраббером. Пока обе стороны отсеивали
// дерево одним списком расширений, охранник мог лишь подтвердить сам себя — скрипт печатал
// «✅ анонимность достигнута» над копией, где имя автора лежало в `LICENSE`, `.gitignore`,
// `logo/klas-cat.svg` и `README.pdf`. Охранник ОБЯЗАН видеть больше, чем чинит.
const PROBES = [
  'Mikalai Kryvusha', 'MikalaiKryvusha', 'Николай Кривуша', 'KOT KRINIK', 'Кот Криник',
  'kotkrinik', 'krinikspc', 'github.com/MikalaiKryvusha',
  // Одиночный алиас: правила для него существовали, но кириллическое не срабатывало никогда, и
  // ЗОНДА на него не было — поэтому «Криник» тихо оставался в восьми документах (bugs/24).
  'Криник', 'Krinik',
];
// Валидатор пропускает ТОЛЬКО то, где искать бессмысленно (гигабайты моделей, звука, кадров).
// Каталоги, куда скраббер не заходит (`homepage/`, `caddy/`, `nssm/`, `mcp/`), он проверяет —
// в этом и смысл: увидеть то, что чинилка пропустила.
const VALIDATE_SKIP_ROOT = new Set(['LLMs', 'kiwixdb', 'KiwixDB', 'llamacpp', 'voice', 'screenrec', 'logs', '.deploy-cache']);
const MAX_PROBE_BYTES = 8 * 1024 * 1024;   // выше — заведомо не документ, а бинарь/дамп
// Файлы, которые остаются с именем автора ОСОЗНАННО. Список именной и печатается вслух: молчаливое
// исключение неотличимо от дыры. `LICENSE` ждёт решения владельца (`interviews/interview_008`).
const KNOWN_EXCEPTIONS = new Map([['LICENSE', 'условие MIT: уведомление об авторском праве — решение владельца, interviews/interview_008']]);

function walk(dir, fn, skipRoot = SKIP_ROOT) {
  for (const name of readdirSync(dir)) {
    if (SKIP_ANYWHERE.has(name)) continue;
    if (dir === ROOT && skipRoot.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, fn, skipRoot);
    else fn(p);
  }
}

// ── 0. Самопроверка ──────────────────────────────────────────────────────────
// Охранник, который ни разу не краснел, не доказывает ничего (BUG_FIXING_FRAMEWORK). Проверять
// анонимизацию можно только ПРОГОНОМ, и только на КОПИИ: на рабочем репозитории она сотрёт
// атрибуцию автора. Поэтому самопроверка клонирует проект во временный каталог и гоняет там
// настоящий скрипт — дважды: как есть (обязан выйти чисто) и со сломанной картой замен (обязан
// покраснеть). Проверяются ровно те файлы, из-за которых родился bugs/24.
function selftest() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'klas-anon-selftest-'));
  const cases = [];
  const say = (ok, name, detail = '') => { cases.push(ok); console.log(`  ${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${detail ? ` — ${detail}` : ''}`); };
  try {
    // Клон служит ФИКСТУРОЙ (дерево последнего коммита), а проверяется ЭТОТ файл: сразу после
    // клонирования кладём в копию себя. Иначе самопроверка молча судила бы прошлую версию скрипта —
    // ровно тот сорт ложного зелёного, ради которого она и написана.
    const clone = (name) => {
      const dst = join(tmpRoot, name);
      execFileSync('git', ['clone', '--quiet', ROOT, dst]);
      copyFileSync(SELF, join(dst, 'tools', 'anonymize.mjs'));
      return dst;
    };
    const run = (dir) => spawnSync(process.execPath, [join(dir, 'tools', 'anonymize.mjs'), '--apply'], { encoding: 'utf8' });
    const leaksIn = (file) => {
      if (!existsSync(file)) return null;
      const buf = readFileSync(file);
      return PROBES.filter((probe) => buf.indexOf(Buffer.from(probe, 'utf8')) !== -1);
    };

    // (1) Здоровый прогон: анонимизация обязана пройти и не оставить личности.
    const ok = clone('clean');
    const r1 = run(ok);
    say(r1.status === 0, 'здоровый прогон выходит кодом 0', `код ${r1.status}`);
    say(/анонимность достигнута/.test(r1.stdout || ''), 'напечатан вердикт «анонимность достигнута»');

    // (2) Файлы, из-за которых родился bugs/24 — каждый проверяется ПОИМЁННО.
    say((leaksIn(join(ok, '.gitignore')) || []).length === 0, '.gitignore обезличен (файл без расширения)');
    say((leaksIn(join(ok, 'logo', 'klas-cat.svg')) || []).length === 0, 'logo/klas-cat.svg обезличен (.svg)');
    say(!existsSync(join(ok, 'README.pdf')), 'README.pdf удалён (двоичное зеркало README.md)');
    const licenseLeaks = leaksIn(join(ok, 'LICENSE'));
    say(licenseLeaks !== null && licenseLeaks.length > 0 && /LICENSE оставлен намеренно/.test(r1.stdout || ''),
      'LICENSE назван вслух как осознанное исключение, а не пропущен молча');
    // Одиночный алиас: правило на нём не срабатывало никогда (\b на кириллице).
    const alias = leaksIn(join(ok, 'PROJECT_HISTORY.md')) || [];
    say(!alias.includes('Криник'), 'одиночный «Криник» вычищен из документов');
    // Ловушка на пропуск по ИМЕНИ каталога: `voice` пропускается в корне (гигабайты моделей), но
    // `tools/voice/` — код проекта и обязан скрабиться. Один общий список имён ослеплял оба.
    say((leaksIn(join(ok, 'tools', 'voice', 'tts-sherpa-probe.mjs')) || []).length === 0,
      'tools/voice/ обезличен (пропуск «voice» действует только в корне)');

    // (3) Охранник обязан УМЕТЬ краснеть: ломаем карту замен и ждём отказа.
    const bad = clone('broken');
    const badFile = join(bad, 'tools', 'anonymize.mjs');
    const marker = 'const TEXT_EXT = new Set(';
    writeFileSync(badFile, readFileSync(badFile, 'utf8').replace(marker, `REPLACEMENTS.length = 0;\n${marker}`), 'utf8');
    const r2 = run(bad);
    say(r2.status === 1, 'со сломанной картой замен выходит кодом 1', `код ${r2.status}`);
    say(/УТЕЧКА/.test(r2.stderr || ''), 'и называет утечки поимённо');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  const bad = cases.filter((c) => !c).length;
  console.log(`\n═══ ${cases.length - bad}/${cases.length} ═══`);
  process.exit(bad ? 1 : 0);
}

// Самопроверка исполняется ДО любого прохода по файлам: она работает на клоне, а основной код —
// на текущем каталоге, и перепутать их нельзя.
if (SELFTEST) { console.log('\n═══ Самопроверка анонимизации (на одноразовом клоне) ═══\n'); selftest(); }

// ── 1. Замена текста во всех текстовых файлах ────────────────────────────────
console.log(`\n═══ Анонимизация KLAS ═══ режим: ${APPLY ? 'APPLY' : 'DRY-RUN'} · корень: ${ROOT}\n`);
let changed = 0;
walk(ROOT, (p) => {
  if (!isScrubbable(p)) return;
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
// tools/kaif.mjs: убрать origin-скиллы из валидатора (иначе kaif:check упадёт).
// ⚠️ Устарело с обновления KAIF до 1.6 (2026-07-26): валидатор переехал в .kaif/kaif-core.mjs, который
// умеет анонимность сам (пропускает origin-скиллы при tracking=anonymous и грепает дерево на утечки
// идентичности). Файла tools/kaif.mjs больше нет — блок ниже безопасно вырождается в no-op благодаря
// existsSync. Оставлен для проектов/копий, где старый файл ещё лежит на диске.
const kaifjs = join(ROOT, 'tools', 'kaif.mjs');
if (existsSync(kaifjs)) {
  const before = readFileSync(kaifjs, 'utf8');
  const after = before.replace(/'kaif-fork', 'kaif-switch-origin', /g, '').replace(/'kaif-update', /g, '');
  if (after !== before) { act('tools/kaif.mjs: убрать origin-скиллы из проверки'); if (APPLY) writeFileSync(kaifjs, after); }
}
// homepage/config/bookmarks.yaml: убрать ссылку на репозиторий автора — анонимной установке она не
// нужна. homepage/ в SKIP_DIRS (текст не скрабится), поэтому вырезаем блок «- Проект:» отдельным шагом.
const bmarks = join(ROOT, 'homepage', 'config', 'bookmarks.yaml');
if (existsSync(bmarks)) {
  const lines = readFileSync(bmarks, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^-\s+Проект:/.test(l));
  if (start !== -1) {
    let end = start + 1;                       // блок = строка группы + все последующие пустые/отступные
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
    let s = start;                             // прихватить строку-комментарий про анонимизацию над блоком
    if (s > 0 && /анонимн/i.test(lines[s - 1])) s--;
    act('homepage/config/bookmarks.yaml: убрать ссылку на репозиторий (блок «Проект»)');
    if (APPLY) { lines.splice(s, end - s); writeFileSync(bmarks, lines.join('\n')); }
  }
}
// homepage/config/services.yaml: обезличить (funnel-хост в ссылках Open WebUI / LLM-API и т.п.).
// homepage/ в SKIP_DIRS — скрабим этот файл явно теми же REPLACEMENTS (хост → <ваша-машина>.ts.net).
const svcs = join(ROOT, 'homepage', 'config', 'services.yaml');
if (existsSync(svcs)) {
  const before = readFileSync(svcs, 'utf8');
  let after = before;
  for (const [rx, to] of REPLACEMENTS) after = after.replace(rx, to);
  if (after !== before) { act('homepage/config/services.yaml: обезличить (funnel-хост)'); if (APPLY) writeFileSync(svcs, after); }
}

// README.pdf: ЗЕРКАЛО README.md, а не самостоятельный файл (реестр пар в AGENT_GUIDE.md). Текст
// источника обезличивается, а двоичное зеркало оставалось прежним и несло GitHub-хендл автора
// внутри (bugs/24). Правило реестра — зеркало не подпиливается на месте: его пересобирают у
// источника. Здесь удаляем и говорим, чем вернуть: пересборка тянет playwright/Chromium, которого
// в свежем клоне может не быть, а удаление обратимо одной командой.
const readmePdf = join(ROOT, 'README.pdf');
if (existsSync(readmePdf)) {
  act('удалить README.pdf (зеркало README.md; вернуть: node tools/render-pdf.mjs)');
  if (APPLY) rmSync(readmePdf, { force: true });
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
// Обход идёт по СВОЕМУ списку пропусков и без фильтра по расширениям — почему именно так,
// см. комментарий у PROBES выше (bugs/24: охранник обязан видеть больше, чем чинит).
console.log('\n— Проверка анонимности (ищем остатки личности) —');
let leaks = 0;
if (APPLY) {
  const excepted = new Set();
  walk(ROOT, (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.size > MAX_PROBE_BYTES) return;
    const rel = relative(ROOT, p);
    // Байты, а не строка: так под проверку попадают и двоичные файлы (PDF, изображения),
    // в которых текст лежит как есть.
    const buf = readFileSync(p);
    for (const probe of PROBES) {
      if (buf.indexOf(Buffer.from(probe, 'utf8')) === -1) continue;
      if (KNOWN_EXCEPTIONS.has(rel)) { excepted.add(rel); continue; }
      console.error(`  ✖ УТЕЧКА «${probe}» в .${rel ? `\\${rel}` : ''}`);
      leaks++;
    }
  }, VALIDATE_SKIP_ROOT);
  for (const rel of excepted) console.log(`  • ${rel} оставлен намеренно — ${KNOWN_EXCEPTIONS.get(rel)}`);
  console.log(leaks === 0 ? '  ✅ личность автора не найдена — анонимность достигнута' : `  ⚠ найдено ${leaks} утечек — разберись вручную`);
} else {
  console.log('  (dry-run: валидация выполнится после --apply)');
}

console.log(`\n═══ ${APPLY ? 'ГОТОВО' : 'РЕПЕТИЦИЯ (ничего не изменено)'} ═══`);
if (!APPLY) console.log('Выполнить: node tools/anonymize.mjs --apply [--reinit-git]');
else if (leaks) process.exit(1);
