#!/usr/bin/env node
/**
 * review.mjs — КОНТУР ВЫЧИТКИ ВЛАДЕЛЬЦА: страница вопросов, ответ в один клик, сигнал, очередь.
 *
 * Регламент — `.claude/skills/owner-reviews/SKILL.md`; операционный план — `plans/24`.
 * Главная мысль регламента, которую легко потерять: **HTML — не цель, а транспорт; цель — охранник.**
 * Жёсткое правило («место вопросов — только `interviews/` и `homeworks/`») живёт в `AGENT_GUIDE.md`
 * и стережётся `tools/owner-questions.mjs`. Этот инструмент — надстройка сверху, делающая ответ
 * делом одного клика. Сила ответа от транспорта не зависит: **HTML = md = чат**.
 *
 * Команды:
 *   node tools/review.mjs open   <документ.md>  поднять страницу, открыть браузер, позвать владельца
 *   node tools/review.mjs render <документ.md>  снять страницу в файл (самодостаточный, офлайн)
 *   node tools/review.mjs list                  всё, что ждёт владельца (interviews/ + homeworks/)
 *   node tools/review.mjs queue  <документ.md>  поставить в очередь (для автономных циклов)
 *   node tools/review.mjs batch                 одна страница «накопилось N» на всю очередь
 *   node tools/review.mjs --selftest            самотест ядра контура
 *
 * Флаги: --by "Имя" · --voice <голос> · --no-signal · --no-open · --no-serve · --timeout МИН · --port N
 *         --force-signal — обойти тихие часы. ⛔ ТОЛЬКО по живому слову владельца; автономным
 *         циклам запрещён (см. комментарий у FORCE_SIGNAL).
 *
 * ⚠️ ЗВУК В КОМНАТЕ. Сигнал звучит в динамики владельца — правило владельца требует предупреждать.
 * Любой АГЕНТСКИЙ прогон (проверки, пилот, отладка) обязан идти с `--no-signal`.
 *
 * [TESTED: 2026-08-01 · самотест ядра + пилот по всем живым документам + живой браузер
 *  (tools/verify-owner-reviews.mjs)]
 */

import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ROOT,
  OWNER_DIRS,
  DECISIONS_DIR,
  QUEUE_FILE,
  readMd,
  parseMeta,
  parseInterview,
  mdToHtml,
  inline,
  bodyHash,
  artifactsOf,
  writeDecision,
  isQuiet,
  selftest,
} from './lib/review-core.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Разбор аргументов
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

/**
 * Кто отвечает. ПАРАМЕТР, а не вопрос на странице.
 *
 * 🔑 Поле «Кто отвечает» со страницы УБРАНО по слову владельца: на проекте владелец ровно один, и
 * спрашивать его имя каждый раз — трение без выгоды. Но сама ЗАПИСЬ `by` никуда не делась: её
 * проставляет сервер, потому что архив решений без «кто» нечитаем месяцы спустя (I2).
 * Убран ВОПРОС, а не ЗАПИСЬ — это разные вещи.
 */
const BY = opt('--by', process.env.KLAS_OWNER || 'Николай Кривуша');
/**
 * Голос — ПАРАМЕТР, а не меню (регламент: в поле у машины оказался ровно один пригодный голос из 185).
 * Тракт свой, местный: `tools/voice-say.mjs` (Silero v5 ru, локально, офлайн, CPU).
 * Умолчание `eugene` — выбор владельца слепым прослушиванием пяти образцов в соседнем проекте;
 * запасной путь — системный SAPI, если голосового тракта на машине нет.
 */
const VOICE = opt('--voice', process.env.KLAS_REVIEW_VOICE || 'eugene');
const SAPI_VOICE = process.env.KLAS_SAPI_VOICE || 'Microsoft Irina Desktop';
const VOICE_TOOL = opt('--voice-tool', process.env.KLAS_REVIEW_VOICE_TOOL || join(ROOT, 'tools', 'voice-say.mjs'));
const TIMEOUT_MIN = Number(opt('--timeout', '30'));
/**
 * Обход тихих часов. ⛔ **ТОЛЬКО ПО ЖИВОМУ СЛОВУ ВЛАДЕЛЬЦА, В ТОТ ЖЕ МОМЕНТ.**
 *
 * Инвариант I6 регламента гласит: тихие часы важнее всего остального, включая явно заказанный
 * уровень голоса. Он защищает дом от РЕШЕНИЙ АГЕНТА — и этот флаг его не отменяет, а сужает: решение
 * принимает не агент, а человек, который эти часы и назначил, и принимает его вслух и сейчас.
 *
 * ⛔ **Автономным циклам (`/autoloop`, `/dayloop`, `/nightloop`, `/guarded-loop`) флаг ЗАПРЕЩЁН.**
 * Ночной цикл существует ровно потому, что владелец спит. Разбудить его сигналом контура — худшее,
 * что этот инструмент может сделать. Флаг не читается из переменной окружения намеренно: он должен
 * быть НАПЕЧАТАН в команде живым человеком, а не унаследован окружением.
 */
const FORCE_SIGNAL = flag('--force-signal');
const QUIET_OVERRIDE = FORCE_SIGNAL ? false : null;

/**
 * Имя проекта, которое страница называет вслух: «Спрашивает ИИ-агент KLAS».
 *
 * 🔑 Правка владельца 2026-08-02: у него НЕСКОЛЬКО проектов, и в каждом работает свой агент. Открыв
 * страницу, он обязан за секунду понять, КТО спрашивает, — иначе вопрос приходится опознавать по
 * содержанию. Значение — каноническое короткое имя из таблицы идентичности `AGENT_GUIDE.md`;
 * при переносе контура в другой проект меняется РОВНО эта строка (или флаг `--project`).
 */
const PROJECT = opt('--project', process.env.KLAS_PROJECT || 'KLAS');

/** Человеческая отметка времени: «02.08.2026, 00:20:15». Владелец читает её, а не ISO. */
const stamp = (d = new Date()) => d.toLocaleString('ru-RU');

// ─────────────────────────────────────────────────────────────────────────────
// СТРАНИЦА
// ─────────────────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Стиль страницы. Обе темы ОС ОБЯЗАТЕЛЬНЫ: полевые грабли №6 регламента — «тёмное на тёмном поймал
 * владелец, а не самопроверки». Поэтому цвета заданы переменными и переопределяются медиазапросом,
 * а не подбираются на глаз в одной теме.
 *
 * Вид карточки вопроса зафиксирован выбором владельца (соседний проект, интервью о виде карточек):
 * ПОЛОСА СЛЕВА, крашенная СОСТОЯНИЕМ — янтарь «ждёт вас», зелень «отвечено». Полоса делает две
 * работы разом: отделяет один вопрос от другого и сообщает, отвечен ли он. На длинном интервью это
 * главное, что нужно видеть глазом.
 */
