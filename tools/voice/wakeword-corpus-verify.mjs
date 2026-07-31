// tools/voice/wakeword-corpus-verify.mjs — ОХРАННИК КОРПУСА активатора (план 19, шаг 1).
//
// Зачем отдельный охранник. Генератор `wakeword-corpus.mjs` умеет проверить только себя: сколько
// файлов записал и не пустые ли они. Но корпус может быть НЕ ТОТ при полностью исправном генераторе:
// диктор проглотил слово, темп 1.25 превратил его в кашу, espeak-ng прочитал «Джарвис» не так, как
// ждали. Это ТИХИЙ дефект — ни исключения, ни лога, — и всплыл бы он метрикой обучения, где стоит
// на порядок дороже (`bugs/18`: сломанный корпус пришёл не жалобой на данные, а `CUDA out of memory`).
//
// Метод: судить корпус НЕЗАВИСИМОЙ моделью. Клипы синтезировал Piper — проверяет их GigaAM-v3,
// наши уши. Модель, проверяющая сама себя, доказывает только собственную непротиворечивость;
// две разные модели, сошедшиеся на слове, — это уже свидетельство. Тот же приём, что в
// `voice-roundtrip.mjs` (рот → уши), только применённый к обучающим данным.
//
// Что судится:
//   положительные — слово ОБЯЗАНО быть услышано (иначе учим детектор на клипах без слова);
//   отрицательные — слова там быть НЕ ДОЛЖНО (иначе учим его молчать на собственном имени).
//
// ⚠️ Сверка ПО СЛОВАМ, а не подстрокой. В негативах намеренно стоит ловушка «джойстик», которая
// содержит «джой» целиком: подстрочный поиск объявил бы исправный корпус сломанным. Границы слова —
// это не педантизм, а условие, чтобы ловушка осталась ловушкой.
//
// Запуск:
//   node tools/voice/wakeword-corpus-verify.mjs                          # jarvis, ждём «джарвис»
//   node tools/voice/wakeword-corpus-verify.mjs --slug joy --expect джой
//   node tools/voice/wakeword-corpus-verify.mjs --selftest               # доказать, что умеет краснеть
//
// [NOT-TESTED] — родился 2026-07-31.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const CORPUS_ROOT = 'F:\\KLAS\\voice\\wakeword\\corpus';
const EARS_DIR = 'F:\\KLAS\\voice\\models\\gigaam-v3-ctc';   // 34 токена: только строчная кириллица

// --- ПОРОГИ И ПОЧЕМУ ОНИ ИМЕННО ТАКИЕ -------------------------------------------------------------
// ⚠️ Пороги здесь МЕНЯЛИСЬ 2026-07-31, и обоснование обязано лежать рядом с числом — иначе это
// подгонка теста под результат (AGENT_GUIDE → «Коммиты»).
//
// Изначально стоял один порог: «слово слышно в ≥90% положительных». Замер показал, что он мерит не то.
// Инструмент теперь не просто ставит оценку, а ОТБРАКОВЫВАЕТ негодные клипы (manifest.clean.json) —
// значит вопрос «какая доля сырого синтеза удалась» перестал быть приёмочным. Приёмочных стало два:
//   1) хватает ли ГОДНЫХ клипов, чтобы на них учить;
//   2) не сломано ли что-то системно (тогда брак пойдёт лавиной, а не единицами).
const MIN_POSITIVE_CLIPS = 200;    // ниже этого обучать не на чем — корпус надо расширять
const MIN_SURVIVAL_RATE = 0.60;    // брак у каждого второго — это уже не капризы судьи, а поломка
const WARN_SURVIVAL_RATE = 0.90;   // между 0.60 и 0.90 — предупреждение: работает, но синтез транжирит

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const SLUG = arg('slug', 'jarvis');
const EXPECT = arg('expect', 'джарвис').toLowerCase();
const SELFTEST = argv.includes('--selftest');

