#!/usr/bin/env node
/**
 * verify-owner-reviews.mjs — ВОРОТА СДАЧИ КОНТУРА ВЫЧИТКИ.
 *
 * Три слоя, и каждый ловит то, чего не ловят остальные:
 *   A. ПИЛОТ ПО ЖИВЫМ ДОКУМЕНТАМ — прогон по ВСЕМ файлам `interviews/` и `homeworks/`. Условие
 *      сдачи из регламента (грабли №4: «фикстуры не ловят живые документы»). Главная проверка —
 *      СЧЁТНАЯ: сколько в документе строк-вариантов, столько обязано быть кликабельных вариантов на
 *      странице. Молчаливая потеря варианта — худший дефект контура: страница выглядит исправной,
 *      владелец выбирает из того, что ВИДИТ, и решение принимается по УРЕЗАННОМУ списку.
 *   B. ЖИВОЙ БРАУЗЕР — то, что проверяется только глазами и мышью: обе темы ОС, цвет полосы
 *      состояния ПИКСЕЛЯМИ (а не «класс на месте»), снятие выбора повторным кликом, запись решения
 *      в три места, автозакрытие.
 *   C. МУТАЦИИ — доказательство, что прибор умеет КРАСНЕТЬ. Проверка, которую нельзя провалить, —
 *      не проверка (урок NDim: собственный прогон рапортовал «сервер поднялся» через `|| true`).
 *
 * Запуск:  node tools/verify-owner-reviews.mjs [--no-browser]
 *
 * ⚠️ ЗВУКА В КОМНАТЕ НЕ ИЗДАЁТ: контур поднимается с `--no-signal`. Голос и три писка проверяются
 * ТЕКСТОМ команды, а не воспроизведением — правило владельца о звуке в комнате.
 *
 * [TESTED: 2026-08-01 · см. итог прогона в plans/24]
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ROOT,
  OWNER_DIRS,
  DECISIONS_DIR,
  readMd,
  parseInterview,
  parseMeta,
  decisionPath,
  isQuiet,
  textHash,
  bodyHash,
  checkApproval,
  writeDecision,
} from './lib/review-core.mjs';
import { buildPage, scopeOf } from './review.mjs';

const OUT = join(ROOT, 'test-results', 'owner-reviews');
const FIXTURE_DIR = join(OUT, 'fixture');
const FIXTURE = join(FIXTURE_DIR, 'interview_999_stand.md');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  OK     ${name}`);
  } else {
    fails.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ПРОВАЛ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// A. ПИЛОТ ПО ЖИВЫМ ДОКУМЕНТАМ
// ─────────────────────────────────────────────────────────────────────────────

function livePilot() {
  console.log('\n═══ A. ПИЛОТ ПО ЖИВЫМ ДОКУМЕНТАМ (условие сдачи инструмента) ═══\n');
  const docs = [];
  for (const dir of OWNER_DIRS) {
    for (const f of readdirSync(join(ROOT, dir)).sort()) {
      if (f.endsWith('.md') && f !== 'README.md') docs.push(`${dir}/${f}`);
    }
  }
  ok('живых документов очереди владельца найдено', docs.length > 0, `${docs.length}`);

  let lostOptions = 0;
  let renderFails = 0;
  let leaked = 0;
  let missingCards = 0;
  let external = 0;
  let doubled = 0;
  let doubledHead = 0;

  for (const rel of docs) {
    const p = join(ROOT, rel);
    let iv;
    let html;
    try {
      iv = parseInterview(p, readMd(p));
      html = buildPage({ docPath: p, live: true });
    } catch (e) {
      renderFails++;
      console.log(`         ⛔ ${rel}: ${e.message}`);
      continue;
    }

    // Счётная проверка: строк-кандидатов столько же, сколько разобранных вариантов.
    for (const q of iv.questions) {
      if (q.optionLines !== q.options.length) {
        lostOptions++;
        console.log(`         ⛔ ${rel} ${q.label}: строк ${q.optionLines}, разобрано ${q.options.length}`);
      }
      // Каждый разобранный вопрос обязан иметь карточку на странице.
      if (!html.includes(`data-q="${q.label}"`)) {
        missingCards++;
        console.log(`         ⛔ ${rel} ${q.label}: карточки на странице нет`);
      }
    }

    // Разметка не должна протекать в шапку (поймано в NDim ГЛАЗАМИ на кадре, а не проверкой).
    const head = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    if (/\*\*/.test(head)) {
      leaked++;
      console.log(`         ⛔ ${rel}: в шапке протекли звёздочки markdown`);
    }

    // Самодостаточность: никаких обращений наружу — страница обязана открываться офлайн.
    if (/(src|href)="https?:\/\/(?!127\.0\.0\.1)/.test(html)) {
      external++;
      console.log(`         ⛔ ${rel}: страница тянет ресурс из сети`);
    }

    // 🔴 «ВАРИАНТЫ ЕСТЬ» ≠ «ВАРИАНТЫ ЕСТЬ РОВНО ОДИН РАЗ». Проверка выше спрашивала первое, а
    // страница показывала список ДВАЖДЫ — текстом и кликабельными карточками. Владелец не понимает,
    // что из этого выбирается. Остаток списка вариантов в теле опознаётся по `<li><strong>A)`.
    if (iv.questions.some((q) => q.options.length) && /<li><strong>[A-ZА-Я]\)/.test(html)) {
      doubled++;
      console.log(`         ⛔ ${rel}: варианты продублированы текстом и карточками`);
    }
    // Заголовок документа живёт в ШАПКЕ; повтор его в теле — то же удвоение.
    // ⚠️ Проверяем ИМЕННО заголовок документа, а не «сколько на странице <h1>»: первая редакция
    // считала любые <h1> и покраснела на исправной `homeworks/03`, где второй `# ` — законный
    // раздел («ЧТО СЛУШАТЬ ПРЯМО СЕЙЧАС»), а не дубль названия. Ложная тревога в охраннике хуже
    // пропуска: она учит его игнорировать (грабли №5 регламента).
    const title = parseMeta(readMd(p)).title;
    const titleH1 = html.split(`<h1>${title}</h1>`).length - 1;
    if (titleH1 !== 1) {
      doubledHead++;
      console.log(`         ⛔ ${rel}: название документа как <h1> встречается ${titleH1} раз(а)`);
    }
  }

  ok('все живые документы разбираются и рендерятся', renderFails === 0, `сбоев: ${renderFails}`);
  ok('НИ ОДИН вариант ответа не потерян молча', lostOptions === 0, `потеряно: ${lostOptions}`);
  ok('у каждого разобранного вопроса есть карточка', missingCards === 0, `нет карточек: ${missingCards}`);
  ok('разметка не протекает в шапку страницы', leaked === 0, `протечек: ${leaked}`);
  ok('страницы самодостаточны (ни одного внешнего ресурса)', external === 0, `внешних: ${external}`);
  ok('варианты показаны РОВНО ОДИН раз (не текстом И карточками)', doubled === 0, `удвоений: ${doubled}`);
  ok('заголовок документа не удвоен шапкой и телом', doubledHead === 0, `удвоений: ${doubledHead}`);

  // Скоуп для голоса: тип документа обязан браться из директории, а не выдумываться.
  const iScope = scopeOf(join(ROOT, 'interviews', 'interview_001_project_setup.md'), { kind: 'interview' });
  const hScope = scopeOf(join(ROOT, 'homeworks', '06_personal_voice_audition.md'), { kind: 'interview' });
  ok('скоуп голоса: интервью опознано', iScope.kind === 'интервью', iScope.kind);
  ok('скоуп голоса: домашка опознана', hScope.kind === 'домашка', hScope.kind);

  return docs;
}