const STYLE = `
:root{
  --bg:#f7f7f5; --card:#fff; --ink:#1a1a1a; --dim:#5b5b57; --line:#e2e2dd;
  --accent:#1a6fd4; --accent-ink:#fff; --ok:#1f7a3d; --warn:#b06000; --bad:#b3261e;
  --code-bg:#f0f0ec;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#14161a; --card:#1b1e24; --ink:#e8e8e6; --dim:#a0a4ad; --line:#2c313a;
    --accent:#4d9bff; --accent-ink:#0b1220; --ok:#5fd08a; --warn:#e0a34a; --bad:#ff6b60;
    --code-bg:#232830;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.6 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:24px 18px 120px}
header.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);
  padding:14px 0;margin-bottom:18px}
h1{font-size:1.45rem;line-height:1.3;margin:0 0 6px}
h2{font-size:1.2rem;margin:1.6em 0 .5em}
h3{font-size:1.05rem;margin:1.4em 0 .4em}
h4{font-size:1rem;margin:1.2em 0 .4em}
p{margin:.6em 0}
a{color:var(--accent)}
code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;font-size:.9em}
pre{background:var(--code-bg);padding:12px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:.8em 0;padding:.1em 0 .1em 14px;border-left:3px solid var(--line);color:var(--dim)}
hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:.8em 0;font-size:.92em}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:var(--code-bg)}
.meta{color:var(--dim);font-size:.86rem}
/* Шапка «кто спрашивает и когда» — правка владельца: у него несколько проектов, и открытая
   страница обязана сама назвать проект и время, а не заставлять опознавать себя по содержанию. */
.asks{color:var(--dim);font-size:.85rem;margin:0 0 6px}
.asks b{color:var(--ink);font-weight:600}
/* Счётчики состояния пилюлями: сколько ждёт и сколько отвечено — видно, не читая документ.
   Цвета те же, что у полосы вопроса, чтобы пилюля и карточка читались одной системой. */
.pills{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 4px}
.pill{font-size:.8rem;font-weight:600;padding:3px 12px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.pill.open{color:var(--warn);border-color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.pill.ok{color:var(--ok);border-color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent)}
.q{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--line);
  border-radius:4px 12px 12px 4px;padding:16px 18px;margin:20px 0}
.q.open{border-left-color:var(--warn)}
.q.done{opacity:.72;border-left-color:var(--ok)}
.qhead{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.tag{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:99px;
  border:1px solid var(--line);color:var(--dim)}
.tag.open{color:var(--warn);border-color:var(--warn)}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.opts{display:flex;flex-direction:column;gap:8px;margin:12px 0}
.opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);
  border-radius:10px;cursor:pointer;background:transparent}
.opt:hover{border-color:var(--accent)}
.opt input{margin-top:4px}
.opt b{white-space:nowrap}
.opt.sel{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.hint{color:var(--dim);font-size:.8rem;margin:-4px 0 8px}
textarea{width:100%;min-height:70px;padding:10px;border:1px solid var(--line);border-radius:10px;
  background:var(--bg);color:var(--ink);font:inherit;font-size:.95rem;resize:vertical}
label.f{display:block;margin:10px 0 4px;font-size:.85rem;color:var(--dim)}
.prev{background:var(--code-bg);border-radius:8px;padding:10px 12px;margin:.5em 0;font-size:.95em}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);
  padding:12px 18px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap}
button{font:inherit;padding:10px 18px;border-radius:10px;border:1px solid var(--line);
  background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
button:disabled{opacity:.5;cursor:default}
.note{padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);
  margin:14px 0;font-size:.92rem}
.note.ok{border-color:var(--ok);color:var(--ok)}
.note.bad{border-color:var(--bad);color:var(--bad)}
.audio{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:.3em 0}
.audio audio{height:34px;max-width:100%}
.embed{margin:.8em 0;display:block}
.embed figcaption{color:var(--dim);font-size:.85rem;margin-bottom:6px;
  display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.embed .frame{width:100%;height:440px;border:1px solid var(--line);
  border-radius:10px;background:var(--card);display:block}
.embed button.full{font-size:.8rem;padding:4px 10px}
.shot{margin:.6em 0;display:block}
.shot img{width:100%;height:auto;border:1px solid var(--line);border-radius:10px;display:block}
.shot figcaption{color:var(--dim);font-size:.82rem;margin-top:4px}
.q.whole{border-style:dashed}
.art{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:20px 0}
.art pre{max-height:420px}
.hash{font-family:ui-monospace,Consolas,monospace;font-size:.78rem;color:var(--dim);word-break:break-all}
@media (max-width:560px){ .wrap{padding:16px 12px 140px} h1{font-size:1.2rem} }
`;

/**
 * Ссылка на звуковой файл превращается в проигрыватель, а сам файл ВШИВАЕТСЯ в страницу.
 *
 * Зачем вшивать, а не ссылаться: страница обязана быть самодостаточной и открываться офлайн, а
 * ссылка `file://` со страницы, отданной по http, браузером блокируется — владелец увидел бы мёртвый
 * проигрыватель и решил, что сломан контур.
 *
 * Зачем вообще звук: есть класс критериев, который агент измерить не может, — «красиво», «приятно».
 * Судящему звук нужен ЗВУК, а не описание звука. В KLAS это половина всех вопросов владельцу
 * (выслушки голосов, сигналы, записи имени), и раньше они требовали от него ручного поиска файлов.
 */
function inlineAudio(html) {
  return html.replace(/<a href="([^"]+\.(wav|mp3|ogg))">([^<]*)<\/a>/g, (_, src, ext, label) => {
    const p = resolve(ROOT, decodeURIComponent(src));
    if (!existsSync(p)) return `<span class="meta">нет файла: ${esc(src)}</span>`;
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/wav';
    const b64 = readFileSync(p).toString('base64');
    return `<span class="audio">${esc(label)}<audio controls preload="metadata" src="data:${mime};base64,${b64}"></audio></span>`;
  });
}

/**
 * Ссылка на HTML-файл превращается в ЖИВУЮ страницу внутри вопроса (для макетов и предпросмотров).
 *
 * Почему `srcdoc`, а не `src`: страница вычитки обязана оставаться САМОДОСТАТОЧНОЙ и открываться
 * офлайн одним файлом. Ссылка `src="…"` требовала бы раздачи файлов сервером и умирала бы в снимке.
 */
