// tools/voice/wake-speaking-probe.mjs — проверка отложенного захвата (`bugs/26`) БЕЗ звука и человека.
//
// Зачем отдельный стенд. Дефект такой: услышав имя во время собственной реплики, слушатель начинал
// писать вопрос в тот же кадр — и в запись попадал хвост нашей же речи из динамика. Лечение —
// дирижёр объявляет «я говорю», а слушатель откладывает захват до тишины. Проверить это прогоном
// `voice-wake.mjs --no-play` НЕЛЬЗЯ: без воспроизведения объявление не отправляется вовсе, и путь
// остаётся непройденным. Прогон СО звуком требует тишины в комнате и разрешения владельца.
//
// Поэтому здесь слушатель запускается напрямую, а роль дирижёра играет этот скрипт: он объявляет
// «говорю», ждёт, объявляет «замолчал» — и смотрит, отложился ли захват на самом деле.
//
// Судится ЧИСЛОМ, а не глазами: слушатель печатает `capture-start` с полем `waited_frames`.
//   ждали 0 кадров  ⇒ захват НЕ откладывался (дефект вернулся);
//   ждали > 0       ⇒ отложился, как задумано.
//
// Запуск: node tools/voice/wake-speaking-probe.mjs [--wav <фикстура>] [--speak-ms 1500]
//
// [NOT-TESTED]

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const PY = 'F:\\KLAS\\voice\\venv-wakeword\\Scripts\\python.exe';
const LISTENER = 'F:\\KLAS\\tools\\voice\\wakeword-listen.py';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const WAV = flag('--wav', 'F:\\KLAS\\voice\\out\\fixture-wake-jarvis.wav');
const SPEAK_MS = Number(flag('--speak-ms', '1500'));

const p = spawn(PY, [LISTENER, '--wav', WAV, '--realtime', '--parent'], { windowsHide: true });
p.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.error(`[слушатель] ${s.slice(0, 200)}`); });

let wakeAt = null;
let captureStart = null;
let utterance = null;

readline.createInterface({ input: p.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }

  if (m.stage === 'ready') {
    // Объявляем, что ассистент говорит, ДО первого кадра: именно в этом состоянии и ловится дефект.
    console.log('дирижёр: «я говорю»');
    p.stdin.write('{"cmd":"speaking","on":true}\n');
    return;
  }
  if (m.event === 'wake') {
    wakeAt = Date.now();
    console.log(`услышано имя «${m.detector}» (${m.score}) — захват должен ОТЛОЖИТЬСЯ`);
    // Через заданное время объявляем, что замолчали: так ведёт себя дирижёр, убивший проигрывателя.
    setTimeout(() => {
      console.log(`дирижёр: «я замолчал» (через ${SPEAK_MS} мс)`);
      p.stdin.write('{"cmd":"speaking","on":false}\n');
    }, SPEAK_MS);
    return;
  }
  if (m.event === 'capture-start') {
    captureStart = m;
    console.log(`захват начался, ждали кадров: ${m.waited_frames}`);
    return;
  }
  if (m.event === 'utterance') { utterance = m; return; }
  if (m.event === 'empty') { utterance = { empty: true, ...m }; return; }
  if (m.stage === 'eof') p.stdin.end();
});

p.on('close', () => {
  const ok = [];
  const bad = [];
  (wakeAt ? ok : bad).push('имя услышано');
  if (!captureStart) bad.push('события capture-start НЕ было — захват не откладывался');
  else (captureStart.waited_frames > 0 ? ok : bad).push(`захват отложен (ждали ${captureStart.waited_frames} кадров)`);
  (utterance ? ok : bad).push('фраза захвачена после тишины');

  console.log('\n=== Итог ===');
  for (const s of ok) console.log(`  OK    ${s}`);
  for (const s of bad) console.log(`  ПРОВАЛ ${s}`);
  console.log(utterance?.wav ? `  файл: ${utterance.wav} (${utterance.sec} с)` : '');
  process.exit(bad.length ? 1 : 0);
});
