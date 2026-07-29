// tools/voice/kws-probe.mjs — СТЕНД слова-активатора «Джарвис» / «Джои» (ответ владельца, интервью 007 Q3).
//
// Зачем. Владелец выбрал разговор «только по слову-активатору». Разведка `researches/16` называла
// кандидатом openWakeWord (Python, установка, готовая модель `jarvis`). Но движок `sherpa-onnx-node`,
// на котором УЖЕ работают наши уши, экспортирует `KeywordSpotter` — и у него ключевые слова задаются
// СПИСКОМ ТОКЕНОВ, без всякого обучения. Если это сработает, обе задачи (Джарвис и Джои) решаются
// нулём новых сущностей — а вторую модель иначе пришлось бы обучать.
//
// ⚠️ Модель KWS обучена на английском (gigaspeech BPE) — русского KWS в релизах нет. Поэтому слово
// пишется английскими токенами (JARVIS / JOI), а произносится по-русски: проверяем, дотянется ли
// английская акустика до русского произношения. Это ГИПОТЕЗА, которую и меряем.
//
// ⚠️ Честная граница (EXP-0016): проверяем на СИНТЕЗИРОВАННОЙ речи — своего рта. Положительный
// результат = зелёный свет живой проверке микрофоном владельца, а НЕ вердикт.
//
// Запуск: node tools/voice/kws-probe.mjs
// [TESTED: 2026-07-29 · развёртка 16 рабочих точек: потолок 3/6 верных при 0/3 ложных (score 3.0,
//  порог 0.05) ⇒ путь ОТВЕРГНУТ, английская акустика не слышит русское произношение надёжно.
//  Механика исправна: срабатывали оба написания, ложных не было даже на ловушке «джазовая, джем»]

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const MODELS = 'F:\\KLAS\\voice\\models';
const KWS_DIR = path.join(MODELS, 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01');
const TTS_DIR = path.join(MODELS, 'vits-piper-ru_RU-ruslan-medium');
const OUT_DIR = 'F:\\KLAS\\voice\\out\\kws';
mkdirSync(OUT_DIR, { recursive: true });

// --- 1. Токенизация слова в BPE-куски словаря модели ---------------------------------------------
// Жадный самый-длинный-первым по словарю: у SentencePiece-BPE это не тождественно его собственному
// разбору, но для одного слова даёт валидную последовательность кусков, а валидность — всё, что
// требуется формату keywords.txt.
const vocab = new Set(
  readFileSync(path.join(KWS_DIR, 'tokens.txt'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/)[0]),
);

function toTokens(word) {
  const w = word.toUpperCase();
  const pieces = [];
  let i = 0;
  while (i < w.length) {
    let hit = null;
    // на первой позиции кусок начинается с ▁ (маркер начала слова у SentencePiece)
    for (let len = w.length - i; len > 0; len--) {
      const cand = (i === 0 ? '\u2581' : '') + w.slice(i, i + len);
      if (vocab.has(cand)) { hit = cand; i += len; break; }
    }
    if (!hit) return null;   // слово не собирается из словаря — честно вернуть null, не выдумывать
    pieces.push(hit);
  }
  return pieces.join(' ');
}

// Несколько написаний: как слово ЗВУЧИТ по-русски, английская акустика может лечь по-разному.
const CANDIDATES = ['JARVIS', 'JARVES', 'DZHARVIS', 'JOI', 'JOY', 'DZHOI'];
const spellings = [];
for (const c of CANDIDATES) {
  const t = toTokens(c);
  console.log(`${c.padEnd(10)} -> ${t ?? 'НЕ СОБИРАЕТСЯ ИЗ СЛОВАРЯ'}`);
  if (t) spellings.push({ word: c, tokens: t });
}
const kwFile = path.join(OUT_DIR, 'keywords.txt');
writeFileSync(kwFile, spellings.map((s) => s.tokens).join('\n') + '\n', 'utf8');

// --- 2. Синтез испытательных реплик ---------------------------------------------------------------
const tts = new sherpa.OfflineTts({
  model: {
    vits: {
      model: path.join(TTS_DIR, 'ru_RU-ruslan-medium.onnx'),
      tokens: path.join(TTS_DIR, 'tokens.txt'),
      dataDir: path.join(TTS_DIR, 'espeak-ng-data'),
    },
    numThreads: 2, provider: 'cpu', debug: false,
  },
  maxNumSentences: 1,
});

// Положительные — слово в разных обрамлениях и темпах; отрицательные — ЛОЖНЫЕ срабатывания,
// без них замер бесполезен: детектор, который срабатывает всегда, «находит» слово со 100% точностью.
const CASES = [
  ['pos_jarvis_odin',   'Джарвис.',                         1.0, true],
  ['pos_jarvis_medl',   'Джарвис.',                         0.85, true],
  ['pos_jarvis_bystro', 'Джарвис.',                         1.15, true],
  ['pos_jarvis_fraza',  'Джарвис, какая сегодня погода?',   1.0, true],
  ['pos_joi_odin',      'Джои.',                            1.0, true],
  ['pos_joi_fraza',     'Джои, включи музыку.',             1.0, true],
  ['neg_pogoda',        'Какая сегодня погода в Минске?',   1.0, false],
  ['neg_dlinnaya',      'Сегодня около двадцати двух градусов, ветер слабый.', 1.0, false],
  ['neg_pohozhe',       'Джазовая музыка и джем на завтрак.', 1.0, false],
];

// --- 3. Прогон детектора --------------------------------------------------------------------------
// Синтезируем ОДИН раз, гоняем много раз: набор параметров ищем на одинаковом звуке, иначе сравниваем
// не пороги, а разные синтезы.
const clips = CASES.map(([tag, text, speed, positive]) => {
  const audio = tts.generate({ text, sid: 0, speed });
  sherpa.writeWave(path.join(OUT_DIR, `${tag}.wav`), { samples: audio.samples, sampleRate: audio.sampleRate });
  return { tag, positive, audio };
});

function makeSpotter(score, threshold) {
  return new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(KWS_DIR, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
        decoder: path.join(KWS_DIR, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
        joiner: path.join(KWS_DIR, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
      },
      tokens: path.join(KWS_DIR, 'tokens.txt'),
      numThreads: 1, provider: 'cpu', debug: false,
    },
    maxActivePaths: 4,
    keywordsScore: score,       // «буст» гипотезы ключевого слова
    keywordsThreshold: threshold,
    numTrailingBlanks: 1,
    keywordsFile: kwFile,
  });
}