function inlineHtmlFrames(html) {
  return html.replace(/<a href="([^"]+\.html)">([^<]*)<\/a>/g, (_, src, label) => {
    const p = resolve(ROOT, decodeURIComponent(src));
    if (!existsSync(p)) return `<span class="meta">нет файла: ${esc(src)}</span>`;
    return `<figure class="embed">
      <figcaption><b>${esc(label)}</b>
        <button type="button" class="apart primary">Открыть отдельным экраном</button>
        <button type="button" class="full">Во весь экран</button>
        <span class="meta">ниже — быстрый просмотр</span></figcaption>
      <iframe class="frame" srcdoc="${esc(readFileSync(p, 'utf8'))}"></iframe>
    </figure>`;
  });
}

/** Ссылка на картинку превращается в саму картинку, вшитую в страницу (тот же довод, что у звука). */
function inlineImages(html) {
  return html.replace(/<a href="([^"]+\.(png|jpe?g|webp|svg))">([^<]*)<\/a>/g, (_, src, ext, label) => {
    const p = resolve(ROOT, decodeURIComponent(src));
    if (!existsSync(p)) return `<span class="meta">нет файла: ${esc(src)}</span>`;
    const mime =
      ext === 'svg' ? 'image/svg+xml' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
    const b64 = readFileSync(p).toString('base64');
    return `<figure class="shot"><img src="data:${mime};base64,${b64}" alt="${esc(label)}" loading="lazy"><figcaption>${esc(label)}</figcaption></figure>`;
  });
}

/**
 * Тело вопроса БЕЗ строк вариантов.
 *
 * 🔴 Иначе владелец видит один и тот же список ДВАЖДЫ: сперва текстом (как он написан в md), потом
 * кликабельными карточками — и не понимает, что из этого выбирается. Поймано ГЛАЗАМИ на кадре
 * собственной страницы; ни одна из 56 проверок этого не видела, потому что все они спрашивали
 * «варианты есть?», а надо было спросить «варианты есть РОВНО ОДИН раз?».
 */
function questionBody(q, lines, bodyEnd) {
  const drop = new Set();
  for (const [a, b] of q.optionSpans) for (let i = a; i <= b; i++) drop.add(i);
  const kept = [];
  for (let i = q.startLine + 1; i < bodyEnd; i++) if (!drop.has(i)) kept.push(lines[i]);
  return kept.join('\n');
}

/** Карточка одного вопроса: плашка состояния + тело + варианты + поля ввода. */
function questionCard(q, bodyMd) {
  const opts = q.options
    .map(
      (o) => `
      <label class="opt" data-l="${esc(o.letter)}">
        <input type="radio" name="ch-${esc(q.label)}" value="${esc(o.letter)}">
        <span><b>${esc(o.letter)})</b> ${inline(o.label)}</span>
      </label>`,
    )
    .join('');

  const existing = q.answered ? `<div class="prev"><b>Уже отвечено:</b><br>${mdToHtml(q.answer)}</div>` : '';

  return `
  <section class="q ${q.answered ? 'done' : 'open'}" data-q="${esc(q.label)}">
    <div class="qhead">
      <span class="tag ${q.answered ? 'ok' : 'open'}">${q.answered ? 'отвечено' : 'ждёт вас'}</span>
      <h3 style="margin:0">${esc(q.title)}</h3>
    </div>
    ${mdToHtml(bodyMd)}
    ${existing}
    ${opts ? `<div class="opts">${opts}</div><p class="hint">Повторный клик по выбранному снимает выбор — вопрос можно оставить без ответа.</p>` : ''}
    <label class="f">${q.answered ? 'Уточнение (старый ответ останется дословно)' : 'Ответ своими словами'}</label>
    <textarea data-text="${esc(q.label)}" placeholder="можно только букву выше, можно только текст, можно оба"></textarea>
    <label class="f">Пометка для агента (необязательно)</label>
    <textarea data-comment="${esc(q.label)}" style="min-height:44px"></textarea>
  </section>`;
}

/** Карточка исходящего артефакта: полная полезная нагрузка + промышленная четвёрка действий. */
function artifactCard(a, bodyText, hash) {
  return `
  <section class="art" data-art="${esc(a.id)}" data-hash="${esc(hash)}">
    <div class="qhead">
      <span class="tag open">на одобрение</span>
      <h3 style="margin:0">${esc(a.id)} → ${esc(a.target || 'адресат не указан')}</h3>
    </div>
    <p class="meta">Файл тела: <code>${esc(a.body_file)}</code> · формат: ${esc(a.format || 'text')}</p>
    <p class="meta">Уйдёт ровно это, байт в байт:</p>
    <pre><code>${esc(bodyText)}</code></pre>
    <p class="hash">SHA-256 тела: ${esc(hash)}</p>
    <div class="opts">
      <label class="opt"><input type="radio" name="st-${esc(a.id)}" value="approved"><span><b>Одобрить</b> — отправлять как есть</span></label>
      <label class="opt"><input type="radio" name="st-${esc(a.id)}" value="rejected"><span><b>Отклонить</b> — с причиной ниже</span></label>
      <label class="opt"><input type="radio" name="st-${esc(a.id)}" value="edit"><span><b>Поправить</b> — что именно, ниже</span></label>
      <label class="opt"><input type="radio" name="st-${esc(a.id)}" value="reply"><span><b>Ответить</b> — вопрос агенту, решения пока нет</span></label>
    </div>
    <label class="f">Причина / правка / вопрос</label>
    <textarea data-text="${esc(a.id)}"></textarea>
  </section>`;
}

/**
 * Собирает страницу документа.
 * @param live — живая страница (можно ответить) или снимок в файл (только чтение).
 */
