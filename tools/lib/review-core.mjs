/**
 * review-core.mjs — ЯДРО КОНТУРА ВЫЧИТКИ ВЛАДЕЛЬЦА (страницы вопросов и ответов).
 *
 * Регламент — `.claude/skills/owner-reviews/SKILL.md` (инварианты I1–I7, порядок сборки, реестр
 * граблей). Жёсткое правило, поверх которого стоит контур, — `AGENT_GUIDE.md`: всё, чего агент хочет
 * ОТ владельца, живёт только в `interviews/` и `homeworks/`. HTML — не цель, а ТРАНСПОРТ; цель —
 * охранник. Сила ответа от транспорта не зависит: **HTML = md = чат**.
 *
 * 🔴 ПОЧЕМУ МОДУЛЬ ОДИН — САМЫЕ ДОРОГИЕ ГРАБЛИ РЕГЛАМЕНТА (№1). Дословно:
 *   «the page hashing file bytes while the sender hashed normalized text (trailing \n stripped);
 *    both self-tests green, the gate would refuse every artifact always.»
 * Две реализации расходятся МОЛЧА, оба самотеста при этом зелёные. Поэтому здесь объявлены
 * единственным контрактом и нормализация текста, и разбор документа, и СЕМАНТИКА СТАТУСА
 * («ждёт владельца» / «отвечено») — её же импортирует охранник `tools/owner-questions.mjs`.
 * Разойдись они, и владелец увидел бы «очередь пуста» рядом с документом «🟡 ждёт ответов».
 *
 * Инварианты, которые держит этот модуль:
 *   I1 — md источник, HTML производное (страница собирается отсюда и НИКОГДА не правится руками);
 *   I2 — решение пишется в ТРИ места, имя файла решения ПРОИЗВОДНО от пути документа;
 *   I3 — одобрение привязано к SHA-256 ТЕЛА при согласованной нормализации;
 *   I4 — гейт отправки fail-closed (`checkApproval` — единственная его реализация);
 *   I6 — тихие часы ПЕРЕСЕКАЮТ полночь.
 *
 * Происхождение: дистиллировано из обкатанного контура соседнего проекта NDim (`tools/review.mjs`,
 * `plans/27`), где владелец им реально пользовался и оплатил список дефектов. Ниже они помечены 🔴 —
 * это не теория, а уже выставленные счета. Переоткрывать их запрещено.
 *
 * [TESTED: 2026-08-01 · самотест ядра + пилот по всем живым документам `interviews/` и `homeworks/`]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DECISIONS_DIR = join(ROOT, 'interviews', 'decisions');
export const ARCHIVE_DIR = join(DECISIONS_DIR, 'archive');
export const QUEUE_FILE = join(DECISIONS_DIR, 'queue.json');
/** Директории «места вопросов» (`AGENT_GUIDE.md`). Один список на охранник и на контур. */
export const OWNER_DIRS = ['interviews', 'homeworks'];

// ─────────────────────────────────────────────────────────────────────────────
// КОНТРАКТ НОРМАЛИЗАЦИИ И ХЕША (I3) — ЕДИНСТВЕННЫЙ на весь контур
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Нормализация текста перед хешированием. Ровно четыре шага, в этом порядке:
 *   1) снять BOM (Windows-редакторы его ставят, git — нет);
 *   2) CRLF и CR → LF (машина Windows, `core.autocrlf=true` — `AGENT_GUIDE` → «Сборка»);
 *   3) снять пробельный хвост в конце файла;
 *   4) поставить ровно один завершающий перевод строки.
 * Менять этот список — значит обнулить ВСЕ выданные одобрения. Это осознанная операция.
 */
export function normalizeText(input) {
  return String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n';
}

/** SHA-256 нормализованного текста. Одна функция на страницу и на гейт. */
export function textHash(input) {
  return createHash('sha256').update(normalizeText(input), 'utf8').digest('hex');
}

/** SHA-256 тела, лежащего файлом. Читает БАЙТЫ и гонит их через ту же нормализацию. */
export function bodyHash(path) {
  return textHash(readFileSync(path, 'utf8'));
}