// Разбор на слова: GigaAM `ru` отдаёт только строчную кириллицу без пунктуации, но дефис и лишние
// пробелы возможны. Приводим к списку чистых слов, чтобы сравнение шло по целому слову.
function words(text) {
  return text.toLowerCase().replace(/[^а-яё\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
}

// --- ПОЧЕМУ СВЕРКА НЕ ТОЧНАЯ, А ФОНЕТИЧЕСКАЯ ------------------------------------------------------
// Замер 2026-07-31 поймал судью на систематической предвзятости, и её видно в самих данных:
//   «Сервис работает круглосуточно» — 4/4 голоса расшифрованы ДОСЛОВНО (тот же кластер «рв»);
//   «Джарвис» — разваливается в «джарвес», «жарвис», «джавис», «джарлис».
// Разница не в акустике, а в СЛОВАРЕ: «сервис» — обычное русское слово, «Джарвис» — иностранное имя,
// которого GigaAM никогда не видел. CTC-модель без языковой модели обязана выдать ближайшую
// правдоподобную русскую цепочку букв — то есть точное совпадение штрафует ровно за то свойство,
// ради проверки которого судья и позван. Требовать его — значит красить исправный корпус в красный.
//
// Поэтому судим по РАССТОЯНИЮ РЕДАКТИРОВАНИЯ: «джарвес» (1 правка) — это услышанное слово, а
// «чарлиз» (4 правки) — это уже другое слово, и такой клип обучению вредит.
// Допуск ~30% длины: для «джарвис» (7 букв) это 2 правки, для «джой» (4) — 1.
// ⚠️ Ловушка «джойстик» при этом остаётся ловушкой: до «джой» ей 4 правки — мимо допуска.
const TOLERANCE_RATIO = 0.30;
const tolerance = (w) => Math.max(1, Math.round(w.length * TOLERANCE_RATIO));

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Ближайшее к искомому слово расшифровки и его расстояние. Расстояние возвращается наружу, чтобы
// отчёт показывал РАСПРЕДЕЛЕНИЕ, а не только «да/нет»: по нему видно, корпус чистый или пограничный.
function closest(text, w) {
  let best = Infinity, word = '';
  for (const t of words(text)) {
    const d = levenshtein(t, w);
    if (d < best) { best = d; word = t; }
  }
  return { distance: best, word };
}
const hasWord = (text, w) => closest(text, w).distance <= tolerance(w);

// --- Самопроверка: охранник, который ни разу не краснел, ничего не доказывает --------------------
// Проверяем ОБЕ стороны сверки (EXP-0020): и что слово опознаётся, и что ловушка НЕ считается словом.
if (SELFTEST) {
  const cases = [
    ['джарвис',                         'джарвис', true,  'слово отдельно, точно'],
    ['джарвис какая сегодня погода',    'джарвис', true,  'слово в начале фразы'],
    ['скажи джарвис ты меня слышишь',   'джарвис', true,  'слово внутри фразы'],
    // фонетически близкие — это УСЛЫШАННОЕ слово, а не промах: CTC-уши не знают иностранного имени
    ['джарвес какая сегодня погода',    'джарвис', true,  'близкое (1 правка) — засчитывается'],
    ['жарвис',                          'джарвис', true,  'близкое (1 правка) — засчитывается'],
    ['джавис',                          'джарвис', true,  'близкое (1 правка) — засчитывается'],
    // далёкие — это уже ДРУГОЕ слово, такой клип обучению вредит
    ['чарлиз',                          'джарвис', false, 'далёкое (4 правки) — клип негоден'],
    ['жалобись',                        'джарвис', false, 'далёкое — клип негоден'],
    ['джазовая музыка и джем',          'джарвис', false, 'фонетическая ловушка'],
    ['сервис работает круглосуточно',   'джарвис', false, 'ловушка по хвосту -рвис'],
    ['он купил новый джойстик',         'джой',    false, '⭐ ЛОВУШКА: «джойстик» содержит «джой» ЦЕЛИКОМ'],
    ['джой стипомаса нужен другой',     'джой',    true,  '⭐ так уши РАЗРЕЗАЛИ «джойстик» — по расшифровке слово есть, в тексте нет'],
    ['джой включи музыку',              'джой',    true,  'слово «джой» отдельным словом'],
    ['',                                'джарвис', false, 'пустая расшифровка — не находка'],
  ];
  let bad = 0;
  for (const [text, w, expected, why] of cases) {
    const got = hasWord(text, w);
    const ok = got === expected;
    if (!ok) bad++;
    const c = closest(text, w);
    const d = Number.isFinite(c.distance) ? `${c.distance} правок до «${c.word}»` : 'слов нет';
    console.log(`${ok ? '✅' : '❌'} [${w}] «${text || '(пусто)'}» → ${got} (ждали ${expected}; ${d}) — ${why}`);
  }
  console.log(bad ? `\n❌ САМОПРОВЕРКА ПРОВАЛЕНА: ${bad} из ${cases.length}` : `\n✅ Самопроверка ${cases.length}/${cases.length}`);
  process.exit(bad ? 1 : 0);
}

// --- Основной прогон ------------------------------------------------------------------------------
const dir = path.join(CORPUS_ROOT, SLUG);
const manifestPath = path.join(dir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`Нет манифеста: ${manifestPath} — сначала прогони wakeword-corpus.mjs`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Пустой корпус — это ПРОВАЛ, а не «ноль проблем» (класс EXP-0042: охранник, считавший пустоту успехом).
if (!manifest.clips?.length) {
  console.error('❌ ОХРАННИК: в манифесте ноль клипов — это провал, а не чистый корпус.');
  process.exit(1);
}

console.log(`Корпус: ${dir}`);
console.log(`Ждём слово: «${EXPECT}» · клипов: ${manifest.clips.length}`);

const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 64 },
  modelConfig: { nemoCtc: { model: `${EARS_DIR}\\model.int8.onnx` }, tokens: `${EARS_DIR}\\tokens.txt`, numThreads: 4, provider: 'cpu', debug: 0 },
});

