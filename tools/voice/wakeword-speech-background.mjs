// tools/voice/wakeword-speech-background.mjs — ФОН ИЗ СОБСТВЕННОЙ РЕЧИ АССИСТЕНТА для обучения
// активаторов (`bugs/25`, `plans/20` шаг 4).
//
// Зачем. Замер `researches/23` §0 показал, ЧТО именно ломает активатор, и это оказался не шум:
//   широкополосный шум      — 0.92–0.98 даже когда он всего на 12 дБ тише имени (не мешает вовсе);
//   речь ассистента         — 0.005/0.102 при равных уровнях (глухота).
// Учили их именно так: шумовая аугментация была (негативы ACAV100M, комнаты MIT), конкурирующей
// РЕЧИ не было. Значит лечение — не досыпать шума, а положить в фон обучения речь нашего же рта.
//
// Почему это сработает. Обучатель подмешивает фон при SNR ОТ −10 дБ
// (`openwakeword/data.py:645`, `min_snr_in_db=-10`), то есть боевой случай «ассистент звучит не
// тише человека» покрывается штатно — не надо ни трогать апстрим, ни выдумывать свой конвейер.
//
// ⛔ ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА: во фразах фона НЕТ имён «Джарвис» и «Джой». Фон подмешивается к
// положительным примерам как ПОМЕХА, и имя, попавшее в помеху, учило бы модель ИГНОРИРОВАТЬ
// собственное имя — то есть ровно ломало бы то, ради чего всё делается. Охранник ниже проверяет
// это машинно и отказывается писать корпус, если имя просочилось.
//
// Запуск:
//   node tools/voice/wakeword-speech-background.mjs [--minutes 25] [--clip-sec 10]
//
// Результат: F:\KLAS\voice\wakeword\data\background_speech\*.wav (16 кГц, моно, по 10 с) —
// тот же формат, что у шумового фона рядом.
//
// [NOT-TESTED]

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TtsDaemon } from './tts-daemon.mjs';

const OUT_DIR = 'F:\\KLAS\\voice\\wakeword\\data\\background_speech';
const TMP_DIR = 'F:\\KLAS\\voice\\out\\bgspeech-tmp';
const SR = 16000;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MINUTES = parseFloat(arg('minutes', '25'));
const CLIP_SEC = parseFloat(arg('clip-sec', '10'));

// Голоса тракта. Джарвис говорит `eugene`, Джой — `xenia`; ещё два добавлены ради разнообразия
// тембра — помеха не обязана быть ровно одним диктором, а модель не должна цепляться за тембр.
const VOICES = ['eugene', 'xenia', 'baya', 'aidar'];

// Реплики в стиле ответов ассистента: короткие, разговорные, без markdown — такие он и произносит.
// Имён активаторов здесь нет и быть не может (см. охранник ниже).
const LINES = [
  'Готов помочь, сэр. Что нужно сделать?',
  'Все системы работают в штатном режиме.',
  'Сейчас посмотрю и скажу точнее.',
  'Температура в комнате двадцать два градуса Цельсия.',
  'Задача выполнена, ошибок нет.',
  'Я здесь и слушаю вас внимательно.',
  'Погода сегодня облачная, ветер слабый.',
  'Напоминаю: встреча начнётся через пятнадцать минут.',
  'Файл сохранён, всё в порядке.',
  'Могу повторить, если было плохо слышно.',
  'Свободного места на диске осталось сорок гигабайт.',
  'Хорошо, я запомнил это и вернусь к нему позже.',
  'Сейчас проверю почту и расскажу, что пришло.',
  'Звонок завершён, разговор длился восемь минут.',
  'Мне кажется, стоит сделать небольшой перерыв.',
  'Список покупок обновлён, добавлено три пункта.',
  'Свет в комнате выключен, как вы и просили.',
  'Музыка поставлена на паузу.',
  'Я нашёл несколько вариантов, рассказать подробнее?',
  'Соединение восстановлено, всё снова работает.',
  'Это займёт около двух минут, подождите немного.',
  'Никаких новых сообщений за последний час.',
  'Батарея заряжена на семьдесят процентов.',
  'Понял вас, приступаю прямо сейчас.',
  'Кажется, тут есть ошибка, я её исправлю.',
  'Расписание на завтра свободно после полудня.',
  'Прогноз обещает дождь ближе к вечеру.',
  'Документ отправлен, получатель уведомлён.',
  'Я обновил настройки, изменения уже действуют.',
  'Могу предложить более простой способ.',
  'Резервная копия создана сегодня утром.',
  'Скорость соединения сто пятнадцать килобайт в секунду.',
  'Всё готово, можете проверять.',
  'Если что-то пойдёт не так, я сразу скажу.',
  'Сейчас включу и настрою нужный режим.',
  'Эта задача займёт больше времени, чем обычно.',
  'Я слушаю, продолжайте пожалуйста.',
  'Отмена выполнена, ничего не изменилось.',
  'Напоминание установлено на девять утра.',
  'Кажется, вы это уже спрашивали недавно.',
  'Хорошо, тогда сделаем по-другому.',
  'Проверка завершена, проблем не обнаружено.',
  'Мне нужно чуть больше времени на ответ.',
  'Готово. Что-нибудь ещё?',
];