/** Чтение markdown с нормализацией переводов строк (для разбора, не для хеша). */
export function readMd(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// СЕМАНТИКА СТАТУСА — общая с охранником `tools/owner-questions.mjs`
// ─────────────────────────────────────────────────────────────────────────────

// Строка статуса — единственный АВТОРИТЕТНЫЙ признак «ждёт / отвечено». Пустые «Ответ:» вторичны:
// владелец вправе ответить словами в чате, и тогда агент обязан перенести ответ в файл.
// ⚠️ Статус ищется ГДЕ УГОДНО в строке, а не только с её начала: в `homeworks/01` он стоит внутри
// абзаца. Придирался парсер, а не документ, — угадывать состояние документов владельца агент не вправе.
// ⚠️ ДВОЕТОЧИЕ ОБЯЗАТЕЛЬНО И СТОИТ ВПЛОТНУЮ к слову (между ними разрешена только разметка `**`).
// Это и есть признак, отличающий УТВЕРЖДЕНИЕ о статусе от постороннего упоминания слова: живые
// формы KLAS — `Статус: …`, `**Статус:** …`, `Статус: **…**` — все с двоеточием вплотную, а
// поле-подсказка `**→ Статус (телефон в tailnet? …):**` и заголовок таблицы `| Статус |` — без него.
// Прежняя редакция с необязательным `:?` принимала подсказку за статус документа (см. `findStatus`).
export const STATUS_RE = /\*{0,2}Статус\*{0,2}:\*{0,2}[ \t]*(.+)$/m;
export const ANSWERED_RE = /✅|ОТВЕЧЕНО|ОТВЕТЫ ПОЛУЧЕНЫ|ПРОЙДЕНА|ЗАКРЫТО/i;
export const WAITING_RE = /❓|🟡|🟢|🔴|ЖДЁТ|ЖДУТ|ОЖИДАЕТ|ОЖИДА/i;

/** Разметка, снятая для СМЫСЛОВЫХ сравнений (пустой ли хвост, что печатать в консоль). */
const stripMd = (s) => String(s).replace(/[*_`~]/g, '').trim();

/**
 * Ищет строку статуса документа.
 *
 * 🔴 СТАТУС — ЭТО УТВЕРЖДЕНИЕ, А НЕ ПУСТОЕ ПОЛЕ ПОД ЗАПОЛНЕНИЕ. Строка засчитывается, только если
 * после «Статус:» осталось что-то ОСМЫСЛЕННОЕ (не одна разметка). Иначе идём к следующей строке.
 *
 * Найдено ПИЛОТОМ по живым документам 2026-08-01. `homeworks/02_voice_and_android_tests.md` не имеет
 * статуса вовсе, зато содержит поле-подсказку `**→ Статус (телефон в tailnet? …):**` — и первая
 * редакция принимала ЕГО за статус документа. Цена дефекта была двойной и обе половины тихие:
 *   · в шапку страницы протекала непарная `**` (косметика — её и увидел прибор);
 *   · документ становился НИ «ждёт», НИ «отвечено» и МОЛЧА ВЫПАДАЛ из очереди владельца, при этом
 *     не попадая и в предупреждение «нет строки Статус» — то есть домашка, просящая у владельца
 *     результаты, была невидима для всех приборов сразу.
 * Правило «ищем где угодно в строке» при этом СОХРАНЕНО: в `homeworks/01` статус живёт в середине
 * абзаца, и придираться к документам владельца прибор не вправе.
 */
export function findStatus(text) {
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    const m = STATUS_RE.exec(line);
    if (!m) continue;
    if (!stripMd(m[1])) continue; // поле под заполнение — не статус
    // Непарные `**` в хвосте обрываются: страница рендерит эту строку markdown-ом, и одинокая
    // звёздочка утащила бы за собой остаток шапки.
    let raw = m[0].replace(/^[>\s]+/u, '').trim();
    if ((raw.match(/\*\*/g) || []).length % 2 === 1) raw = raw.replace(/\*\*(?=[^*]*$)/, '');
    return { raw, text: stripMd(m[1]).replace(/\s+/g, ' '), line: i };
  }
  return null;
}

// ⚠️ ОТВЕТ ЗАПИСЫВАЕТСЯ ТРЕМЯ СПОСОБАМИ, и охранник обязан знать все три. Первая редакция знала
// один и дважды покраснела на ИСПРАВНЫХ документах: `interview_006` отвечен ТАБЛИЦЕЙ решений внизу,
// `homeworks/04` — разделом с ВЕРДИКТОМ владельца. Охранник, кричащий на правильном, быстро научает
// себя игнорировать (грабли №5 регламента), поэтому оба случая стали фикстурами самопроверки.
const ANSWER_LINE_RE = /^\*{0,2}Ответ[^:\n]{0,40}:\*{0,2}(.*)$/;
const DECISION_ROW_RE = /^\|(?!\s*-{2,})[^|\n]+\|[^|\n]*\|/gm;
const VERDICT_RE = /^#{1,4}\s*.*(Вердикт|Ответ владельца|Решени)/mi;

/** Заполнена ли строка ответа. ⚠️ Считаем ПОСТРОЧНО, а не одной регуляркой: жадная версия пятилась
 *  и принимала вторую звёздочку в «**Ответ:**» за текст ответа — пустое выглядело заполненным.
 *  Разметка (звёздочки, подчерки, кавычки) текстом не считается. */
export function countAnswers(text) {
  let filled = 0;
  let empty = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(ANSWER_LINE_RE);
    if (!m) continue;
    if (m[1].replace(/[*_`~\s]/g, '')) filled++; else empty++;
  }
  return { filled, empty };
}

