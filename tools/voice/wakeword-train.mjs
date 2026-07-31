// tools/voice/wakeword-train.mjs — ЗАПУСК обучения активатора на видеокарте (план 19, шаг 2).
//
// Оркеструет ДВЕ стадии апстрима (`openwakeword.train`), пропуская первую:
//   --generate_clips  ⛔ НЕ запускаем: это их синтез через piper-sample-generator (Linux-зависимость).
//                        Клипы у нас свои, разложены `wakeword-prepare-training.mjs`.
//   --augment_clips   ✅ реверберация комнатами MIT + подмешивание фонового шума, затем вычисление
//                        фич. Тут появляются positive_features_train.npy и соседи.
//   --train_model     ✅ собственно обучение на GPU + экспорт .onnx.
//
// ⚠️ ОЖИДАЕМОЕ ПАДЕНИЕ В САМОМ КОНЦЕ — не поломка, знай о нём заранее.
// `train.py:901` БЕЗУСЛОВНО зовёт `convert_onnx_to_tflite()`, а тот импортирует `tensorflow` и
// `onnx_tf` (версии 2022 года: `tensorflow-cpu==2.8.1`, `onnx-tf==1.10.0`). Мы их намеренно не
// ставили — под Python 3.14 их и нет, а наш рантайм ONNX-овый, tflite не нужен (`researches/22` §5).
// Ключевое: экспорт ONNX идёт СТРОКОЙ ВЫШЕ (`train.py:898`), то есть к моменту падения нужная нам
// модель УЖЕ НА ДИСКЕ. Поэтому судим не по коду возврата, а по НАЛИЧИЮ ФАЙЛА — код возврата здесь
// врёт в худшую сторону, и слепое доверие ему выбросило бы удачное обучение.
//
// Запуск:
//   node tools/voice/wakeword-train.mjs --slug jarvis            # обе стадии
//   node tools/voice/wakeword-train.mjs --slug jarvis --stage augment
//   node tools/voice/wakeword-train.mjs --slug jarvis --stage train
//
// [NOT-TESTED] — родился 2026-07-31.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const PY = 'F:\\KLAS\\voice\\venv-wakeword\\Scripts\\python.exe';
const SHIM = 'F:\\KLAS\\tools\\voice\\wakeword-train-shim.py';
const TRAIN_ROOT = 'F:\\KLAS\\voice\\wakeword\\training';
const DATA_ROOT = 'F:\\KLAS\\voice\\wakeword\\data';

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const SLUG = arg('slug', 'jarvis');
const STAGE = arg('stage', 'all');           // all | augment | train

const workDir = path.join(TRAIN_ROOT, SLUG);
const configPath = path.join(workDir, 'training_config.yml');
const onnxPath = path.join(TRAIN_ROOT, `${SLUG}.onnx`);

// --- Предполётная проверка ------------------------------------------------------------------------
// Дешевле упасть здесь за секунду, чем через час обучения на отсутствующем файле.
const required = [
  [configPath, 'конфиг обучения — прогони wakeword-prepare-training.mjs'],
  [path.join(workDir, 'positive_train'), 'каталог положительных клипов'],
  [path.join(DATA_ROOT, 'mit_rirs'), 'импульсные характеристики комнат — прогони wakeword-fetch-data.py'],
  [path.join(DATA_ROOT, 'features', 'validation_set_features.npy'), 'набор проверки ложных срабатываний'],
];
if (STAGE !== 'augment') {
  required.push([
    path.join(DATA_ROOT, 'features', 'openwakeword_features_ACAV100M_2000_hrs_16bit.npy'),
    'предвычисленные негативы ACAV100M (16.09 ГБ)',
  ]);
}
const missing = required.filter(([p]) => !existsSync(p));
if (missing.length) {
  console.error('❌ Нет обязательного:');
  for (const [p, why] of missing) console.error(`   ${p}\n     — ${why}`);
  process.exit(1);
}

// Отдельно ловим ОБРЕЗАННЫЙ большой файл: он существует, но недокачан — самый коварный случай,
// потому что проверка «файл есть» его пропускает, а обучение падает через час.
const bigPath = path.join(DATA_ROOT, 'features', 'openwakeword_features_ACAV100M_2000_hrs_16bit.npy');
if (STAGE !== 'augment' && existsSync(bigPath)) {
  const gb = statSync(bigPath).size / 1024 ** 3;
  if (gb < 16) {
    console.error(`❌ Негативы ACAV100M недокачаны: ${gb.toFixed(2)} ГБ из 16.09 — дождись загрузки.`);
    process.exit(1);
  }
}

function runStage(flag, label) {
  console.log(`\n${'='.repeat(70)}\n▶ ${label}\n${'='.repeat(70)}`);
  const t0 = Date.now();
  // Зовём НЕ `-m openwakeword.train`, а нашу прокладку: пакет `acoustics` (нужен обучателю ради
  // одной строки генерации шума) при импорте падает на `scipy.special.sph_harm`, которого в
  // scipy 1.18 больше нет. Прокладка восстанавливает функцию поверх `sph_harm_y` и делегирует
  // настоящему обучателю — апстрим не форкаем (класс EXP-0038, подробности в шапке шима).
  const r = spawnSync(PY, [SHIM, '--training_config', configPath, flag], {
    stdio: 'inherit',
    cwd: 'F:\\KLAS',
  });
  const min = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n(${label}: код возврата ${r.status}, ${min} мин)`);
  return r.status;
}

let augStatus = null;
let trainStatus = null;

if (STAGE === 'all' || STAGE === 'augment') {
  augStatus = runStage('--augment_clips', 'Стадия 1 — аугментация (реверберация + шум) и вычисление фич');
  const feat = path.join(workDir, 'positive_features_train.npy');
  if (!existsSync(feat)) {
    console.error(`\n❌ Аугментация не дала ${path.basename(feat)} — дальше идти нельзя.`);
    process.exit(1);
  }
  console.log(`✅ Фичи получены: ${(statSync(feat).size / 1024 ** 2).toFixed(1)} МБ`);
}

if (STAGE === 'all' || STAGE === 'train') {
  trainStatus = runStage('--train_model', 'Стадия 2 — обучение на видеокарте и экспорт ONNX');
}

// --- Вердикт по ФАЙЛУ, а не по коду возврата ------------------------------------------------------
if (STAGE === 'all' || STAGE === 'train') {
  if (existsSync(onnxPath)) {
    const kb = (statSync(onnxPath).size / 1024).toFixed(1);
    console.log(`\n✅ МОДЕЛЬ ОБУЧЕНА: ${onnxPath} — ${kb} КБ`);
    if (trainStatus !== 0) {
      console.log('   ⚠️ Ненулевой код возврата ОЖИДАЕМ: апстрим последней строкой конвертирует в');
      console.log('      tflite через TensorFlow, которого у нас нет намеренно. ONNX сохранён строкой');
      console.log('      выше и цел — судим по файлу, а не по коду (см. шапку этого скрипта).');
    }
    console.log('\nДальше — замер: voice\\venv-wakeword\\Scripts\\python.exe tools/voice/wakeword-probe.py');
  } else {
    console.error(`\n❌ ОБУЧЕНИЕ НЕ ДАЛО МОДЕЛИ: ${onnxPath} отсутствует (код возврата ${trainStatus}).`);
    console.error('   Это НАСТОЯЩИЙ провал, а не ожидаемый хвост с tflite: читай вывод выше.');
    process.exit(1);
  }
}
