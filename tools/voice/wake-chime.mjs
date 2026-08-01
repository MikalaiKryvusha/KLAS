// tools/voice/wake-chime.mjs — СИГНАЛЫ «СЛУШАЮ»: генератор и выслушка вариантов.
//
// Зачем. Владелец на живом тесте 2026-08-01: «звуковой сигнал активации имени сейчас неприятный,
// пик какой-то, нужны варианты приятных мягких сигналов. И после фразы ИИ нужно этот же сигнал
// подавать — то есть, когда 5 секунд слушания начинаются, чтобы я понимал, что опять могу говорить».
//
// Почему нынешний звук «пикает». Он был написан как СЛУЖЕБНЫЙ, а не как приглашение: синус 880 Гц,
// 0.15 с, атака 10 мс (`voice-wake.mjs`, ensureBeep). Резкий старт даёт щелчок-удар, высокая частота
// режет ухо, короткая длительность читается как «ошибка», а не как «говорите». Кандидаты ниже
// двигают ровно эти три ручки: ниже частота · медленная атака · тёплый обертон вместо голого синуса.
//
// ⚠️ СИГНАЛ ОБЯЗАН ОСТАВАТЬСЯ НЕРЕЧЕВЫМ. Он звучит в ту же комнату, где слушает активатор, и попадёт
// в микрофон. Замер `researches/23` §0: широкополосный шум детектору безразличен (0.986 на любом
// уровне), а РЕЧЬ ломает его наглухо. Поэтому здесь только тоны — никаких голосов, слов и хора.
//
// Собирается КОДОМ, а не хранится файлом: бинарник в git ради трети секунды синуса — лишняя
// сущность, а генератор И ЕСТЬ воспроизводимый исходник (то же основание, что у бипа).
//
// Запуск:
//   node tools/voice/wake-chime.mjs              ← собрать все варианты + склейку на выслушку
//   node tools/voice/wake-chime.mjs --play soft  ← послушать один (звук в комнате!)
//   node tools/voice/wake-chime.mjs --play all   ← послушать склейку подряд
//
// [NOT-TESTED] — судит ухо владельца, а не агент: «приятное» это перцептивный критерий (класс TASTE).

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const OUT = 'F:\\KLAS\\voice\\out\\chimes';
const SR = 16000;
const args = process.argv.slice(2);
const playArg = (() => { const i = args.indexOf('--play'); return i >= 0 ? args[i + 1] : null; })();

// Пиковая амплитуда ОДНА на все варианты: сравнивать надо тембр, а не громкость. Человек, слушая
// два звука разной громкости, сравнивает громкость — этот урок уже оплачен на выслушке голосов
// (`normalize-loudness.mjs`). 5000 из 32767 — заметно тише прежнего бипа (было 9000).
const PEAK = 5000;

/**
 * Один тон с мягкой огибающей.
 * @param {number} f      частота, Гц
 * @param {number} sec    длительность
 * @param {number} attack доля длительности на нарастание — ГЛАВНАЯ ручка «мягкости»:
 *                        резкий старт и есть тот самый «пик»
 * @param {number} amp    относительная амплитуда (0..1)
 * @param {number[]} partials обертоны как доли от основного тона: [1, 0.3] = основной + тихая октава
 */
function tone(f, sec, attack, amp, partials = [1]) {
  const n = Math.round(SR * sec);
  const out = new Float64Array(n);
  const aN = Math.max(1, Math.round(n * attack));
  for (let i = 0; i < n; i++) {
    // Нарастание — половина косинуса (без излома), спад — экспонента: так звучит удар по струне
    // или колокольчик, а не включение генератора.
    const env = i < aN
      ? 0.5 * (1 - Math.cos((Math.PI * i) / aN))
      : Math.exp(-3.2 * ((i - aN) / (n - aN)));
    let s = 0;
    for (let k = 0; k < partials.length; k++) s += partials[k] * Math.sin((2 * Math.PI * f * (k + 1) * i) / SR);
    out[i] = (s / partials.reduce((a, b) => a + b, 0)) * env * amp;
  }
  return out;
}