export function buildPage({ docPath, live }) {
  const relPath = relative(ROOT, docPath).split('\\').join('/');
  const text = readMd(docPath);
  const meta = parseMeta(text);
  const parsed = parseInterview(docPath, text);
  const lines = parsed.lines;

  // 🔴 Шапка страницы УЖЕ показывает заголовок документа и его статус. Если оставить их и в теле,
  // владелец читает одно и то же дважды подряд — поймано глазами на кадре. Поэтому из преамбулы
  // выбрасываются ровно две строки: первый `# ` и строка статуса.
  const skip = new Set();
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 >= 0) skip.add(h1);
  if (parsed.statusLine >= 0) skip.add(parsed.statusLine);
  const slice = (from, to) =>
    lines.slice(from, to).filter((_, i) => !skip.has(from + i)).join('\n');

  // Сегменты в исходном порядке: карточки вопросов и всё, что между ними, — ничего не теряем.
  const chunks = [];
  let cursor = 0;
  for (const q of parsed.questions) {
    if (q.startLine > cursor) chunks.push(mdToHtml(slice(cursor, q.startLine)));
    const bodyEnd = q.answerLine >= 0 ? q.answerLine : q.endLine;
    chunks.push(questionCard(q, questionBody(q, lines, bodyEnd)));
    cursor = q.endLine;
  }
  if (cursor < lines.length) chunks.push(mdToHtml(slice(cursor, lines.length)));

  // Исходящие артефакты: тело берётся ССЫЛКОЙ на файл, не копипастой — страница показывает ровно те
  // байты, что уйдут, и хеш считается по ним же (I3).
  const arts = [];
  for (const a of meta.artifacts) {
    const p = resolve(ROOT, a.body_file || '');
    if (!a.body_file || !existsSync(p)) {
      arts.push(
        `<section class="art"><div class="note bad">Артефакт <b>${esc(a.id)}</b>: файл тела
        <code>${esc(a.body_file || '—')}</code> не найден. Одобрять нечего.</div></section>`,
      );
      continue;
    }
    arts.push(artifactCard(a, readFileSync(p, 'utf8'), bodyHash(p)));
  }

  const open = parsed.questions.filter((q) => !q.answered).length;
  const done = parsed.questions.length - open;
  // Пилюли рисуются, только когда в документе ЕСТЬ вопросы: у домашки их нет, и «ждут вас: 0 ·
  // отвечено: 0» сказало бы владельцу неправду о том, что от него ничего не нужно.
  const pills = parsed.questions.length
    ? `<div class="pills"><span class="pill open">ждут вас: ${open}</span><span class="pill ok">отвечено: ${done}</span></div>`
    : '<div class="pills"><span class="pill">вопросов нет — нужен ваш отклик</span></div>';

  const page = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.title)}</title>
<style>${STYLE}</style></head>
<body data-doc="${esc(relPath)}" data-kind="${esc(meta.kind)}">
<div class="wrap">
  <header class="top">
    <p class="asks">Спрашивает ИИ-агент <b>${esc(PROJECT)}</b> · ${esc(stamp())}</p>
    <h1>${esc(meta.title)}</h1>
    ${pills}
    <div class="meta">
      ${esc(relPath)}
      ${meta.artifacts.length ? ` · артефактов на одобрение: ${meta.artifacts.length}` : ''}
    </div>
    ${parsed.statusRaw ? `<div class="meta">${mdToHtml(parsed.statusRaw)}</div>` : ''}
  </header>

  ${live ? '' : '<div class="note">Это СНИМОК страницы в файл. Отвечать можно на живой: <code>node tools/review.mjs open ' + esc(relPath) + '</code></div>'}

  ${arts.join('\n')}
  ${chunks.join('\n')}

  ${
    live
      ? `<section class="q whole">
    <div class="qhead"><span class="tag">по документу целиком</span></div>
    <label class="f">Общий комментарий — то, что относится ко всему документу, а не к одному вопросу</label>
    <textarea id="docComment" placeholder="необязательно"></textarea>
  </section>`
      : ''
  }
</div>

${
  live
    ? `<div class="bar">
  <button class="primary" id="save">Сохранить ответы</button>
  <span class="meta" id="status"></span>
</div>`
    : ''
}

<script>
// Выбор варианта. Единственная «логика» страницы — всё остальное собирает сервер.
//
// 🔑 ПОВТОРНЫЙ КЛИК ПО ВЫБРАННОМУ ПУНКТУ СНИМАЕТ ВЫБОР. Радиокнопка такого не умеет по природе:
// раз выбрав, передумать «ни один» уже нельзя — а в интервью это нужно постоянно, потому что
// вопрос можно начать отвечать и отложить, и потому что ответить разрешено НЕ НА ВСЕ вопросы.
// Механика: состояние запоминается на mousedown (ДО того, как браузер применит активацию), а
// снимается на клике САМОГО поля — к этому моменту браузер свою активацию уже сделал, и наш
// «отжим» её не перетрёт. События с целью-подписью пропускаем: клик по тексту порождает ВТОРОЕ,
// синтетическое событие на поле, и обработай мы оба — выбор снимался бы дважды, то есть никогда.
let wasChecked = false;
const paint = (box) => {
  for (const l of box.querySelectorAll('.opt'))
    l.classList.toggle('sel', !!l.querySelector('input[type=radio]')?.checked);
};
document.addEventListener('mousedown', (e) => {
  wasChecked = !!e.target.closest?.('.opt')?.querySelector('input[type=radio]')?.checked;
});
document.addEventListener('keydown', () => { wasChecked = false; });
document.addEventListener('click', (e) => {
  const radio = e.target.closest?.('.opt')?.querySelector('input[type=radio]');
  if (!radio || e.target !== radio) return;
  if (wasChecked) radio.checked = false;
  wasChecked = false;
  paint(radio.closest('.opts'));
});
document.addEventListener('change', (e) => {
  if (e.target.type === 'radio') paint(e.target.closest('.opts'));
});

// Живой макет внутри вопроса: рамка компактная для быстрого просмотра, рядом две двери наружу —
// отдельное окно и полный экран (серьёзный выбор смотрят отдельным экраном, а не в рамке).
document.addEventListener('click', (e) => {
  const frame = e.target.closest?.('.embed')?.querySelector('.frame');
  if (!frame) return;
  if (e.target.classList.contains('full') && frame.requestFullscreen) frame.requestFullscreen();
  if (e.target.classList.contains('apart')) {
    // Окно открывает СКРИПТ — значит макет живёт полноценным экраном и закрывается как обычное окно.
    const blob = new Blob([frame.getAttribute('srcdoc')], { type: 'text/html;charset=utf-8' });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  }
});

