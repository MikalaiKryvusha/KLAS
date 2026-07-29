#!/usr/bin/env node
// tools/voice-hear.mjs — «УШИ» KLAS (фаза Г2, plans/12): русский STT локально, офлайн, CPU.
// sherpa-onnx (npm sherpa-onnx-node, prebuilt win-x64) + GigaAM-v3 CTC int8 (SOTA по русскому, MIT).
// Модель: F:\KLAS\voice\models\gigaam-v3-ctc\ (вне git; источник — HF csukuangfj/sherpa-onnx-nemo-
// ctc-giga-am-v3-russian-2025-12-16, bootstrap-команды в plans/12).
//
// Использование: node tools/voice-hear.mjs <файл.wav>   → распознанный текст + тайминги
// Wav любой частоты (sherpa-onnx ресемплит сам); GigaAM обучен на 16 кГц.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

// Модель сменная: у GigaAM-v3 два выпуска с ОДИНАКОВЫМ форматом (NeMo-CTC, model.int8.onnx +
// tokens.txt), но разными алфавитами — обычный (34 токена: только строчная кириллица) и `punct`
// (257 токенов: латиница, знаки препинания, заглавные, «ё»). Второй нужен для смеси языков,
// на которую пожаловался владелец (`bugs/10`). Флаг существует, чтобы обе можно было сравнить
// на одной фикстуре, а не менять код ради каждого замера.
const MODELS = {
  ru: 'F:\\KLAS\\voice\\models\\gigaam-v3-ctc',            // 34 токена, SOTA по чистому русскому
  punct: 'F:\\KLAS\\voice\\models\\gigaam-v3-ctc-punct',   // 257 токенов: латиница + пунктуация
};
const NUM_THREADS = 4; // как у TTS: хватает для realtime, систему не душим

const argv = process.argv.slice(2);
const modelKey = (() => { const i = argv.indexOf('--model'); return i >= 0 ? argv[i + 1] : 'ru'; })();
const MODEL_DIR = MODELS[modelKey] ?? modelKey;   // допускаем и произвольный путь к каталогу модели
const MODEL = `${MODEL_DIR}\\model.int8.onnx`;
const TOKENS = `${MODEL_DIR}\\tokens.txt`;

const wav = argv.find((a) => !a.startsWith('--') && a !== modelKey);
if (!wav) { console.error('Использование: node tools/voice-hear.mjs <файл.wav> [--model ru|punct|<путь>]'); process.exit(1); }
if (!existsSync(wav)) { console.error(`Нет файла: ${wav}`); process.exit(1); }
if (!existsSync(MODEL)) { console.error(`Нет модели: ${MODEL} — bootstrap в plans/12 (модели: ${Object.keys(MODELS).join(', ')})`); process.exit(1); }

const sherpa = require('sherpa-onnx-node');

const t0 = performance.now();
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 64 },       // родные фичи GigaAM
  modelConfig: {
    nemoCtc: { model: MODEL },
    tokens: TOKENS,
    numThreads: NUM_THREADS,
    provider: 'cpu',
    debug: 0,
  },
});
const t1 = performance.now();

const wave = sherpa.readWave(wav);
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
recognizer.decode(stream);
const result = recognizer.getResult(stream);
const t2 = performance.now();

const audioSec = wave.samples.length / wave.sampleRate;
const sttSec = (t2 - t1) / 1000;
console.log(result.text.trim());
console.error(`[тайминги] загрузка модели ${((t1 - t0) / 1000).toFixed(2)} с · аудио ${audioSec.toFixed(2)} с · распознавание ${sttSec.toFixed(2)} с · RTF ${(sttSec / audioSec).toFixed(3)}`);