const silence = (sec) => new Float64Array(Math.round(SR * sec));

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float64Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Смешать наложением (для аккордов): длина по самому длинному.
function mix(parts) {
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float64Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

// ── Кандидаты ────────────────────────────────────────────────────────────────
// Ноты взяты из равномерного строя: A4=440. Интервалы выбраны «спокойные» — квинта и большая терция
// звучат как приглашение, а секунда или тритон тревожно.
const CANDIDATES = {
  // 1. Один мягкий тон пониже. Самое скромное изменение против нынешнего: та же идея, но без «пика».
  soft: () => tone(523.25, 0.34, 0.28, 1, [1, 0.25]),                       // до второй октавы + октава

  // 2. Две ноты вверх — «слушаю». Восходящий ход человек читает как вопрос/приглашение.
  rise: () => concat([tone(440, 0.16, 0.3, 0.9, [1, 0.2]), tone(659.25, 0.3, 0.25, 1, [1, 0.2])]),

  // 3. Две ноты вниз — «готово». Нисходящий ход читается как завершение; здесь для сравнения.
  fall: () => concat([tone(659.25, 0.16, 0.3, 0.9, [1, 0.2]), tone(440, 0.3, 0.25, 1, [1, 0.2])]),

  // 4. Тёплый: основной тон и тихая квинта одновременно, длинный спад. Похоже на камертон.
  warm: () => mix([tone(392, 0.5, 0.35, 1, [1, 0.3, 0.1]), tone(587.33, 0.5, 0.4, 0.35, [1, 0.2])]),

  // 5. Стеклянный колокольчик: высокий, но с очень медленной атакой и длинным затуханием —
  //    проверяем, дело в частоте или всё-таки в атаке.
  glass: () => mix([tone(880, 0.55, 0.22, 0.8, [1, 0.15, 0.08]), tone(1318.5, 0.5, 0.3, 0.25)]),

  // 6. Совсем тихий выдох: низкий тон, очень мягкий, почти на грани слышимости.
  breath: () => tone(329.63, 0.45, 0.45, 0.85, [1, 0.4, 0.15]),
};

function toWav(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * PEAK))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const play = (file) => spawnSync('powershell', ['-NoProfile', '-Command',
  `(New-Object Media.SoundPlayer '${file}').PlaySync()`], { stdio: 'ignore' });

// ── Сборка ───────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const names = Object.keys(CANDIDATES);

if (playArg && playArg !== 'all') {
  const f = path.join(OUT, `${playArg}.wav`);
  if (!CANDIDATES[playArg]) { console.error(`нет варианта «${playArg}». Есть: ${names.join(', ')}`); process.exit(1); }
  writeFileSync(f, toWav(CANDIDATES[playArg]()));
  console.log(`играю «${playArg}»`);
  play(f);
  process.exit(0);
}

for (const n of names) writeFileSync(path.join(OUT, `${n}.wav`), toWav(CANDIDATES[n]()));

// Склейка на выслушку: пауза 1.2 с между вариантами — достаточно, чтобы ухо отпустило предыдущий,
// и мало, чтобы не забыть его. Порядок печатается: без него склейка бесполезна.
const glued = concat(names.flatMap((n, i) => (i ? [silence(1.2), CANDIDATES[n]()] : [CANDIDATES[n]()])));
const allFile = path.join(OUT, 'all.wav');
writeFileSync(allFile, toWav(glued));

console.log(`Варианты сигнала «слушаю» — ${OUT}`);
names.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
console.log(`\nСклейка подряд: ${allFile}`);
console.log('Послушать:  node tools/voice/wake-chime.mjs --play all   (или --play <имя>)');

if (playArg === 'all') { console.log('\nиграю склейку'); play(allFile); }