const saveBtn = document.getElementById('save');
if (saveBtn) saveBtn.addEventListener('click', async () => {
  const answers = {};
  for (const sec of document.querySelectorAll('[data-q]')) {
    const label = sec.dataset.q;
    const choice = sec.querySelector('input[type=radio]:checked')?.value || '';
    const text = sec.querySelector('[data-text]')?.value.trim() || '';
    const comment = sec.querySelector('[data-comment]')?.value.trim() || '';
    if (choice || text) answers[label] = { choice, text, comment };
  }
  const artifacts = {};
  for (const sec of document.querySelectorAll('[data-art]')) {
    const id = sec.dataset.art;
    const status = sec.querySelector('input[type=radio]:checked')?.value || '';
    const text = sec.querySelector('[data-text]')?.value.trim() || '';
    // Хеш едет ТОТ, что страница показала. Сервер сверит его с файлом заново: если текст изменился,
    // пока владелец читал, одобрять нечего — он видел не то (I3).
    if (status) artifacts[id] = { status, comment: text, sha256: sec.dataset.hash };
  }
  // Общий комментарий по документу целиком САМ ПО СЕБЕ достаточен для сохранения:
  // «ответов нет, но есть что сказать» — законный исход вычитки.
  const comment = document.getElementById('docComment')?.value.trim() || '';
  if (!Object.keys(answers).length && !Object.keys(artifacts).length && !comment) {
    document.getElementById('status').textContent = 'Ничего не отмечено — нечего сохранять.';
    return;
  }
  saveBtn.disabled = true;
  document.getElementById('status').textContent = 'Записываю…';
  // ⚠️ Внутри этого <script> живут ШАБЛОННЫЕ СТРОКИ — обратная кавычка здесь обрывает всю страницу
  // и роняет модуль синтаксической ошибкой. В комментариях кавычки только «ёлочки».
  const res = await fetch('/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Какой документ отвечают — говорит сама страница: один сервер обслуживает всю пачку.
    body: JSON.stringify({ doc: document.body.dataset.doc, answers, artifacts, comment }),
  });
  const out = await res.json();
  if (out.ok) {
    document.querySelector('.wrap').insertAdjacentHTML('afterbegin',
      '<div class="note ok"><b>Записано.</b> Ответ лёг в три места: сам документ, файл решения и архив. ' +
      'Вкладка закроется сама.</div>');
    document.getElementById('status').textContent = 'готово, закрываю…';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Автозакрытие через 2 секунды: отвеченная страница владельцу больше не нужна.
    // ⚠️ Браузер разрешает window.close() только окну, ОТКРЫТОМУ скриптом, — поэтому страницу
    // поднимаем режимом --app (см. openBrowser). Закрытие всё равно ПОПЫТКА, а не обещание: если
    // браузер её не дал, страница честно превращается в короткое «готово», а не притворяется.
    setTimeout(() => {
      window.close();
      setTimeout(() => {
        document.body.innerHTML =
          '<div class="wrap"><div class="note ok"><b>Записано.</b> ' +
          'Браузер не дал закрыть вкладку сам — закройте её, пожалуйста.</div></div>';
      }, 400);
    }, 2000);
  } else {
    document.getElementById('status').textContent = 'ОШИБКА: ' + (out.error || 'неизвестно');
    saveBtn.disabled = false;
  }
});
</script>
</body></html>`;

  // Порядок важен: HTML-рамки первыми — иначе ссылка на макет успела бы стать картинкой.
  return inlineImages(inlineAudio(inlineHtmlFrames(page)));
}

// ─────────────────────────────────────────────────────────────────────────────
// СИГНАЛ (I5, I6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Зовёт владельца. Вызывается ТОЛЬКО после успешно поднятой страницы (I5) — иначе получается класс
 * «позвали, а показать нечего».
 *
 * 🔴 Грабли №3 регламента: `exit 0` ≠ человек услышал. Системные уведомления Windows глушатся
 * настройками фокуса МОЛЧА и с успешным кодом возврата. Поэтому сигнал идёт звуком через звуковую
 * карту и голосом, а доставка подтверждается ЧЕЛОВЕКОМ — инструмент прямо об этом печатает.
 *
 * 🔔 ЗВУК ЗАФИКСИРОВАН: три писка 880 → 660 → 990 Гц (160/160/260 мс). Не «какой-нибудь бип» на вкус
 * сессии: владелец должен узнавать сигнал контура по звуку, а разные проекты — звучать одинаково.
 * Восходящий третий тон отличает «пришёл вопрос» от тревоги.
 *
 * ⚠️ Текст для запасного тракта едет ФАЙЛОМ, не аргументом командной строки: кириллица в аргументе
 * PowerShell 5.1 превращается в мусор (`AGENT_GUIDE` → «Windows + не-ASCII», EXP-0057).
 */
export async function signal(say, { voice = VOICE, quiet = null } = {}) {
  const now = new Date();
  if (quiet ?? isQuiet(now)) {
    console.log('🔇 Тихие часы (23:00–09:00) — сигнал подавлен. Страница ждёт владельца молча.');
    return { signalled: false, reason: 'тихие часы' };
  }
  // Обход тихих часов виден в логе, а не только в аргументах: звук в доме ночью — это событие,
  // и оно обязано быть объяснимым постфактум.
  if (quiet === false && isQuiet(now)) {
    console.log('🔊 ТИХИЕ ЧАСЫ ОБОЙДЕНЫ по явному флагу --force-signal. Сейчас прозвучит в комнате.');
  }
  if (process.platform !== 'win32') {
    console.log('🔔 (сигнал звуком реализован для Windows; здесь — только текстом)');
    return { signalled: false, reason: 'не Windows' };
  }

  // Разметка в голос не уходит (урок KLAS `bugs/14`): произносится чистый текст.
  const clean = String(say).replace(/[*_`#>[\]()]/g, ' ').replace(/\s+/g, ' ').trim();

  // Три писка — первыми и всегда: они не зависят от настроек уведомлений ОС, которые глушат
  // системные всплывашки МОЛЧА и с успешным кодом возврата (грабли №3 регламента).
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[console]::beep(880,160); [console]::beep(660,160); [console]::beep(990,260);',
    ],
    { stdio: 'ignore', timeout: 8000 },
  );

  const engine = await speak(clean, voice);

  console.log(`🔔 Сигнал подан (три писка + голос: ${engine}).`);
  console.log(
    '   ⚠️ Код возврата этого НЕ доказывает: уведомления и звук глушатся настройками ОС молча.\n' +
      '   Доставка считается подтверждённой только словом человека.',
  );
  return { signalled: true, engine };
}

