// tools/voice/wakeword-prepare-training.mjs — РАСКЛАДКА корпуса под обучение openWakeWord
// (план 19, шаг 2).
//
// Зачем. Обучатель апстрима (`openwakeword/train.py`) состоит из трёх независимых стадий:
// `--generate_clips` · `--augment_clips` · `--train_model`. ПЕРВУЮ МЫ ПРОПУСКАЕМ ЦЕЛИКОМ: это их
// синтез через `piper-sample-generator` (та самая зависимость, из-за которой разведка считала, что
// нужен Linux). Скрипт проверяет, сколько wav уже лежит в его каталогах, и при достатке пишет
// «skipping» — то есть наши клипы подставляются БЕЗ ЕДИНОЙ ПРАВКИ АПСТРИМА. Апстрим не форкаем.
//
// Этот инструмент делает ровно две вещи:
//   1) раскладывает годные клипы (manifest.clean.json — то есть уже отбракованные охранником)
//      по ожидаемой структуре positive_train / positive_test / negative_train / negative_test;
//   2) пишет training_config.yml с АБСОЛЮТНЫМИ путями к нашим данным.
//
// ⚠️ Разбиение на train/test ДЕТЕРМИНИРОВАНО и РАССЛОЕНО. Никакого `Math.random`: тестовым берётся
// каждый N-й клип отсортированного списка. Имя файла кодирует диктора, темп, обрамление и номер
// повтора, поэтому такой шаг раскладывает тест равномерно по всем четырём осям. Случайное разбиение
// дало бы то же в среднем, но перезапуск давал бы ДРУГОЙ тест — и два прогона обучения стали бы
// несравнимы (AGENT_GUIDE → «канонический порядок»).
//
// Запуск: node tools/voice/wakeword-prepare-training.mjs [--slug jarvis] [--test-every 10]
//
// [NOT-TESTED] — родился 2026-07-31.

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CORPUS_ROOT = 'F:\\KLAS\\voice\\wakeword\\corpus';
const TRAIN_ROOT = 'F:\\KLAS\\voice\\wakeword\\training';
const DATA_ROOT = 'F:\\KLAS\\voice\\wakeword\\data';

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const SLUG = arg('slug', 'jarvis');
const TEST_EVERY = Math.max(2, parseInt(arg('test-every', '10'), 10) || 10);

const corpusDir = path.join(CORPUS_ROOT, SLUG);
const cleanPath = path.join(corpusDir, 'manifest.clean.json');
const manifest = JSON.parse(readFileSync(cleanPath, 'utf8'));

// Пустой корпус — ПРОВАЛ, а не «ноль проблем» (класс EXP-0042).
if (!manifest.clips?.length) {
  console.error(`❌ В ${cleanPath} ноль клипов — обучать не на чем.`);
  process.exit(1);
}

const outDir = path.join(TRAIN_ROOT, SLUG);
const dirs = {
  positive_train: path.join(outDir, 'positive_train'),
  positive_test: path.join(outDir, 'positive_test'),
  negative_train: path.join(outDir, 'negative_train'),
  negative_test: path.join(outDir, 'negative_test'),
};
rmSync(outDir, { recursive: true, force: true });
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const clips = [...manifest.clips].sort((a, b) => a.file.localeCompare(b.file));
const counts = { positive_train: 0, positive_test: 0, negative_train: 0, negative_test: 0 };

// Счётчики ведутся ОТДЕЛЬНО для положительных и отрицательных, иначе шаг «каждый N-й» сместится:
// в общем списке негативы идут сплошным блоком и выбрали бы себе непропорциональную долю теста.
let iPos = 0, iNeg = 0;
for (const c of clips) {
  const positive = c.file.startsWith('positive/');
  const idx = positive ? iPos++ : iNeg++;
  const isTest = idx % TEST_EVERY === 0;
  const key = `${positive ? 'positive' : 'negative'}_${isTest ? 'test' : 'train'}`;
  copyFileSync(path.join(corpusDir, c.file), path.join(dirs[key], path.basename(c.file)));
  counts[key]++;
}

// --- Конфиг обучения -------------------------------------------------------------------------------
// Значения взяты из эталонного `examples/custom_model.yml` апстрима; отклонения помечены и объяснены
// прямо в тексте конфига — конфиг читает человек, и «почему так» должно лежать рядом со значением.
const yml = (p) => p.replace(/\\/g, '/');   // YAML не любит windows-слэши в неэкранированных строках