function hear(file) {
  const wave = sherpa.readWave(path.join(dir, file));
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream).text.trim();
}

const t0 = Date.now();
const posMiss = [];        // положительные, где слова НЕ слышно — учить на них нечему
const negHit = [];         // отрицательные, где слово ПРОЗВУЧАЛО ТОЧНО — вот они действительно отравляют
const hardNeg = [];        // отрицательные, звучащие БЛИЗКО к слову, — самый ценный материал набора
const byVoice = {};        // разбивка: виноват диктор или темп?
const bySpeed = {};
const byFraming = {};      // ⭐ и обрамление: одинокое слово судится СОВСЕМ не так, как слово во фразе
let pos = 0, neg = 0;

// Восстанавливаем шаблон обрамления из текста клипа: «Джарвис, включи музыку.» → «{W}, включи музыку.»
// Разбивка по нему решает главный вопрос замера — правда ли ломается СЛОВО, или ломается только
// однословная реплика (у CTC-ушей без языковой модели это разные вещи).
const framingOf = (text) => text.split(manifest.word).join('{W}');

const distHist = {};       // распределение расстояний — по нему видно, чистый корпус или пограничный
const clean = [];          // клипы, ГОДНЫЕ для обучения (см. пересборку манифеста ниже)

for (const c of manifest.clips) {
  const positive = c.file.startsWith('positive/');
  const text = hear(c.file);
  const { distance, word } = closest(text, EXPECT);
  const heard = distance <= tolerance(EXPECT);

  if (positive) {
    pos++;
    const fr = framingOf(c.text);
    const key = Number.isFinite(distance) ? String(distance) : '∞';
    distHist[key] = (distHist[key] ?? 0) + 1;
    (byVoice[c.voice] ??= { ok: 0, total: 0 }).total++;
    (bySpeed[c.speed] ??= { ok: 0, total: 0 }).total++;
    (byFraming[fr] ??= { ok: 0, total: 0 }).total++;
    if (heard) {
      byVoice[c.voice].ok++; bySpeed[c.speed].ok++; byFraming[fr].ok++;
      clean.push({ ...c, heard: text, distance });
    } else {
      posMiss.push({ ...c, text, distance, word });
    }
  } else {
    neg++;
    // ⚠️ У НЕГАТИВОВ ВОПРОС ДРУГОЙ, И СУДИТЬ ИХ НАДО ПО ИСХОДНОМУ ТЕКСТУ, А НЕ ПО РАСШИФРОВКЕ.
    //
    // У положительных мы ЗНАЕМ, что слово произносилось, и спрашиваем «пережило ли оно синтез» —
    // там уместна фонетическая близость. У негативов слова нет ПО ПОСТРОЕНИЮ, и настоящий риск
    // только один: мы сами по недосмотру вписали активатор в текст негатива. Это ОШИБКА ПОСТРОЕНИЯ,
    // и проверяется она в тексте, который мы написали, — распознавалка для этого не нужна.
    //
    // ⛔ Две правки, обе оплачены замерами 2026-07-31, — не повторять их:
    // 1) НЕЧЁТКАЯ сверка забраковала «Дарвин описал происхождение видов»: «дарвин» отстоит от
    //    «джарвис» на 2 правки. Это не яд, а лучший трудный негатив набора.
    // 2) ТОЧНАЯ сверка ПО РАСШИФРОВКЕ забраковала «Джойстик сломался, нужен другой»: уши
    //    расслышали «джой стипомаса нужен другой», разрезав «джойстик» на «джой» и «стик».
    //    Слова в тексте нет — оно возникло в РАЗБИВКЕ распознавалки. Выбросить этот клип значило
    //    бы удалить ровно ту ловушку, ради которой он поставлен: сказавший «джойстик» не должен
    //    будить Джой.
    // Общий корень обеих ошибок: у негатива спрашивали «похоже ли звучит», хотя спросить надо было
    // «не вписали ли мы слово по недосмотру».
    const inSourceText = words(c.text).includes(EXPECT);
    if (inSourceText) negHit.push({ ...c, text, distance, word });
    else {
      // Расшифровка, где активатор всё же прозвучал отдельным словом, — не дефект, а САМЫЙ трудный
      // случай набора: отмечаем отдельно, чтобы он был виден, и оставляем в обучении.
      const heardAsWord = words(text).includes(EXPECT);
      if (heardAsWord || (Number.isFinite(distance) && distance <= tolerance(EXPECT) + 1)) {
        hardNeg.push({ ...c, text, distance: heardAsWord ? 0 : distance, word: heardAsWord ? EXPECT : word });
      }
      clean.push({ ...c, heard: text, distance: Number.isFinite(distance) ? distance : null });
    }
  }
}