/** Произносит текст: сначала местный Silero, при неудаче — SAPI. Возвращает имя тракта. */
async function speak(text, voice) {
  if (existsSync(VOICE_TOOL)) {
    const ok = await new Promise((done) => {
      const p = spawn(process.execPath, [VOICE_TOOL, text, '--play', '--voice', voice], {
        stdio: 'ignore',
        windowsHide: true,
      });
      // Код 2 у тракта означает «нечего произносить» — это не поломка (`bugs/06`).
      p.on('exit', (code) => done(code === 0));
      p.on('error', () => done(false));
      setTimeout(() => done(false), 120_000).unref?.();
    });
    if (ok) return `Silero/${voice}`;
    console.log('   (голосовой тракт не ответил — говорю системным голосом)');
  }

  // Запасной путь. Текст едет ФАЙЛОМ, команда — только ASCII (`AGENT_GUIDE` → «Windows + не-ASCII»).
  const sayFile = join(tmpdir(), `klas-review-say-${process.pid}.txt`);
  writeFileSync(sayFile, text, 'utf8');
  const ps = [
    'try {',
    '  Add-Type -AssemblyName System.Speech;',
    '  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `  try { $s.SelectVoice("${SAPI_VOICE.replace(/"/g, '')}") } catch {};`,
    `  $t = [IO.File]::ReadAllText("${sayFile.replace(/\\/g, '\\\\')}", [Text.Encoding]::UTF8);`,
    '  $s.Speak($t);',
    '} catch { }',
  ].join(' ');
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'ignore',
    timeout: 60_000,
  });
  return `SAPI/${SAPI_VOICE}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// КОМАНДЫ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Открывает страницу в браузере — по возможности ОКНОМ-ПРИЛОЖЕНИЕМ (`--app=`).
 *
 * Зачем именно так: браузер разрешает `window.close()` только окну, которое открыл САМ, — обычную
 * вкладку, запущенную через `start`, скрипт закрыть не может, и обещание автозакрытия было бы
 * враньём. Режим `--app` даёт отдельное окно без вкладок и адресной строки, и закрытие в нём работает.
 *
 * Откат честный: не нашли браузера — страница всё равно откроется, просто закрывать придётся рукой,
 * о чём она сама и скажет.
 */
function openBrowser(url) {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const exe = candidates.find((p) => existsSync(p));
  if (exe) {
    spawn(exe, [`--app=${url}`, '--window-size=1100,900'], { detached: true, stdio: 'ignore' }).unref();
    return 'окно-приложение';
  }
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  return 'вкладка браузера по умолчанию';
}

/**
 * Поднимает сервер контура.
 *
 * Один и тот же сервер обслуживает и ОДИН документ (`open`), и ПАЧКУ (`batch`): владелец не должен
 * печатать команды, чтобы перейти от списка накопившегося к самому вопросу — карточка пачки обязана
 * быть ссылкой, а не инструкцией.
 */
function startServer({ docPath = null, index = null, onDecision = null }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // Страница всегда собирается заново: документ мог измениться, пока владелец читал.
      return res.end(index ? index() : buildPage({ docPath, live: true }));
    }
    if (req.method === 'GET' && url.pathname === '/doc') {
      const p = resolve(ROOT, url.searchParams.get('p') ?? '');
      if (!p.startsWith(ROOT) || !existsSync(p)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('нет такого документа');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(buildPage({ docPath: p, live: true }));
    }
    if (req.method === 'POST' && url.pathname === '/decision') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const got = JSON.parse(body);
          const at = new Date().toISOString();
          // Какой документ отвечают, говорит САМА страница (`<body data-doc>`).
          const target = got.doc ? resolve(ROOT, got.doc) : docPath;
          if (!target || !target.startsWith(ROOT) || !existsSync(target)) throw new Error('документ не найден');

          // I3 — одобрение привязано к байтам тела. Сверяем показанный странице хеш с файлом ПРЯМО
          // СЕЙЧАС: если текст успел измениться, владелец одобрял не то, что уйдёт.
          for (const [id, rec] of Object.entries(got.artifacts || {})) {
            const art = artifactsOf(target).find((a) => a.id === id);
            if (!art?.absolute || !existsSync(art.absolute)) throw new Error(`тело артефакта «${id}» пропало`);
            if (rec.sha256 !== bodyHash(art.absolute))
              throw new Error(
                `текст артефакта «${id}» изменился, пока страница была открыта — ` +
                  'перезагрузите её и посмотрите новую редакцию',
              );
          }
          const paths = writeDecision({
            docPath: target,
            kind: parseMeta(readMd(target)).kind,
            by: (got.by || BY).trim() || BY,
            at,
            comment: got.comment,
            answers: got.answers || {},
            artifacts: got.artifacts || {},
          });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, paths }));
          console.log('\n✅ РЕШЕНИЕ ЗАПИСАНО В ТРИ МЕСТА:');
          console.log('   документ: ' + relative(ROOT, paths.md ?? target));
          console.log('   решение:  ' + relative(ROOT, paths.decision));
          console.log('   архив:    ' + relative(ROOT, paths.archive));
          if (onDecision) onDecision(target, server);
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(e.message) }));
        }
      });
      return;
    }
    res.writeHead(404).end('нет');
  });
  return server;
}

/** Поднимает сервер на свободном порту и возвращает адрес. */
async function listen(server) {
  const port = Number(opt('--port', '0'));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/`;
}

/**
 * Гасит контур после записи решения — так, чтобы он ГАРАНТИРОВАННО завершился.
 *
 * 🔴 «СОХРАНИТЬ» БУДИТ АГЕНТА, а агент узнаёт о событии ровно тогда, когда завершается запущенный
 * им процесс. Значит незавершившийся контур = ответ владельца лежит записанным, и за ним никто не
 * приходит.
 *
 * ⚠️ ЧЕСТНО О ПРОИСХОЖДЕНИИ ЭТИХ ДВУХ СТРОК. Ворота сдачи 2026-08-01 показали «контур не
 * завершился», и первым делом сюда легли разрыв соединений и страховочный выход. КОНТРОЛЬНЫЙ ОПЫТ
 * (снял их обратно и перепрогнал) доказал: врал ПРИБОР — он вешал слушателя `exit` уже после
 * выхода процесса, а одного `server.close()` в этом сценарии хватало. Строки оставлены СОЗНАТЕЛЬНО,
 * но как страховка, а не как починенный дефект: `close()` перестаёт принимать НОВЫЕ соединения, но
 * ждёт закрытия уже открытых, а браузер держит keep-alive — и если вкладка не закрылась сама
 * (`window.close()` разрешён не всегда), теоретический путь к зависанию остаётся. Цена страховки —
 * две строки, цена зависания — незамеченный ответ владельца.
 */
function shutdown(server, code = 0) {
  setTimeout(() => {
    server.closeAllConnections?.();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 1500).unref?.();
  }, 2500);
}