// ── Охранник: имя активатора в фоне недопустимо ──────────────────────────────
// Проверяем ДО синтеза: полчаса счёта, выброшенные из-за одной фразы, — плохая цена невнимательности.
const FORBIDDEN = ['джарвис', 'джой'];
const bad = LINES.filter((l) => FORBIDDEN.some((w) => l.toLowerCase().includes(w)));
if (bad.length) {
  console.error('⛔ В фоновых фразах найдено имя активатора — такой фон учил бы модель ИГНОРИРОВАТЬ');
  console.error('   собственное имя. Убери эти строки:');
  for (const l of bad) console.error(`   · ${l}`);
  process.exit(1);
}

// ── WAV 16 кГц моно ──────────────────────────────────────────────────────────
function readWavMono16k(file) {
  const b = readFileSync(file);
  // Разбор минимальный: наш собственный рот пишет обычный PCM-WAV, экзотики здесь не бывает.
  let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(pos + 10), sr: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    if (id === 'data') { dataOff = pos + 8; dataLen = size; break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !dataOff) throw new Error(`не разобрал wav: ${file}`);
  if (fmt.bits !== 16) throw new Error(`ожидались 16 бит, а тут ${fmt.bits}: ${file}`);
  const n = Math.floor(dataLen / 2 / fmt.ch);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(dataOff + i * fmt.ch * 2);   // берём первый канал
  if (fmt.sr === SR) return out;
  // Линейная передискретизация: фон — помеха, а не эталон; тратить на неё качественный ресемплер
  // незачем, и лишняя зависимость тут была бы лишней сущностью.
  const m = Math.round((n * SR) / fmt.sr);
  const res = new Int16Array(m);
  for (let i = 0; i < m; i++) {
    const t = (i * fmt.sr) / SR, i0 = Math.floor(t), f = t - i0;
    res[i] = Math.round((out[Math.min(i0, n - 1)] * (1 - f)) + (out[Math.min(i0 + 1, n - 1)] * f));
  }
  return res;
}

function writeWav(file, samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i], i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([h, pcm]));
}

// ── Синтез ───────────────────────────────────────────────────────────────────
const tts = new TtsDaemon();
const ready = await tts.ready();
if (ready.stage !== 'ready') {
  console.error(`РОТ не готов: ${ready.stage}. Без него фон не собрать.`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) rmSync(path.join(OUT_DIR, f), { force: true });

const clipSamples = Math.round(CLIP_SEC * SR);
const needSamples = Math.round(MINUTES * 60 * SR);
const gap = Math.round(0.25 * SR);          // пауза между репликами — как в живой речи

console.log(`Собираю фон из речи ассистента: ${MINUTES} мин, клипами по ${CLIP_SEC} с`);
console.log(`  голоса: ${VOICES.join(', ')}   ·   фраз: ${LINES.length}   ·   имён активаторов: нет\n`);

let bufAcc = [];
let accLen = 0, written = 0, produced = 0, spoken = 0;
const t0 = Date.now();

// Порядок ДЕТЕРМИНИРОВАН (никакого Math.random): фраза × голос по кругу. Перезапуск даёт тот же
// корпус, значит два обучения сравнимы — тот же принцип, что в раскладке train/test.
outer:
for (let round = 0; ; round++) {
  for (let li = 0; li < LINES.length; li++) {
    const voice = VOICES[(li + round) % VOICES.length];
    const tmp = path.join(TMP_DIR, `bg-${round}-${li}.wav`);
    const r = await tts.say(LINES[li], tmp, voice);
    if (!r.ok) { console.error(`  пропуск: «${LINES[li]}» (${r.reason ?? r.error})`); continue; }
    spoken++;
    const s = readWavMono16k(tmp);
    rmSync(tmp, { force: true });
    bufAcc.push(s, new Int16Array(gap));
    accLen += s.length + gap;
    produced += s.length + gap;

    while (accLen >= clipSamples) {
      const clip = new Int16Array(clipSamples);
      let off = 0;
      while (off < clipSamples && bufAcc.length) {
        const head = bufAcc[0];
        const take = Math.min(head.length, clipSamples - off);
        clip.set(head.subarray(0, take), off);
        off += take;
        if (take === head.length) bufAcc.shift(); else bufAcc[0] = head.subarray(take);
      }
      accLen -= clipSamples;
      writeWav(path.join(OUT_DIR, `speech-${String(written).padStart(4, '0')}.wav`), clip);
      written++;
      if (written % 20 === 0) process.stdout.write(`  клипов: ${written}\r`);
    }
    if (produced >= needSamples) break outer;
  }
}

tts.stop();
rmSync(TMP_DIR, { recursive: true, force: true });
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✅ Готово: ${written} клипов по ${CLIP_SEC} с в ${OUT_DIR}`);
console.log(`   реплик синтезировано: ${spoken}   ·   потрачено ${sec} с`);
console.log('   дальше: node tools/voice/wakeword-prepare-training.mjs --slug jarvis --cross joy');