/** Разбор ОДНОГО документа очереди владельца. Чистая функция — её же гоняет самопроверка охранника. */
export function parseDoc(name, text) {
  const found = findStatus(text);
  const status = found ? found.text.slice(0, 90) : null;
  const answered = status ? ANSWERED_RE.test(status) : false;
  const waiting = status ? WAITING_RE.test(status) && !answered : !status;
  const { filled, empty: emptyAnswers } = countAnswers(text);
  // Свидетельство ответа — любое из трёх: заполненная строка «Ответ:», таблица решений, раздел с
  // вердиктом владельца. Ноль свидетельств при статусе «отвечено» и есть настоящее расхождение.
  const decisionsPart = text.split(/^#{1,4}\s*.*(?:Решени|Вердикт)/m)[1] || '';
  const decisionRows = (decisionsPart.match(DECISION_ROW_RE) || []).length;
  const hasVerdict = VERDICT_RE.test(text) && decisionsPart.replace(/\s/g, '').length > 40;
  const evidence = filled + decisionRows + (hasVerdict ? 1 : 0);
  return {
    name,
    status,
    answered,
    waiting,
    emptyAnswers,
    evidence,
    // Расхождение: сказано «отвечено», а свидетельств ответа в документе НЕТ ВООБЩЕ. Значит ответ
    // прозвучал в чате и потерян для будущего — это провал АГЕНТА, а не терпения владельца.
    drift: answered && evidence === 0,
    // Нет строки статуса вовсе — документ не встроен в конвенцию, и его никто не заметит.
    noStatus: !status,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// КОНТРАКТ ИМЁН — метаблок документа
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Мини-разбор YAML-метаблока в шапке документа. Поддержан ровно тот срез, что описан контрактом
 * имён регламента: скаляры и список `artifacts` из отображений.
 *
 * ⚠️ Метаблок НЕОБЯЗАТЕЛЕН. Все живые интервью KLAS написаны без него, и требовать его значило бы
 * переписать документы владельца ради инструмента — прямо против I1 («md — источник»).
 * Нет блока → `kind: interview`, заголовок берётся из первого `# `.
 */
export function parseMeta(text) {
  const m = /^```ya?ml\n([\s\S]*?)\n```/u.exec(text);
  const meta = { kind: 'interview', title: null, artifacts: [] };
  if (m) {
    let current = null;
    for (const line of m[1].split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const item = /^\s*-\s*(.*)$/u.exec(line);
      if (item && current === 'artifacts') {
        meta.artifacts.push(parseInline(item[1]));
        continue;
      }
      const kv = /^(\w+):\s*(.*)$/u.exec(line);
      if (!kv) continue;
      current = kv[1];
      if (kv[2].trim()) meta[kv[1]] = strip(kv[2]);
    }
  }
  if (!meta.title) {
    const h = /^#\s+(.+)$/mu.exec(text);
    meta.title = h ? h[1].trim() : 'Документ';
  }
  return meta;
}

const strip = (s) => s.trim().replace(/^["']|["']$/g, '');

/** Разбор строки вида `{id: a1, target: "GitHub · repo", body_file: drafts/a1.md}`. */
function parseInline(s) {
  const out = {};
  const inner = s.trim().replace(/^\{|\}$/g, '');
  for (const part of inner.split(/,(?![^"']*["'][^"']*$)/u)) {
    const kv = /^\s*(\w+)\s*:\s*(.*)$/u.exec(part);
    if (kv) out[kv[1]] = strip(kv[2]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// РАЗБОР ИНТЕРВЬЮ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Заголовок вопроса: `## Q1.`, `### Q3.`, `### В1)` — буква(ы) + номер + точка или скобка.
 * KLAS пишет вопросы латинской `Q` и на ДВУХ уровнях заголовка (`##` и `###`) — покрыты оба.
 */
const Q_HEADING = /^#{2,4}\s*(?<label>[\p{Lu}]{1,2}\d+)\s*[.．)]/u;
const ANSWER_FIELD = /\*\*Ответ(?<note>[^*]*?):?\*\*:?/u;
/**
 * 🔴 ПОЛЕ, ПОДПИСАННОЕ КАК ВСТРЕЧНЫЙ ВОПРОС, — НЕ ОТВЕТ.
 * Поймано в NDim на живом документе: поле подписано «**Ответ (вопрос владельца):**», внутри —
 * встречный вопрос владельца агенту, а сама развилка НЕ выбрана. Формально поле непустое, и
 * страница показывала «ждут ответа: 0» на единственном блокирующем вопросе волны.
 */
const COUNTER_QUESTION = /вопрос/iu;
/**
 * Вариант ответа: `- **A) (рекомендую)** текст` — буква латиницей или кириллицей.
 *
 * 🔴 РАЗБОР ОБЯЗАН БЫТЬ МНОГОСТРОЧНЫМ. Первая редакция NDim искала закрывающие `**` в ТОЙ ЖЕ
 * строке — и вариант, чей жирный заголовок перенесён на вторую строку, просто ИСЧЕЗАЛ со страницы.
 * Поймал это владелец: из четырёх вариантов кликабельными оказались три, а пропал ровно тот, что
 * рекомендован. Молчаливая потеря варианта — худший дефект этого контура: страница выглядит
 * исправной, владелец выбирает из того, что ВИДИТ, и решение принимается по УРЕЗАННОМУ списку.
 * Поэтому ниже не только починка, но и счётная проверка в `tools/verify-owner-reviews.mjs`:
 * число строк-кандидатов обязано совпасть с числом разобранных вариантов у КАЖДОГО вопроса ВСЕХ
 * живых документов. В KLAS это правило особенно жёсткое: варианты здесь многострочные почти всегда.
 */
const OPTION_START = /^\s*[-*]\s+\*\*(?<letter>[\p{Lu}])\)/u;
const OPTION_FULL = /\*\*(?<letter>[\p{Lu}])\)\s*(?<label>[\s\S]*?)\*\*(?<rest>[\s\S]*)/u;
/** Продолжение пункта списка: отступ, не новый пункт, не пусто. */
const LIST_CONT = /^\s{2,}\S/u;

/**
 * Разбирает документ в структуру, пригодную и для охранника, и для страницы.
 * Каждый вопрос: метка, заголовок, варианты, текст ответа, границы блока.
 */
export function parseInterview(relPath, text) {
  const lines = text.split('\n');
  const questions = [];

  let current = null;
  const close = (endLine) => {
    if (current) {
      current.endLine = endLine;
      questions.push(current);
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = Q_HEADING.exec(line);
    if (h) {
      close(i);
      current = {
        label: h.groups.label,
        title: line.replace(/^#+\s*/u, '').trim(),
        startLine: i,
        answerLine: -1,
        options: [],
        optionLines: 0,
        optionSpans: [],
        answer: '',
      };
      continue;
    }
    // Блок вопроса закрывает заголовок 1–2 уровня ИЛИ горизонтальная линейка.
    // 🔴 Линейку добавил ПИЛОТ на живых данных, а не фикстура: без неё `---`, стоящая после пустого
    // поля «**Ответ:**», попадала В ОТВЕТ и делала пустой вопрос «отвеченным». Симптом мягкий и
    // потому опасный — контур объявил бы закрытым любой открытый вопрос. В KLAS документы разделены
    // именно линейками (`interview_010`), так что без этой строки инструмент был бы бесполезен.
    if (/^#{1,2}\s/u.test(line) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      close(i);
      continue;
    }
    if (!current) continue;

    if (OPTION_START.test(line) && current.answerLine < 0) {
      current.optionLines += 1;
      // Собираем пункт ЦЕЛИКОМ: сам маркер плюс его продолжения с отступом. Жирный заголовок
      // варианта запросто переносится на вторую строку — на этом контур уже обжёгся.
      let chunk = line;
      let last = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (!LIST_CONT.test(lines[j]) || OPTION_START.test(lines[j])) break;
        if (/^\s*[-*]\s/u.test(lines[j])) break;
        chunk += ' ' + lines[j].trim();
        last = j;
      }
      // Границы пункта в исходных строках. Нужны СТРАНИЦЕ: она рисует варианты кликабельными
      // карточками, и если те же строки останутся в теле вопроса, владелец увидит список ДВАЖДЫ —
      // один раз как текст, другой как выбор, и не поймёт, что из этого кликается.
      // Поймано ГЛАЗАМИ на кадре страницы, а не проверкой (тот же класс, что «тёмное на тёмном»).
      current.optionSpans.push([i, last]);
      const o = OPTION_FULL.exec(chunk);
      if (o) {
        current.options.push({
          letter: o.groups.letter,
          label: (o.groups.label + ' ' + o.groups.rest).trim().replace(/\s+/g, ' ').slice(0, 300),
        });
      }
    }
    const field = current.answerLine < 0 ? ANSWER_FIELD.exec(line) : null;
    if (field) {
      current.answerLine = i;
      // Поле-встречный-вопрос считается ПУСТЫМ: развилка не выбрана, вопрос жив.
      current.counterQuestion = COUNTER_QUESTION.test(field.groups.note ?? '');
      current.answer += line.replace(ANSWER_FIELD, '').trim() + '\n';
      continue;
    }
    if (current.answerLine >= 0) current.answer += line + '\n';
  }
  close(lines.length);

  for (const q of questions) {
    q.answer = q.answer.trim();
    q.answered = q.answerLine >= 0 && q.answer.length > 0 && !q.counterQuestion;
  }

  // Две формы одной строки статуса: `statusRaw` сохраняет markdown (её рендерит страница),
  // `status` — чистый текст для консоли. Общий strip срезал бы `>` вместе с `**`, и на странице
  // протекало бы «Статус:** 🟡 …» — поймано в NDim ГЛАЗАМИ на кадре, а не проверкой.
  const found = findStatus(text);
  const statusRaw = found ? found.raw : null;
  const status = found ? found.text : null;
  // 🔑 Истина о том, закрыт документ или нет, — СТАТУС, а не заполненность полей: судить по полям
  // значило бы объявлять закрытым вопрос, где владелец задал встречный вопрос вместо выбора.
  // Семантика — общая с охранником `owner-questions.mjs` (см. `parseDoc` выше), одна на весь контур.
  const doc = parseDoc(relPath, text);
  return {
    file: relPath,
    status,
    statusRaw,
    statusLine: found ? found.line : -1,
    waiting: doc.waiting,
    answeredDoc: doc.answered,
    drift: doc.drift,
    // 🔴 ВТОРОЕ РАСХОЖДЕНИЕ, ЗЕРКАЛЬНОЕ `drift`: статус кричит «ждёт владельца», а ответы на месте —
    // ВСЕ. Значит владелец давно ответил, а агент не обновил шапку, и каждая следующая сессия с
    // пустым контекстом продолжает ждать его впустую. Это долг АГЕНТА, а не терпение владельца.
    // Найдено ПИЛОТОМ этого контура на живом дереве KLAS в первый же прогон: `interview_002`
    // (отвечен 2026-07-03) и `interview_007` (отвечен владельцем 2026-07-29) месяцами числились
    // «🟡 ЖДЁТ ОТВЕТОВ ВЛАДЕЛЬЦА» при полностью заполненных полях. Ровно то же и в тот же день
    // нашёл контур соседнего проекта — значит это КЛАСС, а не случайность.
    // Условие намеренно узкое (есть вопросы И отвечены все): ложная тревога в охраннике хуже
    // пропуска — она учит его игнорировать (грабли №5 регламента).
    staleWaiting: doc.waiting && questions.length > 0 && questions.every((q) => q.answered),
    questions,
    lines,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKDOWN → HTML (мини-рендерер, ноль зависимостей)
// ─────────────────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Строчные преобразования: код, жирный, курсив, ссылки, зачёркнутое. */
export function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

/**
 * Markdown → HTML. Покрывает то, чем реально написаны документы KLAS: заголовки, списки, таблицы,
 * цитаты, ограждённый код, горизонтальные линии, абзацы.
 * Сознательно НЕ покрывает: вложенные списки глубже одного уровня, сноски, сырой HTML внутри.
 */
export function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let inCode = false;
  let listType = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Ограждённый код — отдаётся дословно
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      if (!inCode) {
        out.push('<pre><code>');
        inCode = true;
      } else {
        out.push('</code></pre>');
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      i++;
      continue;
    }

    // Таблица: строка с | и следующая — разделитель
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flushPara();
      flushList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      out.push('<div class="tw"><table><thead><tr>');
      for (const c of cells(line)) out.push(`<th>${c}</th>`);
      out.push('</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        out.push('<tr>');
        for (const c of cells(lines[i])) out.push(`<td>${c}</td>`);
        out.push('</tr>');
        i++;
      }
      out.push('</tbody></table></div>');
      continue;
    }

    // Заголовок
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }

    // Горизонтальная линия
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push('<hr>');
      i++;
      continue;
    }

    // Цитата (собирается блоком и рендерится рекурсивно)
    if (/^\s*>/.test(line)) {
      flushPara();
      flushList();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // Список
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const want = /^\d/.test(li[1]) ? 'ol' : 'ul';
      if (listType !== want) {
        flushList();
        out.push(`<${want}>`);
        listType = want;
      }
      // Продолжения пункта (отступ) приклеиваются к нему же
      let item = li[2];
      while (
        i + 1 < lines.length &&
        /^\s{2,}\S/.test(lines[i + 1]) &&
        !/^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1])
      ) {
        item += ' ' + lines[i + 1].trim();
        i++;
      }
      out.push(`<li>${inline(item)}</li>`);
      i++;
      continue;
    }

    // Пустая строка
    if (!line.trim()) {
      flushPara();
      flushList();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  flushList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// РЕШЕНИЯ (I2) — три места
// ─────────────────────────────────────────────────────────────────────────────

/**
 * База имени решения. ПРОИЗВОДНА ОТ ПУТИ, а не от одного лишь имени файла (I2): в KLAS вопросы
 * живут в ДВУХ директориях (`interviews/` и `homeworks/`), и общий файл решения затирал бы чужое.
 */
export const docBase = (docPath) =>
  relative(ROOT, docPath).split(/[\\/]/).join('__').replace(/\.md$/u, '');

/** Путь файла решения. */
export const decisionPath = (docPath) => join(DECISIONS_DIR, `${docBase(docPath)}.decision.json`);

/** Читает решение, если оно есть. Ошибка чтения = «решения нет» (гейт fail-closed сам решит). */
export function readDecision(docPath) {
  const p = decisionPath(docPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Записывает решение в ТРИ места (I2):
 *   1) обратно в исходный md — его читает следующая сессия с пустым контекстом;
 *   2) `<база>.decision.json` — машинная проверка до отправки;
 *   3) копия в архив с `by` и `at` — именно это делает архив читаемым месяцы спустя.
 * Возвращает список путей, которых коснулись.
 */
export function writeDecision({ docPath, kind, by, at, comment, answers = {}, artifacts = {} }) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const record = {
    kind,
    document: relative(ROOT, docPath).split('\\').join('/'),
    by,
    at,
    comment: comment || '',
    ...(Object.keys(answers).length ? { answers } : {}),
    ...(Object.keys(artifacts).length ? { artifacts } : {}),
  };

  // (1) — обратно в md: ответы по вопросам и общий комментарий по документу
  const touchedMd = applyAnswersToMd(docPath, answers, by, at) ?? (comment ? docPath : null);
  if (comment && comment.trim()) appendDocComment(docPath, comment.trim(), by, at);

  // (2) — файл решения рядом, имя производно от пути документа
  const prev = readDecision(docPath);
  const merged = prev
    ? {
        ...record,
        answers: { ...(prev.answers ?? {}), ...answers },
        artifacts: { ...(prev.artifacts ?? {}), ...artifacts },
        история: [...(prev.история ?? []), { by: prev.by, at: prev.at }],
      }
    : record;
  writeFileSync(decisionPath(docPath), JSON.stringify(merged, null, '\t') + '\n', 'utf8');

  // (3) — копия в архив, никогда не перезаписывается
  const stamp = at.replace(/[:.]/g, '-');
  const archive = join(ARCHIVE_DIR, `${docBase(docPath)}--${stamp}.json`);
  writeFileSync(archive, JSON.stringify(record, null, '\t') + '\n', 'utf8');

  return { md: touchedMd, decision: decisionPath(docPath), archive };
}

/**
 * Дописывает общий комментарий по документу в КОНЕЦ md.
 *
 * Почему в конец, а не в шапку: шапку пишет агент, и она отвечает на вопрос «о чём это».
 * Комментарий владельца — реакция НА ПРОЧИТАННОЕ, её место после текста. Каждый приезд — отдельный
 * блок с датой: комментарии копятся, а не затирают друг друга.
 */
export function appendDocComment(docPath, comment, by, at) {
  const raw = readFileSync(docPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/^\uFEFF/, '').replace(/\s+$/, '').split(/\r?\n/);
  lines.push(
    '',
    '---',
    '',
    `## 💬 Комментарий владельца — ${at.slice(0, 10)}`,
    '',
    ...comment.split(/\r?\n/),
    '',
    `<!-- owner-review: by="${by}" at="${at}" транспорт=страница вид=общий-комментарий -->`,
  );
  writeFileSync(docPath, lines.join(eol) + eol, 'utf8');
  return docPath;
}

/**
 * Вписывает ответы в исходный md.
 *
 * 🔴 Правило неприкосновенности первоисточника (`AGENT_GUIDE.md`, пункт 18 чек-листа): УЖЕ
 * НАПИСАННЫЙ владельцем ответ не перезаписывается НИКОГДА. Новый текст приходит отдельным
 * полем-уточнением с датой, старый остаётся дословно.
 */
export function applyAnswersToMd(docPath, answers, by, at) {
  if (!Object.keys(answers).length) return null;
  const raw = readFileSync(docPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const parsed = parseInterview(docPath, lines.join('\n'));

  // Идём СНИЗУ ВВЕРХ: вставки не сдвигают ещё не обработанные номера строк.
  const targets = parsed.questions
    .filter((q) => answers[q.label])
    .sort((a, b) => b.startLine - a.startLine);

  for (const q of targets) {
    const a = answers[q.label];
    const parts = [];
    if (a.choice) parts.push(`**${a.choice}**`);
    if (a.text && a.text.trim()) parts.push(a.text.trim());
    const body = parts.join(' — ') || '—';
    const mark = `<!-- owner-review: by="${by}" at="${at}" транспорт=страница -->`;

    if (!q.answered && q.answerLine >= 0) {
      // Поле пустое — заполняем его же.
      lines[q.answerLine] = `**Ответ:** ${body}`;
      lines.splice(q.answerLine + 1, 0, mark);
    } else {
      // Ответ уже есть (или поля нет вовсе) — дописываем уточнение, ничего не затирая.
      lines.splice(q.endLine, 0, '', `**Ответ (уточнение ${at.slice(0, 10)}):** ${body}`, mark);
    }
    if (a.comment && a.comment.trim()) {
      const idx = lines.indexOf(mark);
      lines.splice(idx, 0, `> ${a.comment.trim()}`);
    }
  }
  writeFileSync(docPath, lines.join(eol), 'utf8');
  return docPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// ГЕЙТ ОДОБРЕНИЯ (I3, I4) — одна реализация на страницу, гейт и отправщик
// ─────────────────────────────────────────────────────────────────────────────

/** Артефакты документа с разрешёнными путями тел. */
export function artifactsOf(docPath) {
  const meta = parseMeta(readMd(docPath));
  return meta.artifacts.map((a) => ({
    ...a,
    path: a.body_file ? join(dirname(docPath), '..', a.body_file) : null,
    absolute: a.body_file ? join(ROOT, a.body_file) : null,
  }));
}

/**
 * Единственная проверка «можно ли это отправлять».
 *
 * 🔴 FAIL-CLOSED (I4): любое сомнение — ОТКАЗ. Нет решения, `rejected`, артефакт не объявлен, тело
 * пропало, хеш разъехался, файл решения не читается — всё это отказ, а не «наверное можно».
 * Запрос НИКОГДА не одобряет сам себя по таймауту. Возвращает `{ok, reason, …}` и никогда не бросает.
 */
export function checkApproval(docPath, artifactId) {
  try {
    if (!existsSync(docPath)) return { ok: false, reason: `документа нет: ${docPath}` };

    const art = artifactsOf(docPath).find((a) => a.id === artifactId);
    if (!art) return { ok: false, reason: `артефакт «${artifactId}» не объявлен в метаблоке документа` };
    if (!art.absolute || !existsSync(art.absolute))
      return { ok: false, reason: `файл тела не найден: ${art.body_file}` };

    const decision = readDecision(docPath);
    if (!decision) return { ok: false, reason: 'решения нет — владелец ничего не одобрял' };

    const rec = decision.artifacts?.[artifactId];
    if (!rec) return { ok: false, reason: `в решении нет записи про артефакт «${artifactId}»` };
    if (rec.status !== 'approved') return { ok: false, reason: `статус «${rec.status}», а не «approved»` };
    if (!rec.sha256) return { ok: false, reason: 'в решении нет хеша — одобрение не привязано к тексту' };

    const now = bodyHash(art.absolute);
    if (now !== rec.sha256)
      return {
        ok: false,
        reason: 'ТЕКСТ ИЗМЕНИЛСЯ ПОСЛЕ ОДОБРЕНИЯ — одобрение аннулировано',
        approved: rec.sha256,
        current: now,
      };

    return { ok: true, reason: 'одобрено', by: decision.by, at: decision.at, sha256: now, artifact: art };
  } catch (e) {
    // Даже неожиданная ошибка — отказ. Гейт не имеет права пропускать по недоразумению.
    return { ok: false, reason: `сбой проверки (считаем отказом): ${e.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ТИХИЕ ЧАСЫ (I6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Тихие часы. Окно ПЕРЕСЕКАЕТ ПОЛНОЧЬ (умолчание 23:00–09:00), и наивное сравнение
 * `from <= now <= to` при таком окне молчит весь день и звучит всю ночь — ровно наоборот.
 * Регламент (I6) требует отдельного охранника на это сравнение; он есть в `selftest()`.
 *
 * ⚠️ В KLAS у тихих часов есть вторая причина, кроме сна: правило владельца «предупреждать перед
 * звуком в комнате». Сигнал контура звучит в динамики — молчание ночью тут не вежливость, а канон.
 */
export function isQuiet(date, from = '23:00', to = '09:00') {
  const min = (s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const now = date.getHours() * 60 + date.getMinutes();
  const a = min(from);
  const b = min(to);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

// ─────────────────────────────────────────────────────────────────────────────
// САМОТЕСТ — тот самый, которого не хватило полю
// ─────────────────────────────────────────────────────────────────────────────

export function selftest() {
  const fails = [];
  const ok = (name, cond) => {
    if (!cond) fails.push(name);
  };

  // I3 — согласие нормализации. Все четыре «лица» одного текста обязаны дать ОДИН хеш.
  const base = 'привет\nмир\n';
  ok('хеш: CRLF = LF', textHash('привет\r\nмир\r\n') === textHash(base));
  ok('хеш: BOM не влияет', textHash('\uFEFFпривет\nмир\n') === textHash(base));
  ok('хеш: хвост из пустых строк не влияет', textHash('привет\nмир\n\n\n  \n') === textHash(base));
  ok('хеш: нет хвостового перевода строки', textHash('привет\nмир') === textHash(base));
  ok('хеш: разный текст — разный хеш', textHash('привет\nмиp\n') !== textHash(base));

  // I6 — тихие часы, пересекающие полночь: ровно тот случай, что ломает наивное сравнение.
  const at = (h, m = 0) => new Date(2026, 7, 1, h, m);
  ok('тихо в 23:30', isQuiet(at(23, 30)) === true);
  ok('тихо в 03:00', isQuiet(at(3)) === true);
  ok('тихо в 08:59', isQuiet(at(8, 59)) === true);
  ok('шумно в 09:00', isQuiet(at(9)) === false);
  ok('шумно в 14:00', isQuiet(at(14)) === false);
  ok('шумно в 22:59', isQuiet(at(22, 59)) === false);
  ok('обычное окно 13–14: тихо в 13:30', isQuiet(at(13, 30), '13:00', '14:00') === true);
  ok('обычное окно 13–14: шумно в 12:00', isQuiet(at(12), '13:00', '14:00') === false);

  // Разбор вопросов и вариантов — В ФОРМАТЕ KLAS (латинская Q, заголовки `##` и `###`,
  // блоки разделены линейками `---`).
  const doc = [
    '# Интервью #999 — проба',
    '> Статус: **🟡 ждёт ответов владельца**',
    '',
    '## Q1. Первый вопрос?',
    '- **A) (рекомендую)** первый вариант',
    '- **B) второй** хвост',
    '',
    '**Ответ:**',
    '',
    '---',
    '',
    '## Q2. Второй вопрос?',
    '',
    '**Ответ:** B',
    '',
  ].join('\n');
  const p = parseInterview('проба.md', doc);
  ok('разбор: два вопроса', p.questions.length === 2);
  ok('разбор: метки Q1/Q2', p.questions.map((q) => q.label).join() === 'Q1,Q2');
  ok('разбор: два варианта у Q1', p.questions[0].options.length === 2);
  ok('разбор: буквы вариантов', p.questions[0].options.map((o) => o.letter).join() === 'A,B');
  ok('разбор: Q1 без ответа', p.questions[0].answered === false);
  ok('разбор: Q2 с ответом', p.questions[1].answered === true);
  ok('разбор: статус прочитан', p.waiting === true);
  // 🔴 Линейка после пустого поля НЕ считается ответом (пилот NDim на живых данных).
  ok('линейка `---` не делает пустой вопрос отвеченным', p.questions[0].answer === '');
  // Счётная проверка: сколько строк-кандидатов, столько и разобранных вариантов.
  ok('счёт вариантов сходится', p.questions[0].optionLines === p.questions[0].options.length);

  // Поле, подписанное как ВСТРЕЧНЫЙ ВОПРОС, ответом не считается: развилка не выбрана.
  const counter = [
    '### Q9. Развилка?',
    '- **A) (рекомендую)** вариант',
    '',
    '**Ответ (вопрос владельца):** «а можно иначе?»',
    '',
  ].join('\n');
  const pc = parseInterview('проба.md', counter);
  ok('встречный вопрос НЕ считается ответом', pc.questions[0]?.answered === false);
  ok('встречный вопрос помечен признаком', pc.questions[0]?.counterQuestion === true);
  ok(
    'обычное поле ответом считается',
    parseInterview('x.md', '### Q9. Вопрос?\n\n**Ответ:** C\n').questions[0]?.answered === true,
  );

  // 🔴 Многострочный вариант (жирный заголовок перенесён) обязан разобраться — контур на этом обжёгся.
  // В KLAS так написано БОЛЬШИНСТВО вариантов, поэтому случай стоит здесь фикстурой.
  const wrapped = [
    '## Q1. Что для тебя «в Docker» на самом деле?',
    '- **A) (рекомендую) «Работает само, без терминала».** Тогда Docker не нужен вовсе: голосовая',
    '  часть становится СЛУЖБОЙ Windows.',
    '- **B) «Мозги — в контейнерах, микрофон — на хосте».** Больше работы.',
    '- **C) «Всё в Docker, как я и сказал».** Цена огромная.',
    '',
    '**Ответ:**',
    '',
  ].join('\n');
  const pw = parseInterview('x.md', wrapped);
  ok('вариант с переносом строки не теряется', pw.questions[0]?.options.length === 3);
  ok('буквы вариантов с переносом верны', pw.questions[0]?.options.map((o) => o.letter).join() === 'A,B,C');
  ok('счёт вариантов сходится и на переносах', pw.questions[0]?.optionLines === pw.questions[0]?.options.length);

  // Семантика статуса — одна с охранником `owner-questions.mjs`.
  ok('статус: ждёт', parseDoc('x', '> Статус: **🟡 ждёт ответов владельца**\n\n**Ответ:**\n').waiting === true);
  ok('статус: отвечено', parseDoc('x', '> Статус: ✅ **ОТВЕЧЕНО**\n\n**Ответ:** A\n').answered === true);
  ok(
    'статус: расхождение «✅ без единого свидетельства»',
    parseDoc('x', '> Статус: **✅ ОТВЕТЫ ПОЛУЧЕНЫ**\n\n**Ответ:**\n\n**Ответ:**\n').drift === true,
  );
  ok(
    'статус: ✅ + таблица решений — НЕ расхождение',
    parseDoc(
      'x',
      '> Статус: **✅ ОТВЕЧЕНО В ЧАТЕ**\n\n**Ответ:**\n\n## Решения\n\n| Вопрос | Решение |\n|---|---|\n| Q1 | **A** |\n',
    ).drift === false,
  );
  ok(
    'статус: домашка с вердиктом разделом — НЕ расхождение',
    parseDoc(
      'x',
      '> **Статус:** ✅ **ПРОЙДЕНА.**\n\n## Вердикт владельца (дословно)\n\n> Вроде работает, но перебить не могу — хотелось бы перебивать их пока говорят.\n',
    ).drift === false,
  );
  ok('статус: без строки статуса вовсе', parseDoc('x', '# Просто\n\nтекст\n').noStatus === true);

  // 🔴 Оба живых случая KLAS, найденных пилотом, — фикстурами, чтобы дефект не вернулся.
  // (1) Поле-подсказка под заполнение — НЕ статус документа (`homeworks/02`).
  const prompt = '# Домашка\n\nтекст\n\n**→ Статус (телефон в tailnet? голос дошёл?):**\n';
  ok('статус: пустое поле под заполнение статусом НЕ считается', parseDoc('x', prompt).noStatus === true);
  ok('статус: такой документ виден как «ждёт», а не пропадает', parseDoc('x', prompt).waiting === true);
  ok('статус: непарная разметка не утекает на страницу', !/\*\*/.test(parseInterview('x.md', prompt).statusRaw ?? ''));
  // (2) Статус в СЕРЕДИНЕ абзаца остаётся законным (`homeworks/01`) — придираться к документам
  // владельца прибор не вправе.
  ok(
    'статус: найден в середине абзаца',
    parseDoc('x', '> …настроена агентом и проверена боем. Статус: 🟢 готово к подключению.\n').waiting === true,
  );

  // 🔴 Залежавшийся статус: «ждёт», а отвечены ВСЕ. Оба живых случая KLAS стоят здесь фикстурой.
  ok(
    'залежавшийся статус: «ждёт» при всех отвеченных вопросах',
    parseInterview(
      'x.md',
      '> Статус: 🟡 ЖДЁТ ОТВЕТОВ ВЛАДЕЛЬЦА\n\n## Q1. Раз?\n\n**Ответ:** A\n\n---\n\n## Q2. Два?\n\n**Ответ:** B\n',
    ).staleWaiting === true,
  );
  ok(
    'НЕ залежавшийся: один вопрос ещё без ответа',
    parseInterview(
      'x.md',
      '> Статус: 🟡 ЖДЁТ ОТВЕТОВ ВЛАДЕЛЬЦА\n\n## Q1. Раз?\n\n**Ответ:** A\n\n---\n\n## Q2. Два?\n\n**Ответ:**\n',
    ).staleWaiting === false,
  );
  ok(
    'НЕ залежавшийся: вопросов нет вовсе (домашка)',
    parseInterview('x.md', '> **Статус:** 🟢 ЖДЁТ ТВОЕГО МИКРОФОНА.\n\nтекст\n').staleWaiting === false,
  );

  // Рендерер: связка, а не просто отсутствие падения (EXP-0015 — структура ≠ связность)
  const html = mdToHtml(doc);
  ok('рендер: заголовок', html.includes('<h1>'));
  ok('рендер: список', html.includes('<li>'));
  ok('рендер: цитата', html.includes('<blockquote>'));
  ok('рендер: жирный', html.includes('<strong>'));
  ok('рендер: таблица', mdToHtml('| а | б |\n|---|---|\n| 1 | 2 |').includes('<table>'));
  ok('рендер: код дословно', mdToHtml('```\n<b>\n```').includes('&lt;b&gt;'));
  ok('рендер: экранирование', mdToHtml('<script>').includes('&lt;script&gt;'));
  ok('рендер: ссылка', mdToHtml('[а](/б)').includes('<a href="/б">'));

  // Метаблок
  const meta = parseMeta(
    '```yaml\ntitle: Черновик\nkind: outbound\nartifacts:\n  - {id: a1, target: "GitHub · repo", body_file: drafts/a1.md}\n```\n\n# Заголовок\n',
  );
  ok('мета: kind', meta.kind === 'outbound');
  ok('мета: title', meta.title === 'Черновик');
  ok('мета: артефакт разобран', meta.artifacts[0]?.id === 'a1');
  ok('мета: цель с пробелами', meta.artifacts[0]?.target === 'GitHub · repo');
  ok('мета: без блока — интервью', parseMeta('# Просто\n').kind === 'interview');
  ok('мета: заголовок из #', parseMeta('# Просто\n').title === 'Просто');

  // Имена решений производны от ПУТИ (I2): две директории вопросов не должны затирать друг друга.
  ok(
    'решение: имя производно от пути',
    decisionPath(join(ROOT, 'interviews', 'interview_010_always_on.md')).endsWith(
      'interviews__interview_010_always_on.decision.json',
    ),
  );
  ok(
    'решение: одинаковые имена в разных папках не сталкиваются',
    decisionPath(join(ROOT, 'interviews', '06_x.md')) !== decisionPath(join(ROOT, 'homeworks', '06_x.md')),
  );

  // Гейт (I4) — fail-closed по умолчанию: нечего одобрять, значит отказ.
  ok(
    'гейт: нет документа — отказ',
    checkApproval(join(ROOT, 'нет-такого.md'), 'a1').ok === false,
  );

  return fails;
}