/** Открывает ОДИН документ: страница, браузер, сигнал, ожидание ответа. */
async function cmdOpen(docPath) {
  const server = startServer({
    docPath,
    // Сервер одного документа живёт ровно до записи решения: поднялся → записал → умер (`shutdown`).
    onDecision: (_, srv) => shutdown(srv),
  });
  const url = await listen(server);

  const parsed = parseInterview(docPath, readMd(docPath));
  const open = parsed.questions.filter((q) => !q.answered).length;
  console.log(`\nСтраница поднята: ${url}`);
  console.log(`Документ: ${relative(ROOT, docPath)} · ждут ответа: ${open}`);

  if (!flag('--no-open')) openBrowser(url);

  // I5 — сигнал ПОСЛЕ того, как страница поднята и открыта. Не раньше.
  // Намеренно БЕЗ await: синтез речи занимает секунды, а сервер уже слушает — ждать его значило бы
  // держать первый запрос браузера в очереди и показать владельцу пустую вкладку.
  if (!flag('--no-signal')) {
    const { kind, title } = scopeOf(docPath, parseMeta(readMd(docPath)));
    void signal(
      `Николай, вас зовёт ${kind}${title ? `: ${title}` : ''}. ` +
        `${open} ${plural(open, 'вопрос', 'вопроса', 'вопросов')} без ответа.`,
      { quiet: QUIET_OVERRIDE },
    );
  }

  console.log(`\nЖду ответа (до ${TIMEOUT_MIN} мин). Ctrl+C — прекратить, документ не изменится.`);
  setTimeout(() => {
    console.log('\n⏳ Время вышло — страница закрыта, ответов не записано.');
    server.close(() => process.exit(2));
  }, TIMEOUT_MIN * 60_000).unref?.();
  return url;
}

/**
 * Что именно произносит голос: тип документа («интервью», «домашка», «баг») и его название.
 * Тип берётся из метаблока, если он есть, иначе — из директории документа: она и ЕСТЬ скоуп.
 * Из заголовка снимается служебный префикс («Интервью #010 — »): тип уже назван словом, и повторять
 * его — только удлинять речь.
 */
export function scopeOf(docPath, meta) {
  const rel = relative(ROOT, docPath).split('\\').join('/');
  const dirKind = {
    'interviews/': 'интервью',
    'homeworks/': 'домашка',
    'bugs/': 'баг',
    'plans/': 'план',
    'ideas/': 'идея',
    'researches/': 'исследование',
  };
  const byDir = Object.entries(dirKind).find(([p]) => rel.startsWith(p))?.[1] ?? 'документ';
  const kind = meta?.kind === 'outbound' ? 'черновик отправки' : byDir;
  let title = String(meta?.title ?? '').replace(/^[^—:]{0,40}[—:]\s*/u, '').trim();
  if (title.length > 90) title = title.split(/[.:—]/u)[0].trim();
  return { kind, title };
}

/** Сравнение путей без оглядки на регистр и слэши — Windows отдаёт их по-разному. */
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b ?? '').toLowerCase();

const plural = (n, a, b, c) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return a;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return b;
  return c;
};

/** Снимает страницу в файл — самодостаточную и открывающуюся офлайн. */
function cmdRender(docPath) {
  const outDir = join(ROOT, 'test-results', 'owner-reviews');
  mkdirSync(outDir, { recursive: true });
  const out = opt('--out', join(outDir, basename(docPath).replace(/\.md$/, '.html')));
  writeFileSync(out, buildPage({ docPath, live: false }), 'utf8');
  console.log(relative(ROOT, out));
  return out;
}