const config = `## Конфиг обучения активатора «${manifest.word}» — KLAS, план 19.
## Сгенерирован tools/voice/wakeword-prepare-training.mjs, править ЗДЕСЬ бессмысленно:
## перегенерируется. Меняй генератор.

model_name: "${SLUG}"

target_phrase:
  - "${manifest.word}"

# ПУСТО НАМЕРЕННО, и вот почему. Этот ключ читает только стадия --generate_clips (апстрим по нему
# синтезирует трудные негативы через piper-sample-generator), а её мы не запускаем. Наши трудные
# негативы уже ЛЕЖАТ В КОРПУСЕ озвученными, и найдены они замером, а не придуманы: охранник
# (wakeword-corpus-verify.mjs) сам показал, какие настоящие русские слова звучат ближе всего к имени —
# для «Джарвиса» это «дарвин» (2 правки) и «сервис», для «Джой» — «джон» (1 правка), «мой», «твой»,
# «домой», «джем», «джаз». Заполнять ключ бессмысленно: он не будет прочитан.
custom_negative_phrases: []

# ⚠️ Апстрим рекомендует минимум 20 000 положительных, а лучше 100 000+. У нас ${counts.positive_train + counts.positive_test}.
# Это НИЖНЯЯ планка, и её надо помнить при чтении метрик: недобор данных выглядит как слабая модель.
# Ключи n_samples/n_samples_val нужны только стадии --generate_clips, которую мы НЕ запускаем
# (клипы свои), и оставлены для совместимости с парсером конфига.
n_samples: ${counts.positive_train}
n_samples_val: ${counts.positive_test}
tts_batch_size: 50

augmentation_batch_size: 16

# Стадия --generate_clips не запускается, поэтому путь к их генератору не используется.
piper_sample_generator_path: "./piper-sample-generator"

output_dir: "${yml(TRAIN_ROOT)}"

rir_paths:
  - "${yml(path.join(DATA_ROOT, 'mit_rirs'))}"

background_paths:
  - "${yml(path.join(DATA_ROOT, 'audioset'))}"
  - "${yml(path.join(DATA_ROOT, 'fma'))}"

background_paths_duplication_rate:
  - 1
  - 1

false_positive_validation_data_path: "${yml(path.join(DATA_ROOT, 'features', 'validation_set_features.npy'))}"

# 2 вместо эталонной 1: аугментация случайна, поэтому один и тот же исходный клип, прогнанный дважды,
# даёт ДВА разных обучающих примера. Это удваивает материал без единой секунды нового синтеза —
# самый дешёвый способ компенсировать наш недобор до рекомендованных 20 000.
augmentation_rounds: 2

feature_data_files:
  "ACAV100M_sample": "${yml(path.join(DATA_ROOT, 'features', 'openwakeword_features_ACAV100M_2000_hrs_16bit.npy'))}"

batch_n_per_class:
  "ACAV100M_sample": 1024
  "adversarial_negative": 50
  "positive": 50

model_type: "dnn"
layer_size: 32

steps: 50000
max_negative_weight: 1500

# Целимся в 0.2 ложных срабатывания в час — как эталонный конфиг. Отраслевая планка продакшна 1.0,
# то есть запас есть; ужесточать проще, чем потом объяснять владельцу ложные побудки.
target_false_positives_per_hour: 0.2
`;

const configPath = path.join(outDir, 'training_config.yml');
writeFileSync(configPath, config, 'utf8');

console.log(`Слово: «${manifest.word}»  (${SLUG})`);
console.log(`Источник: ${cleanPath}`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);
console.log(`Конфиг: ${configPath}`);

// --- Охранник --------------------------------------------------------------------------------------
const problems = [];
if (counts.positive_train < 100) problems.push(`положительных для обучения всего ${counts.positive_train}`);
if (counts.positive_test < 10) problems.push(`положительных для проверки всего ${counts.positive_test}`);
if (counts.negative_train < 10) problems.push(`отрицательных для обучения всего ${counts.negative_train}`);
if (problems.length) {
  console.error('\n❌ РАСКЛАДКА НЕГОДНА: ' + problems.join(' · '));
  process.exit(1);
}
console.log('\n✅ Раскладка готова. Дальше — стадии --augment_clips и --train_model апстрима.');