function run(spotter, clip) {
  const stream = spotter.createStream();
  stream.acceptWaveform({ sampleRate: clip.audio.sampleRate, samples: clip.audio.samples });
  // хвост тишины: детектор решает по окну, последнему слову нужно «дозреть»
  stream.acceptWaveform({ sampleRate: clip.audio.sampleRate, samples: new Float32Array(clip.audio.sampleRate * 0.5) });
  const hits = [];
  while (spotter.isReady(stream)) {
    spotter.decode(stream);
    const r = spotter.getResult(stream);
    if (r && r.keyword) hits.push(r.keyword);
  }
  return [...new Set(hits)];
}

// Развёртка по рабочей точке. Смысл: у детектора ложных срабатываний НЕТ, значит есть запас — надо
// узнать, покупается ли на него полнота. Точка, где ложные полезут, и есть предел метода.
console.log('\n=== РАЗВЁРТКА (полнота / ложные) ===');
console.log('score  порог   верных  ложных   сработавшие написания');
const grid = [];
for (const score of [1.0, 2.0, 3.0, 4.0]) {
  for (const threshold of [0.05, 0.10, 0.15, 0.25]) {
    let spotter;
    try { spotter = makeSpotter(score, threshold); } catch (e) { console.error('не создался:', e.message); process.exit(2); }
    let tp = 0, fn = 0, fp = 0, tn = 0; const words = new Set();
    for (const clip of clips) {
      const hits = run(spotter, clip);
      hits.forEach((h) => words.add(h));
      const detected = hits.length > 0;
      if (clip.positive) { detected ? tp++ : fn++; } else { detected ? fp++ : tn++; }
    }
    grid.push({ score, threshold, tp, pos: tp + fn, fp, neg: fp + tn });
    console.log(`${String(score).padEnd(6)} ${String(threshold).padEnd(7)} ${String(tp + '/' + (tp + fn)).padEnd(7)} ${String(fp + '/' + (fp + tn)).padEnd(8)} ${[...words].join(',') || '—'}`);
  }
}

const clean = grid.filter((g) => g.fp === 0).sort((a, b) => b.tp - a.tp)[0];
console.log(`\n=== ИТОГ === лучшая точка БЕЗ ложных: score=${clean?.score} порог=${clean?.threshold} → ${clean?.tp}/${clean?.pos} верных`);
console.log(`wav: ${OUT_DIR}`);