/** Все документы очереди владельца. Исполняемая команда ритуала, а не украшение. */
export function ownerDocs() {
  const out = [];
  for (const dir of OWNER_DIRS) {
    let files = [];
    try {
      files = readdirSync(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      if (!f.endsWith('.md') || f === 'README.md') continue;
      out.push(`${dir}/${f}`);
    }
  }
  return out;
}

function cmdList() {
  let waiting = 0;
  console.log('\n═══ ЖДЁТ ВЛАДЕЛЬЦА ═══\n');
  for (const rel of ownerDocs()) {
    const p = join(ROOT, rel);
    const iv = parseInterview(p, readMd(p));
    if (!iv.waiting) continue;
    waiting++;
    const open = iv.questions.filter((q) => !q.answered);
    console.log(`  🟡 ${rel}`);
    console.log(`     ${iv.status ?? '(нет строки «Статус:»)'}`);
    for (const q of open) console.log(`     ⛔ ${q.title}`);
    console.log(`     открыть: node tools/review.mjs open ${rel}\n`);
  }
  if (!waiting) console.log('  ✅ ни одного — очередь владельца пуста.\n');
  return waiting;
}

/**
 * Ставит документ в очередь (I7). Автономный цикл НИКОГДА не стоит у открытой страницы: он паркует
 * документ и идёт к следующей незаблокированной работе, а зовут владельца один раз на пачку.
 */
function cmdQueue(docPath) {
  mkdirSync(DECISIONS_DIR, { recursive: true });
  const rel = relative(ROOT, docPath).split('\\').join('/');
  const q = existsSync(QUEUE_FILE) ? JSON.parse(readFileSync(QUEUE_FILE, 'utf8')) : { items: [] };
  if (!q.items.some((i) => i.doc === rel)) {
    q.items.push({ doc: rel, поставлен: new Date().toISOString() });
    writeFileSync(QUEUE_FILE, JSON.stringify(q, null, '\t') + '\n', 'utf8');
    console.log(`В очередь: ${rel} (всего накоплено: ${q.items.length})`);
  } else {
    console.log(`Уже в очереди: ${rel} (всего накоплено: ${q.items.length})`);
  }
  return q.items.length;
}

/** Одна страница «накопилось N» — карточка на документ, сигнал ОДИН раз на пачку (I7). */
async function cmdBatch() {
  const q = existsSync(QUEUE_FILE) ? JSON.parse(readFileSync(QUEUE_FILE, 'utf8')) : { items: [] };
  // Из очереди выпадает всё, на что владелец уже ответил — иначе пачка растёт вечно.
  const live = q.items.filter((i) => {
    const p = join(ROOT, i.doc);
    return existsSync(p) && parseInterview(p, readMd(p)).waiting;
  });
  if (!live.length) {
    console.log('Очередь пуста — звать владельца незачем.');
    return 0;
  }

  /**
   * Страница пачки. 🔑 Карточка — ССЫЛКА, а не инструкция: владелец не должен печатать команду,
   * чтобы перейти от списка к вопросу. Печатать на карточке `node tools/review.mjs open …` — тот же
   * порок «расскажу вместо сделаю», ради устранения которого контур и строился.
   */
  const batchPage = () => {
    // Счётчики по ВСЕЙ пачке — чтобы владелец видел объём до того, как откроет первую карточку.
    let totalOpen = 0;
    let totalDone = 0;
    for (const i of live) {
      const iv = parseInterview(join(ROOT, i.doc), readMd(join(ROOT, i.doc)));
      totalOpen += iv.questions.filter((x) => !x.answered).length;
      totalDone += iv.questions.filter((x) => x.answered).length;
    }
    const cards = live
      .map((i) => {
        const p = join(ROOT, i.doc);
        const meta = parseMeta(readMd(p));
        const iv = parseInterview(p, readMd(p));
        const open = iv.questions.filter((x) => !x.answered);
        const { kind } = scopeOf(p, meta);
        return `<a class="q card-link ${open.length ? 'open' : 'done'}" href="/doc?p=${encodeURIComponent(i.doc)}">
        <div class="qhead"><span class="tag ${open.length ? 'open' : 'ok'}">${open.length ? 'ждёт вас' : 'отвечено'}</span>
        <h3 style="margin:0">${esc(meta.title)}</h3></div>
        <p class="meta">${esc(kind)} · ${esc(i.doc)} · без ответа: ${open.length} из ${iv.questions.length}
          · в очереди с ${esc(String(i.поставлен).slice(0, 10))}</p>
        ${open.length ? '<ul>' + open.map((x) => `<li>${esc(x.title)}</li>`).join('') + '</ul>' : ''}
      </a>`;
      })
      .join('\n');

    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Накопилось: ${live.length}</title><style>${STYLE}
a.card-link{display:block;text-decoration:none;color:inherit}
a.card-link:hover{border-color:var(--accent)}
</style></head><body><div class="wrap">
<header class="top">
<p class="asks">Спрашивает ИИ-агент <b>${esc(PROJECT)}</b> · ${esc(stamp())}</p>
<h1>Накопилось ${live.length} ${plural(live.length, 'документ', 'документа', 'документов')}</h1>
<div class="pills"><span class="pill open">ждут вас: ${totalOpen}</span><span class="pill ok">отвечено: ${totalDone}</span></div>
<div class="meta">Пока вы были заняты, агент работал и складывал сюда всё, что решать не вправе.
Нажмите карточку — откроется сам документ.</div>
</header>${cards}</div></body></html>`;
  };

  // `--no-serve` — снять пачку в файл и выйти. Нужен не для красоты: без него команда НИКОГДА не
  // завершается (сервер живёт до срока), и всякий, кто зовёт её синхронно, виснет намертво.
  if (flag('--no-serve')) {
    const outDir = join(ROOT, 'test-results', 'owner-reviews');
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, 'batch.html');
    writeFileSync(out, batchPage(), 'utf8');
    console.log(`Пачка собрана в файл: ${relative(ROOT, out)} (${live.length})`);
    return 0;
  }

  /**
   * 🔑 «СОХРАНИТЬ» БУДИТ АГЕНТА. Агент узнаёт о событии, когда ЗАВЕРШАЕТСЯ запущенный им процесс.
   * Значит контур обязан завершиться сразу после записи решения — иначе ответ лежит записанным, а
   * за ним никто не приходит. Правило одинаково для одиночного документа и для пачки: ЛЮБОЕ
   * сохранение закрывает контур. Осталось неотвеченное — это забота АГЕНТА поднять страницу заново,
   * а не владельца держать вкладку открытой.
   */
  const server = startServer({
    index: batchPage,
    onDecision: (target, srv) => {
      const rest = live.filter((i) => {
        const p = join(ROOT, i.doc);
        return existsSync(p) && !samePath(p, target) && parseInterview(p, readMd(p)).waiting;
      });
      console.log(
        rest.length
          ? `\n📌 Осталось ждать владельца: ${rest.length} — подними пачку заново.`
          : '\n✅ Очередь пуста.',
      );
      shutdown(srv);
    },
  });
  const url = await listen(server);
  console.log(`Пачка поднята: ${url} (${live.length})`);
  setTimeout(() => {
    console.log('\n⏳ Время вышло — страница пачки закрыта.');
    server.close(() => process.exit(0));
  }, TIMEOUT_MIN * 60_000).unref?.();

  if (!flag('--no-open')) openBrowser(url);
  // Здесь await обязателен: команда `batch` завершается сразу, и без ожидания процесс умер бы
  // раньше, чем синтезатор успел открыть рот.
  if (!flag('--no-signal')) {
    // Пачка называет, ЧЕМ она набрана: «два интервью и домашка» полезнее, чем «три документа», —
    // по этому и решают, идти сейчас или после дела.
    const kinds = live.map((i) => scopeOf(join(ROOT, i.doc), parseMeta(readMd(join(ROOT, i.doc)))).kind);
    await signal(
      `Николай, накопилось ${live.length} ${plural(live.length, 'документ', 'документа', 'документов')} ` +
        `на вашу вычитку: ${[...new Set(kinds)].join(', ')}.`,
      { quiet: QUIET_OVERRIDE },
    );
  }
  console.log(`\nЖду ответов (до ${TIMEOUT_MIN} мин). Ctrl+C — прекратить, документы не изменятся.`);
  // null означает «сервер жив»: процесс не завершается, иначе страница умрёт вместе с ним.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

function usage() {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, ''),
  );
}

async function main() {
  if (flag('--selftest')) {
    const fails = selftest();
    console.log(fails.length ? '🔴 ПРОВАЛЫ:\n  ' + fails.join('\n  ') : '✅ самотест ядра контура чист');
    return fails.length ? 1 : 0;
  }
  const [cmd, arg] = positional;
  const docPath = arg ? resolve(ROOT, arg) : null;
  if (docPath && !existsSync(docPath)) {
    console.error(`Нет такого документа: ${arg}`);
    return 1;
  }

  switch (cmd) {
    case 'open':
      if (!docPath) return usage(), 1;
      await cmdOpen(docPath);
      return null; // сервер жив, выход произойдёт после записи решения
    case 'render':
      if (!docPath) return usage(), 1;
      cmdRender(docPath);
      return 0;
    case 'list':
      cmdList();
      return 0;
    case 'queue':
      if (!docPath) return usage(), 1;
      cmdQueue(docPath);
      return 0;
    case 'batch':
      return await cmdBatch();
    default:
      usage();
      return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = await main();
  if (code !== null) process.exit(code);
}