// ─────────────────────────────────────────────────────────────────────────────
// C. МУТАЦИИ — прибор обязан уметь краснеть
// ─────────────────────────────────────────────────────────────────────────────

function mutations() {
  console.log('\n═══ C. МУТАЦИИ (доказать, что проверки умеют краснеть) ═══\n');

  // Мутация 1: вариант с переносом строки, разобранный «однострочной» логикой, ПОТЕРЯЛСЯ бы.
  // Ставим документ, где жирный заголовок варианта перенесён, и требуем, чтобы счёт сошёлся.
  const wrapped = [
    '## Q1. Развилка?',
    '- **A) (рекомендую) Первый вариант, чей жирный заголовок',
    '  перенесён на вторую строку.** Хвост.',
    '- **B) Второй.** Хвост.',
    '',
    '**Ответ:**',
    '',
  ].join('\n');
  const w = parseInterview('мутация.md', wrapped);
  ok('мутация: перенесённый вариант не теряется', w.questions[0].options.length === 2);
  ok('мутация: счёт сходится', w.questions[0].optionLines === w.questions[0].options.length);

  // Мутация 2: сломанный разбор ловится счётной проверкой. Подсовываем строку-вариант, которую
  // OPTION_FULL разобрать не может (нет закрывающих `**`) — счёт обязан РАЗОЙТИСЬ.
  const broken = ['## Q1. Развилка?', '- **A) без закрытия жирного', '', '**Ответ:**', ''].join('\n');
  const b = parseInterview('мутация.md', broken);
  ok(
    'мутация: счётная проверка ловит неразобранный вариант',
    b.questions[0].optionLines === 1 && b.questions[0].options.length === 0,
  );

  // Мутация 3: линейка `---` после пустого поля НЕ смеет считаться ответом.
  const ruler = ['## Q1. Развилка?', '', '**Ответ:**', '', '---', '', '## Хвост', ''].join('\n');
  ok('мутация: линейка не делает вопрос отвеченным', parseInterview('м.md', ruler).questions[0].answered === false);

  // Мутация 4: хеш обязан РАЗЪЕХАТЬСЯ на изменённом тексте (I3) — иначе гейт бесполезен.
  ok('мутация: правка текста меняет хеш', textHash('тело\n') !== textHash('тело!\n'));

  // Мутация 5: тихие часы, пересекающие полночь. Наивное сравнение здесь молчит весь день.
  ok(
    'мутация: тихие часы переживают полночь',
    isQuiet(new Date(2026, 7, 1, 23, 30)) && isQuiet(new Date(2026, 7, 1, 3, 0)) && !isQuiet(new Date(2026, 7, 1, 14, 0)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗВУК СИГНАЛА — проверяем ТЕКСТОМ, а не воспроизведением (звук в комнате)
// ─────────────────────────────────────────────────────────────────────────────

function signalContract() {
  console.log('\n═══ ЗВУК СИГНАЛА (проверяется текстом — в комнате не звучит) ═══\n');
  const src = readFileSync(join(ROOT, 'tools', 'review.mjs'), 'utf8');
  ok(
    'три писка зафиксированы: 880 → 660 → 990',
    /\[console\]::beep\(880,160\); \[console\]::beep\(660,160\); \[console\]::beep\(990,260\);/.test(src),
  );
  ok('сигнал идёт ПОСЛЕ поднятия страницы (I5)', src.indexOf('await listen(server)') < src.indexOf('void signal('));
  ok('текст запасного тракта едет ФАЙЛОМ, а не аргументом', /ReadAllText\(/.test(src) && /writeFileSync\(sayFile/.test(src));
  ok('доставка не считается доказанной кодом возврата', /Доставка считается подтверждённой только словом человека/.test(src));

  // Тихие часы по УМОЛЧАНИЮ выигрывают, а обход — только явным флагом в командной строке.
  ok('тихие часы: по умолчанию сигнал подавляется', /quiet \?\? isQuiet\(now\)/.test(src));
  ok('обход тихих часов есть и он ЯВНЫЙ флаг', /const FORCE_SIGNAL = flag\('--force-signal'\)/.test(src));
  // ⛔ Флаг НЕ должен читаться из окружения: иначе автономный цикл унаследует его молча и разбудит
  // владельца ночью — ровно тогда, когда цикл и запускают, потому что владелец спит.
  ok(
    'обход НЕ наследуется из переменных окружения',
    !/FORCE_SIGNAL[^\n]*process\.env/.test(src) && !/process\.env\.[A-Z_]*FORCE/.test(src),
  );
  ok('обход, сработав в тихие часы, объявляет себя в логе', /ТИХИЕ ЧАСЫ ОБОЙДЕНЫ/.test(src));
}

// ─────────────────────────────────────────────────────────────────────────────
// B. ЖИВОЙ БРАУЗЕР
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_MD = `# Интервью 999 — стенд контура вычитки

> Статус: **🟡 ЖДЁТ ОТВЕТОВ ВЛАДЕЛЬЦА.**

Документ существует только ради проверки контура. Он живёт в \`test-results/\` и вне git.

---

## Q1. Вопрос без ответа — на нём проверяется выбор и его снятие?

- **A) (рекомендую) Первый вариант, чей жирный заголовок перенесён
  на вторую строку.** Ровно та форма, на которой контур однажды потерял вариант.
- **B) Второй вариант.** Хвост.
- **C) свой ответ** —

**Ответ:**

---

## Q2. Уже отвеченный вопрос — на нём проверяется неприкосновенность ответа?

- **A) Раз.**
- **B) Два.**

**Ответ:** B — слово владельца, которое запрещено затирать

---
`;

async function browserQA() {
  console.log('\n═══ B. ЖИВОЙ БРАУЗЕР ═══\n');

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    fails.push('playwright недоступен — живой браузер не проверен');
    console.log('  ПРОВАЛ playwright недоступен: `npm i -D playwright` и `npx playwright install chromium`');
    return;
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE, FIXTURE_MD, 'utf8');
  const before = readFileSync(FIXTURE, 'utf8');

  // 🔴 СОСТОЯНИЕ «ДО» — без этой пары проверка «ответ найден» красит зелёным ЛЮБУЮ предысторию,
  // включая ту, где ответ лежал там ещё до клика (контракт полевого отчёта NDim §13).
  ok('«до»: решения нет ни в одном из трёх мест', !existsSync(decisionPath(FIXTURE)) && !/owner-review:/.test(before));
  ok('«до»: поле Q1 пусто', parseInterview(FIXTURE, before).questions[0].answered === false);

  const PORT = 47311;
  // ⚠️ `--no-signal` обязателен: агентский прогон НЕ ЗВУЧИТ в комнате (правило владельца).
  const child = spawn(
    process.execPath,
    ['tools/review.mjs', 'open', 'test-results/owner-reviews/fixture/interview_999_stand.md',
      '--no-signal', '--no-open', '--port', String(PORT), '--timeout', '3'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  // ⚠️ Слушателя выхода вешаем ЗДЕСЬ, а не после проверок: `exit` — событие одноразовое, и
  // подписка после факта не срабатывает НИКОГДА. Первая редакция ворот именно так и отрапортовала
  // «контур не завершился» о контуре, который завершился исправно, — прибор врал, а не инструмент.
  const childExited = new Promise((r) => child.on('exit', () => r(true)));

  let browser;
  try {
    // Ждём, пока сервер честно ответит. Проверка, которую нельзя провалить, — не проверка:
    // здесь именно ПРОВЕРКА, а не `|| true` (на этом обжёгся собственный прогон NDim).
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/`);
        up = r.ok;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    ok('сервер контура поднялся и отвечает', up, up ? '' : log.slice(-300));
    if (!up) return;

    browser = await chromium.launch();
    const url = `http://127.0.0.1:${PORT}/`;

    // ── Обе темы ОС (грабли №6: тёмное на тёмном поймал владелец, а не самопроверки) ──
    const stripes = {};
    for (const scheme of ['light', 'dark']) {
      // Две ширины: широкий экран и узкий. Горизонтальный уезд ловится только на узком, а видит его
      // владелец, а не проверка «страница отрисовалась».
      for (const width of [1100, 560]) {
        const c = await browser.newContext({ colorScheme: scheme, viewport: { width, height: 900 } });
        const p = await c.newPage();
        const noise = [];
        p.on('console', (m) => {
          if (m.type() === 'error') noise.push(m.text());
        });
        p.on('pageerror', (e) => noise.push(String(e.message)));
        await p.goto(url);
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        ok(`[${scheme}/${width}] страница не уезжает вбок`, !overflow);
        // Чистая консоль — дешёвый детектор класса «обратная кавычка внутри <script> уронила модуль»:
        // страница при этом выглядит целой, а обработчики мертвы.
        ok(`[${scheme}/${width}] консоль браузера чиста`, noise.length === 0, noise.join(' | ').slice(0, 160));
        await c.close();
      }

      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1100, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(url);

      const seen = await page.evaluate(() => {
        const open = document.querySelector('.q.open');
        const done = document.querySelector('.q.done');
        const cs = (el) => (el ? getComputedStyle(el) : null);
        const body = getComputedStyle(document.body);
        return {
          openStripe: cs(open)?.borderLeftColor ?? null,
          doneStripe: cs(done)?.borderLeftColor ?? null,
          bg: body.backgroundColor,
          ink: body.color,
          tags: [...document.querySelectorAll('.q .tag')].map((t) => t.textContent.trim()),
          hasWhoField: /кто отвечает|кто отвеча/i.test(document.body.innerText),
        };
      });

      // Полоса слева СТЕРЕЖЁТСЯ ЦВЕТОМ, а не наличием класса: «класс на месте» не доказывает,
      // что владелец видит разницу между «ждёт вас» и «отвечено».
      ok(`[${scheme}] полоса «ждёт вас» окрашена`, !!seen.openStripe && seen.openStripe !== seen.bg, seen.openStripe);
      ok(`[${scheme}] полоса «отвечено» окрашена`, !!seen.doneStripe && seen.doneStripe !== seen.bg, seen.doneStripe);
      ok(`[${scheme}] цвета состояний РАЗЛИЧНЫ`, seen.openStripe !== seen.doneStripe);
      ok(`[${scheme}] текст не сливается с фоном`, seen.ink !== seen.bg, `${seen.ink} на ${seen.bg}`);
      ok(`[${scheme}] теги состояния на месте`, seen.tags.includes('ждёт вас') && seen.tags.includes('отвечено'), seen.tags.join('|'));
      // 🔑 Правка владельца: поля «Кто отвечает» на странице быть НЕ ДОЛЖНО.
      ok(`[${scheme}] поля «Кто отвечает» на странице НЕТ`, seen.hasWhoField === false);

      stripes[scheme] = seen.openStripe;
      await page.screenshot({ path: join(OUT, `stand-${scheme}.png`), fullPage: true });
      await ctx.close();
    }
    ok('темы дают РАЗНЫЕ цвета (обе оформлены, а не одна)', stripes.light !== stripes.dark, `${stripes.light} / ${stripes.dark}`);

    // ── Выбор и его СНЯТИЕ (главная правка владельца) ──
    const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1100, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(url);

    const q1 = page.locator('[data-q="Q1"]');
    ok('вариант с переносом строки виден владельцу', (await q1.locator('.opt').count()) === 3, String(await q1.locator('.opt').count()));

    const radioA = q1.locator('.opt input[value="A"]');
    const radioB = q1.locator('.opt input[value="B"]');
    const optA = q1.locator('.opt:has(input[value="A"])');
    const selected = () => optA.evaluate((el) => el.classList.contains('sel'));

    await radioA.click();
    ok('клик по варианту выбирает его', await radioA.isChecked());
    ok('выбранный вариант подсвечен', await selected());

    await radioA.click();
    ok('🔑 ПОВТОРНЫЙ клик СНИМАЕТ выбор', !(await radioA.isChecked()));
    ok('подсветка снята вместе с выбором', !(await selected()));

    // Снятие обязано работать и при клике по ТЕКСТУ подписи, а не только по кружку: браузер
    // порождает на подписи второе, синтетическое событие, и наивный обработчик снимал бы выбор
    // дважды, то есть никогда.
    const labelA = optA.locator('span');
    await labelA.click();
    ok('клик по тексту варианта выбирает', await radioA.isChecked());
    await labelA.click();
    ok('🔑 повторный клик по ТЕКСТУ тоже снимает выбор', !(await radioA.isChecked()));

    await radioA.click();
    await radioB.click();
    ok('клик по другому варианту переключает', (await radioB.isChecked()) && !(await radioA.isChecked()));
    await radioB.click();
    ok('вопрос можно оставить БЕЗ ответа', !(await radioB.isChecked()) && !(await radioA.isChecked()));

    ok('подсказка о снятии выбора показана владельцу', await q1.locator('.hint').isVisible());

    // ── Запись решения в три места ──
    await radioA.click();
    ok('третий клик снова ВЫБИРАЕТ (снятие не залипает)', await radioA.isChecked());
    await q1.locator('[data-text]').fill('ответ стенда');
    await page.locator('#docComment').fill('общий комментарий стенда');
    await page.locator('#save').click();
    await page.waitForSelector('.note.ok', { timeout: 15_000 });
    ok('страница подтвердила запись', true);

    const dPath = decisionPath(FIXTURE);
    ok('(1) решение записано файлом решения', existsSync(dPath));
    const decision = JSON.parse(readFileSync(dPath, 'utf8'));
    ok('решение содержит `by` (проставлен сервером, а не спрошен у владельца)', !!decision.by, decision.by);
    ok('решение содержит `at`', !!decision.at, decision.at);
    ok('решение содержит выбор владельца', decision.answers?.Q1?.choice === 'A', JSON.stringify(decision.answers?.Q1));

    const after = readFileSync(FIXTURE, 'utf8');
    ok('(2) ответ вписан обратно в md', /\*\*Ответ:\*\* \*\*A\*\* — ответ стенда/.test(after));
    ok('в md проставлена метка с `by` и `at`', /owner-review: by="[^"]+" at="[^"]+"/.test(after));
    ok('общий комментарий дописан в конец документа', /## 💬 Комментарий владельца/.test(after));
    // 🔴 Неприкосновенность первоисточника: уже данный ответ Q2 обязан остаться дословно.
    ok('уже написанный ответ владельца НЕ затёрт', after.includes('**Ответ:** B — слово владельца, которое запрещено затирать'));
    ok('исходный текст документа не пострадал', after.includes('## Q1. Вопрос без ответа'));
    ok('md изменился только дописыванием', after.length > before.length);

    const archiveDir = join(DECISIONS_DIR, 'archive');
    const archived = readdirSync(archiveDir).filter((f) => f.includes('interview_999_stand'));
    ok('(3) копия легла в архив решений', archived.length > 0, `${archived.length}`);

    // ── Автозакрытие через 2 секунды ──
    const closed = await page
      .waitForEvent('close', { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (closed) {
      ok('🔑 страница закрылась сама после ответа', true);
    } else {
      // Браузер вправе не дать `window.close()`. Тогда страница ОБЯЗАНА сказать это честно, а не
      // притворяться закрытой. Оба исхода приемлемы, «молча ничего» — нет.
      const honest = await page.locator('body').innerText();
      ok('🔑 автозакрытие: либо закрылась, либо честно попросила закрыть', /закройте её/i.test(honest), honest.slice(0, 120));
    }

    // ── «Сохранить» будит агента: процесс контура обязан завершиться ──
    const exited = await Promise.race([
      childExited,
      new Promise((r) => setTimeout(() => r(child.exitCode !== null), 12_000)),
    ]);
    ok('🔑 после сохранения контур ЗАВЕРШАЕТСЯ (это и будит агента)', exited, `exitCode=${child.exitCode}`);

    await ctx.close();
  } catch (e) {
    // Сбой прогона — это ПРОВАЛ ворот, а не падение процесса: иначе итог не печатается, а
    // осиротевший контур продолжает держать порт.
    fails.push(`живой браузер упал: ${e.message}`);
    console.log(`  ПРОВАЛ живой браузер упал — ${e.message.split('\n')[0]}`);
  } finally {
    // Осиротевший процесс держит порт и живёт часами — в NDim их набралось четыре.
    try {
      await browser?.close();
    } catch {}
    if (child.exitCode === null) child.kill();
    // Следы стенда убираем: решения фикстуры не должны копиться в архиве владельца.
    try {
      rmSync(decisionPath(FIXTURE), { force: true });
      const archiveDir = join(DECISIONS_DIR, 'archive');
      for (const f of readdirSync(archiveDir)) {
        if (f.includes('interview_999_stand')) rmSync(join(archiveDir, f), { force: true });
      }
      // Уборку тоже надо УТВЕРЖДАТЬ, а не надеяться на неё: прогон, который засоряет архив решений
      // владельца, портит ровно тот артефакт, ради читаемости которого контур и строился.
      const leftovers = readdirSync(archiveDir).filter((f) => f.includes('interview_999_stand'));
      ok('прогон убрал за собой (в архиве владельца нет следов стенда)', leftovers.length === 0 && !existsSync(decisionPath(FIXTURE)));
    } catch (e) {
      ok('прогон убрал за собой (в архиве владельца нет следов стенда)', false, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ГЕЙТ ОДОБРЕНИЯ (I4) и ВСТРОЕННАЯ МЕДИА — без браузера
// ─────────────────────────────────────────────────────────────────────────────

/** Минимальный валидный WAV (тишина) — чтобы проверять вшивание звука, ничего не воспроизводя. */
function tinyWav(path) {
  const samples = 400;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  writeFileSync(path, buf);
}

function gateAndMedia() {
  console.log('\n═══ ГЕЙТ ОДОБРЕНИЯ И ВСТРОЕННАЯ МЕДИА ═══\n');
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const bodyRel = 'test-results/owner-reviews/fixture/body.txt';
  const bodyAbs = join(ROOT, bodyRel);
  const gateDoc = join(FIXTURE_DIR, 'outbound_999.md');
  writeFileSync(bodyAbs, 'Тело черновика, которое уйдёт байт в байт.\n', 'utf8');
  writeFileSync(
    gateDoc,
    '```yaml\ntitle: Черновик стенда\nkind: outbound\nartifacts:\n' +
      `  - {id: a1, target: "стенд", format: text, body_file: ${bodyRel}}\n\`\`\`\n\n# Черновик стенда\n\n> Статус: 🟡 ждёт\n`,
    'utf8',
  );

  try {
    // ДО одобрения гейт обязан отказывать — fail-closed по умолчанию.
    ok('гейт: без решения — ОТКАЗ', checkApproval(gateDoc, 'a1').ok === false);

    // Одобряем ровно теми байтами, что лежат в теле.
    const at = new Date().toISOString();
    writeDecision({
      docPath: gateDoc,
      kind: 'outbound',
      by: 'стенд',
      at,
      comment: '',
      artifacts: { a1: { status: 'approved', sha256: bodyHash(bodyAbs) } },
    });
    ok('гейт: после одобрения — ПРОПУСКАЕТ', checkApproval(gateDoc, 'a1').ok === true);

    // 🔴 CRLF и BOM НЕ смеют аннулировать одобрение: на Windows git отдаёт `\r\n`, а редакторы
    // ставят BOM — если бы хеш их различал, гейт отказывал бы по любому артефакту всегда
    // (грабли №1 регламента в их самой дорогой форме).
    writeFileSync(bodyAbs, '﻿' + 'Тело черновика, которое уйдёт байт в байт.\r\n', 'utf8');
    ok('гейт: CRLF и BOM НЕ ломают одобрение', checkApproval(gateDoc, 'a1').ok === true);

    // А вот правка ТЕКСТА обязана аннулировать одобрение (I3).
    writeFileSync(bodyAbs, 'Тело черновика, которое кто-то подменил.\n', 'utf8');
    const drift = checkApproval(gateDoc, 'a1');
    ok('гейт: дрейф текста АННУЛИРУЕТ одобрение', drift.ok === false && /ИЗМЕНИЛСЯ/.test(drift.reason), drift.reason);

    // Тело пропало — тоже отказ, а не «наверное можно».
    rmSync(bodyAbs, { force: true });
    ok('гейт: пропавшее тело — ОТКАЗ', checkApproval(gateDoc, 'a1').ok === false);
    ok('гейт: неизвестный артефакт — ОТКАЗ', checkApproval(gateDoc, 'нет-такого').ok === false);

    // ── Встроенная медиа: судящему ЗВУК нужен звук, а не описание звука ──
    // Для KLAS это не украшение: половина вопросов владельцу — выслушки голосов и сигналов.
    const wavRel = 'test-results/owner-reviews/fixture/tone.wav';
    tinyWav(join(ROOT, wavRel));
    const mediaDoc = join(FIXTURE_DIR, 'media_999.md');
    writeFileSync(
      mediaDoc,
      `# Медиа стенда\n\n> Статус: 🟡 ждёт\n\n## Q1. Какой звук?\n\n- Голос 1 — [прослушать](${wavRel})\n- Пропавший файл — [прослушать](test-results/нет-такого.wav)\n\n**Ответ:**\n`,
      'utf8',
    );
    const html = buildPage({ docPath: mediaDoc, live: true });
    ok('медиа: звук ВШИТ в страницу проигрывателем', /<audio controls[^>]*src="data:audio\/wav;base64,/.test(html));
    ok('медиа: страница осталась самодостаточной', !/src="(?!data:)[^"]*\.wav"/.test(html));
    ok('медиа: пропавший файл назван честно, а не мёртвым плеером', /нет файла:/.test(html));
  } finally {
    try {
      rmSync(decisionPath(gateDoc), { force: true });
      const archiveDir = join(DECISIONS_DIR, 'archive');
      for (const f of readdirSync(archiveDir)) {
        if (f.includes('outbound_999')) rmSync(join(archiveDir, f), { force: true });
      }
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  ВОРОТА СДАЧИ КОНТУРА ВЫЧИТКИ ВЛАДЕЛЬЦА                      ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

mkdirSync(OUT, { recursive: true });
livePilot();
mutations();
gateAndMedia();
signalContract();
if (!process.argv.includes('--no-browser')) await browserQA();

console.log(`\n═══ ИТОГ: ${pass}/${pass + fails.length} ═══`);
if (fails.length) {
  console.error('\nПРОВАЛЫ:');
  for (const f of fails) console.error(`  · ${f}`);
  process.exit(1);
}
console.log('Контур сдан.\n');