const elapsed = (Date.now() - t0) / 1000;
const posOk = pos - posMiss.length;
const rate = pos ? posOk / pos : 0;

console.log(`\nПоложительные: ${posOk}/${pos} услышано (${(rate * 100).toFixed(1)}%)`);
console.log(`Отрицательные: ${neg - negHit.length}/${neg} чисты (слово не прозвучало)`);
console.log(`Проверено за ${elapsed.toFixed(1)} с`);

console.log('\nПо дикторам:');
for (const v of Object.keys(byVoice).sort()) {
  const b = byVoice[v];
  console.log(`  ${v.padEnd(8)} ${b.ok}/${b.total}  (${((b.ok / b.total) * 100).toFixed(0)}%)`);
}
console.log('По темпам:');
for (const s of Object.keys(bySpeed).sort((a, b) => +a - +b)) {
  const b = bySpeed[s];
  console.log(`  ${String(s).padEnd(8)} ${b.ok}/${b.total}  (${((b.ok / b.total) * 100).toFixed(0)}%)`);
}
console.log('По обрамлениям (худшие сверху):');
for (const [fr, b] of Object.entries(byFraming).sort((a, z) => a[1].ok / a[1].total - z[1].ok / z[1].total)) {
  console.log(`  ${String(Math.round((b.ok / b.total) * 100)).padStart(3)}%  ${b.ok}/${b.total}  «${fr}»`);
}

