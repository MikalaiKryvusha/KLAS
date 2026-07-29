// tools/gateway-churn-probe.mjs — МИНИМАЛЬНЫЙ ВОСПРОИЗВОДИТЕЛЬ падения гейтвея (bugs/15).
//
// Гипотеза после двух падений 2026-07-29: гейтвей OpenClaw не переживает БЫСТРУЮ СМЕНУ СЕССИЙ.
// Оба раза он умирал во время прогона `voice-bench`, который создаёт новую сессию на каждый кейс,
// а трасса подготовки показывает ~10 с работы на сессию (`bundle-tools` 6.8 с из них).
//
// Почему отдельный стенд, а не «погоняем бенч ещё раз»: бенч тащит рот, уши, файлы и воспроизведение.
// Если падение повторится ЗДЕСЬ — виноват гейтвей и смена сессий, а весь голосовой тракт оправдан.
// Если НЕ повторится — гипотеза неверна, и подозрение возвращается к тракту. Стенд отвечает на
// вопрос «кто виноват» одним прогоном вместо череды догадок (EXP-0008: подними отдельно и посмотри).
//
// Запуск:
//   node tools/gateway-churn-probe.mjs            # 12 НОВЫХ сессий подряд
//   node tools/gateway-churn-probe.mjs 20         # столько, сколько скажут
//   node tools/gateway-churn-probe.mjs 12 --same  # контроль: столько же ходов в ОДНОЙ сессии
//
// ⚠️ Стенд намеренно НЕ поднимает гейтвей обратно: состояние после падения — улика.
// [TESTED: 2026-07-29 · 12 ходов с НОВОЙ сессией на каждый — гейтвей пережил все (7.5–9.7 с/ход,
//  все finish_reason=stop) ⇒ гипотеза «не переживает смену сессий» ОПРОВЕРГНУТА. Стенд исправен:
//  печатает число процессов гейтвея по данным ОС после каждого хода, то есть смерть заметил бы]

import { gatewayToken } from './voice/pipeline.mjs';
import { execSync, spawn } from 'node:child_process';
import os from 'node:os';

const GATEWAY_URL = 'http://127.0.0.1:18789/v1/chat/completions';
const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 12);
const SAME_SESSION = process.argv.includes('--same');
// `--load`: занять ядра посторонней работой. Оба падения 2026-07-29 случились при загруженном CPU
// (рот и уши считают на тех же ядрах, что и гейтвей), а сам по себе churn его не убивает — значит
// следующий подозреваемый именно голодание событийного цикла. Утром в логе была ровно такая улика:
// `diagnostic: liveness warning … event_loop_delay`.
const LOAD = process.argv.includes('--load');

/** Жив ли процесс гейтвея прямо сейчас — спрашиваем ОС, а не догадываемся по ошибке fetch. */
function gatewayProcessCount() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ' +
      'Where-Object { $_.CommandLine -match \'openclaw.*gateway\\s+run\' } | Measure-Object).Count"',
      { encoding: 'utf8', timeout: 30000 },
    );
    return Number(out.trim());
  } catch { return -1; }
}

/** Один ход. Возвращает {ok, ms, finishReason, chars, error}. */
async function turn(sessionKey, question) {
  const t0 = performance.now();
  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewayToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaw/default',
        stream: true,
        user: sessionKey,
        messages: [{ role: 'user', content: question }],
      }),
    });
    if (!res.ok) return { ok: false, ms: performance.now() - t0, error: `HTTP ${res.status}` };
    const dec = new TextDecoder();
    let text = '', finishReason = null;
    for await (const chunk of res.body) {
      for (const line of dec.decode(chunk, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6).trim();
        if (p === '[DONE]') continue;
        let e; try { e = JSON.parse(p); } catch { continue; }
        const fr = e.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        text += e.choices?.[0]?.delta?.content ?? '';
      }
    }
    return { ok: true, ms: performance.now() - t0, finishReason, chars: text.trim().length };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, error: String(e.message || e) };
  }
}

const QUESTIONS = [
  'Назови столицу Беларуси одним словом.',
  'Сколько будет два плюс два? Только число.',
  'Назови одну реку Беларуси.',
  'Скажи «привет» одним словом.',
];

// Нагрузка на ядра: отдельные процессы с бесконечным счётом. Именно ПРОЦЕССЫ, а не потоки внутри
// стенда, — иначе я загружу собственный событийный цикл и буду мерить свою же медлительность.
const loaders = [];
if (LOAD) {
  const workers = Math.max(1, os.cpus().length - 1);
  for (let i = 0; i < workers; i++) {
    loaders.push(spawn(process.execPath, ['-e', 'while(true){Math.sqrt(Math.random())}'], { stdio: 'ignore' }));
  }
  console.log(`нагрузка: ${workers} процессов заняли ядра (всего ядер ${os.cpus().length})`);
}
const stopLoad = () => { for (const p of loaders) { try { p.kill(); } catch { /* уже мёртв */ } } };
process.on('exit', stopLoad);

console.log(`=== СТЕНД СМЕНЫ СЕССИЙ (bugs/15) === ходов: ${N} · режим: ${SAME_SESSION ? 'ОДНА сессия (контроль)' : 'НОВАЯ сессия на каждый ход'}${LOAD ? ' · CPU ЗАГРУЖЕН' : ''}`);
console.log(`процессов гейтвея до старта: ${gatewayProcessCount()}\n`);
console.log('#   сессия        мс      finish      симв.  процессов  примечание');

const stamp = Date.now();
let died = 0;
for (let i = 1; i <= N; i++) {
  const key = SAME_SESSION ? `churn-same-${stamp}` : `churn-${stamp}-${i}`;
  const r = await turn(key, QUESTIONS[i % QUESTIONS.length]);
  const procs = gatewayProcessCount();
  console.log(
    `${String(i).padEnd(4)}${(SAME_SESSION ? 'одна' : `#${i}`).padEnd(14)}${String(Math.round(r.ms)).padEnd(8)}` +
    `${String(r.finishReason ?? '—').padEnd(12)}${String(r.chars ?? '—').padEnd(7)}${String(procs).padEnd(11)}` +
    `${r.ok ? '' : `❌ ${r.error}`}`,
  );
  if (procs === 0) {
    died = i;
    console.log(`\n💀 ГЕЙТВЕЙ УМЕР на ходе ${i} из ${N}. Процесса нет.`);
    console.log('   Улика: F:\\KLAS\\logs\\gateway-*.out.log (последние строки) и %TEMP%\\openclaw\\openclaw-<дата>.log');
    break;
  }
}

stopLoad();
if (!died) console.log(`\n✅ Гейтвей пережил все ${N} ходов (${SAME_SESSION ? 'одна сессия' : 'новых сессий'}${LOAD ? ', CPU загружен' : ''}). Гипотеза этим прогоном НЕ подтверждена.`);
console.log('\n⚠️ Стенд намеренно НЕ поднимает гейтвей обратно: состояние после падения — улика.');
console.log('   Поднять: powershell -File F:\\KLAS\\tools\\klas.ps1 -Action up');