console.log(`Расстояние до «${EXPECT}» в положительных (допуск ≤ ${tolerance(EXPECT)}):`);
for (const d of Object.keys(distHist).sort((a, b) => (a === '∞' ? 1 : b === '∞' ? -1 : +a - +b))) {
  const n = distHist[d];
  console.log(`  ${d === '∞' ? '  ∞' : String(d).padStart(3)} правок: ${String(n).padStart(3)}  ${'█'.repeat(Math.round((n / pos) * 50))}`);
}

if (posMiss.length) {
  console.log(`\nПоложительные, отбракованные (первые 8 из ${posMiss.length}) — услышано вместо слова:`);
  for (const m of posMiss.slice(0, 8)) console.log(`  ${String(m.distance).padStart(2)} правок  ${m.file}  «${m.text}»`);
}
if (negHit.length) {
  console.log(`\n❌ ОШИБКА ПОСТРОЕНИЯ: активатор вписан в ТЕКСТ отрицательных (${negHit.length}) — убрать из текстов:`);
  for (const m of negHit.slice(0, 8)) console.log(`  ${m.file}  текст: «${m.text}»`);
}
if (hardNeg.length) {
  // Это НЕ дефект. Трудный негатив — самый ценный материал набора: детектор ошибается именно
  // на почти-совпадениях, и научить его различать можно только показав их.
  const uniq = [...new Set(hardNeg.map((m) => `${m.word} (${m.distance})`))].sort();
  console.log(`\n⭐ Трудные негативы — звучат близко, но словом не являются (${hardNeg.length} клипов): ${uniq.join(', ')}`);
  console.log('   Оставлены в корпусе НАМЕРЕННО: на таких словах детектор и будет ошибаться без них.');
}

// --- Пересборка манифеста ТОЛЬКО из годных клипов ------------------------------------------------
// Судья, который лишь ставит оценку, оставляет отбраковку человеку — и она не делается. Раз мы уже
// знаем, какие клипы негодны, честно вынести их из обучения ЗДЕСЬ: обучение читает manifest.clean.json.
clean.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(
  path.join(dir, 'manifest.clean.json'),
  JSON.stringify({
    word: manifest.word, slug: manifest.slug, sampleRate: manifest.sampleRate,
    judgedBy: 'gigaam-v3-ctc', tolerance: tolerance(EXPECT), toleranceRatio: TOLERANCE_RATIO,
    positives: clean.filter((c) => c.file.startsWith('positive/')).length,
    negatives: clean.filter((c) => c.file.startsWith('negative/')).length,
    clips: clean,
  }, null, 2),
  'utf8',
);
console.log(`\nОтфильтрованный манифест: manifest.clean.json — ${clean.filter((c) => c.file.startsWith('positive/')).length} положительных, ${clean.filter((c) => c.file.startsWith('negative/')).length} отрицательных`);

// --- Вердикт --------------------------------------------------------------------------------------
const problems = [];
if (posOk < MIN_POSITIVE_CLIPS) problems.push(`годных положительных всего ${posOk} — обучать не на чем (нужно ≥${MIN_POSITIVE_CLIPS})`);
if (rate < MIN_SURVIVAL_RATE) problems.push(`брак у ${((1 - rate) * 100).toFixed(0)}% положительных — это системная поломка, а не капризы судьи (порог ${MIN_SURVIVAL_RATE * 100}%)`);
if (negHit.length) problems.push(`активатор вписан в ТЕКСТ ${negHit.length} отрицательных — это ошибка построения набора, чини тексты в генераторе`);

if (problems.length) {
  console.error('\n❌ КОРПУС НЕ ПРИНЯТ: ' + problems.join(' · '));
  process.exit(1);
}
if (rate < WARN_SURVIVAL_RATE) {
  console.log(`\n⚠️ Корпус принят, но синтез транжирит: отбраковано ${posMiss.length} из ${pos} положительных (${((1 - rate) * 100).toFixed(0)}%).`);
  console.log('   Обучать можно; чтобы получить больше материала при том же времени — смотри разбивку по дикторам и обрамлениям выше.');
}
console.log(`\n✅ КОРПУС ПРИНЯТ: ${posOk} годных положительных, ${neg - negHit.length} отрицательных (из них ${hardNeg.length} трудных).`);
