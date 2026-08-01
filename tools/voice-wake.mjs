#!/usr/bin/env node
// tools/voice-wake.mjs — «ИМЯ ОТКРЫВАЕТ РАЗГОВОР» (план 19, шаг 5).
//
// Что изменилось против `voice-talk.mjs`: там разговор начинался нажатием Enter, здесь — ИМЕНЕМ.
// Сказал «Джарвис» — отвечает Джарвис своим голосом и характером; сказал «Джой» — отвечает Джой.
// Слово-активатор выбирает персону целиком (голос + промпт + своя беседа у ядра), поэтому две
// обученные модели — это фича переключения персон, а не дублирование (`researches/16` §5).
//
// Каскад: слушатель (`tools/voice/wakeword-listen.py`: детекция + захват фразы) → УШИ (GigaAM) →
// ЯДРО (резидентный гейтвей, SSE) → РОТ (резидентный Silero, диктор персоны) → динамики.
// Ход исполняет ОБЩИЙ конвейер `tools/voice/pipeline.mjs` — тот же, что у `voice-talk` и у бенча.
//
// ⭐ ДВА РЕШЕНИЯ ВЛАДЕЛЬЦА (2026-08-01, чат) — они и определили поведение:
//   1. «Слушать всегда, имя перебивает». Детектор НЕ глушится, пока ассистент говорит: услышал имя
//      посреди своей реплики — немедленно замолкает и слушает. Честная цена названа владельцу до
//      выбора: AEC у нас нет, значит детектор слышит и СОБСТВЕННЫЙ голос из колонок (EXP-0017), и
//      ложное самоперебивание возможно. Каждое перебивание печатается с оценкой — чтобы это было
//      видно, а не гадаемо. Обратный режим оставлен флагом `--mute-while-speaking`.
//   2. Сигнал сразу после имени — «услышал». Не голосом: голос стоил бы ~1 с на каждое обращение.
//      ⚠️ Первый вариант (синус 880 Гц, атака 10 мс) владелец забраковал вживую: «неприятный, пик
//      какой-то». Заменён семейством колокольчиков (`homeworks/05`), тембры — в `wake-chime.mjs`.
//      Ролей у сигнала две и звучат они по-разному: ОТКРЫТИЕ слушания (`--chime-open`, по умолчанию
//      `bell`) и ЗАКРЫТИЕ, когда позвали и промолчали (`--chime-close`, по умолчанию `bell-deep` —
//      выбран владельцем). Нисходящий тембр на закрытии — его прямое требование: без него молчание
//      неотличимо от «он всё ещё ждёт».
//
// Использование:
//   node tools/voice-wake.mjs                       → слушать микрофон, пока не Ctrl+C
//   node tools/voice-wake.mjs --wav фикстура.wav    → прогон БЕЗ микрофона и БЕЗ человека (харнесс)
//   node tools/voice-wake.mjs --wav ф.wav --realtime → то же, но в темпе живой речи (проверки на время)
//   node tools/voice-wake.mjs --no-play             → не проигрывать ответ (тихий тест)
//   node tools/voice-wake.mjs --device "имя dshow-микрофона"
//   node tools/voice-wake.mjs --voice-joy baya      → сменить голос-заглушку Джой (см. personas.mjs)
//   node tools/voice-wake.mjs --ears punct          → уши с пунктуацией и латиницей (bugs/10)
//   node tools/voice-wake.mjs --threshold 0.6       → строже к срабатыванию
//   node tools/voice-wake.mjs --mute-while-speaking → не слушать, пока говорит сам (без перебивания)
//
// ⚠️ Требуется ПОДНЯТЫЙ гейтвей OpenClaw (`powershell -File tools\klas.ps1 -Action up`).
// [NOT-TESTED на живом микрофоне] — сквозной прогон из файла пройден 2026-08-01, вердикт за владельцем.

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';   // остальное ушло вместе с самодельным бипом (сигналы — в wake-chime.mjs)
import path from 'node:path';
import readline from 'node:readline';
import { TtsDaemon } from './voice/tts-daemon.mjs';
import { ensureChime } from './voice/wake-chime.mjs';
import { gatewayAlive, gatewayToken, runTurn, VOICE_STYLE } from './voice/pipeline.mjs';
import { acquireVoiceSession } from './voice/single-instance.mjs';
import { PERSONAS, personaByDetector } from './voice/personas.mjs';
import { hear } from './voice/ears.mjs';

const OUT_DIR = 'F:\\KLAS\\voice\\out';
const PY_WAKE = 'F:\\KLAS\\voice\\venv-wakeword\\Scripts\\python.exe';   // venv активаторов (вне git)
const LISTENER = path.join(import.meta.dirname, 'voice', 'wakeword-listen.py');
const CHIME_DIR = path.join(OUT_DIR, 'chimes');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const wavArg = flag('--wav');
const device = flag('--device');            // null ⇒ дефолт живёт в сайдкаре (один дефолт на систему)
const ears = flag('--ears') ?? 'ru';
const threshold = flag('--threshold');
const play = !args.includes('--no-play');
const muteWhileSpeaking = args.includes('--mute-while-speaking');
const day = new Date().toISOString().slice(0, 10);

// Голоса персон можно подменить флагом, не трогая канон: клоны в резидентный рот не встроены,
// и голос Джой сегодня — заглушка (см. шапку personas.mjs).
for (const [slug, opt] of [['jarvis', '--voice-jarvis'], ['joy', '--voice-joy']]) {
  const v = flag(opt);
  if (v) PERSONAS[slug].voice = v;
}

// --- Сигналы «слушаю» и «перестал слушать» ---
// ⭐ Прежний бип (синус 880 Гц, атака 10 мс) владелец забраковал на живом тесте: «неприятный, пик
// какой-то». Диагноз оказался измеримым — резкая атака даёт щелчок-удар, высокая частота режет,
// голый синус звучит прибором. Выбор сделан выслушкой (`homeworks/05`): семейство колокольчиков,
// закрытие — тот же тембр ниже. Сами тембры живут в ОДНОМ месте (`wake-chime.mjs`), сюда приходят
// готовыми: две копии одного звука разъезжаются молча.
//
// Роли, дословно по владельцу: «один и тот же сигнал на обе роли» (услышал имя · открылось окно) и
// «Если я не говорю и слушание прекращается, нужно в таком же тоне но снисходящим тоном проиграть
// звук — мне индикация, что слушание остановлено».
const chimeOpenName = flag('--chime-open') ?? 'bell';
const chimeCloseName = flag('--chime-close') ?? 'bell-deep';
// Окно продолжения (`plans/21`) включено по умолчанию — это и есть требование владельца. Флаг
// существует, потому что механика МЕНЯЕТ разговор, и вернуть прежнее поведение нужно уметь без
// правки кода (шаг 5 плана).
const followupEnabled = !args.includes('--no-followup');
let CHIME_OPEN = null;
let CHIME_CLOSE = null;
function ensureChimes() {
  try {
    CHIME_OPEN = ensureChime(chimeOpenName, CHIME_DIR);
    CHIME_CLOSE = ensureChime(chimeCloseName, CHIME_DIR);
  } catch (e) {
    console.error(`Сигналы не собрались: ${e.message}`);
    process.exit(1);
  }
}

// --- Воспроизведение ---
// Ход держит своё состояние: перебили — оставшиеся фразы не играют вовсе, а текущая обрывается
// смертью проигрывателя. Ссылка на процесс нужна именно для этого.
let turn = null;          // {aborted, player, spoke, persona}

function spawnPlayer(wav) {
  return spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { windowsHide: true });
}

// «Сейчас говорю сам» — объявляется СЛУШАТЕЛЮ (`bugs/26`). Без этого он начинал писать вопрос в тот
// же кадр, где услышал имя, и в запись попадал хвост нашей же речи из динамика: уши честно его
// расшифровывали, и в ядро уезжала каша. Детекция при этом не глушится — перебивание именем живо.
let listener = null;                     // присваивается в main; объявлено здесь ради этой функции
function tellSpeaking(on) {
  try { listener?.stdin.write(`{"cmd":"speaking","on":${on ? 'true' : 'false'}}\n`); }
  catch { /* слушатель уже мёртв — молчим, выход и так идёт */ }
}

// Реплика ассистента: играет только пока ход не перебит, и регистрируется в ходе, чтобы её можно
// было оборвать. `spoke` — было ли РЕАЛЬНО начато воспроизведение: без него отчёт врал о TTFA
// (перебитый до первого звука ход печатал «⚡TTFA 51.7 с», хотя не прозвучало ни слова).
function playWav(wav) {
  return new Promise((resolve) => {
    if (!play || turn?.aborted) return resolve();
    const p = spawnPlayer(wav);
    if (turn) { turn.player = p; turn.spoke = true; }
    // Объявляем слушателю, что в комнате звучим МЫ (`bugs/26`). Снимаем объявление при ЛЮБОМ исходе
    // — и когда фраза доиграла, и когда её убили перебиванием: иначе слушатель ждал бы тишины вечно.
    tellSpeaking(true);
    const done = () => { tellSpeaking(false); resolve(); };
    p.on('error', done);
    p.on('close', () => { if (turn?.player === p) turn.player = null; done(); });
  });
}

// Бип «услышал» — сигнал СЛУШАТЕЛЯ, а не часть реплики, и живёт по своим правилам.
// ⚠️ Раньше он шёл через `playWav`, и на ПЕРЕБИВАНИИ его не было вовсе: `playWav` отказывается
// играть при `turn.aborted`, а перебивание как раз этот флаг и ставит. То есть подтверждение
// пропадало ровно в тот момент, когда оно нужнее всего, — владелец на живом микрофоне так и
// сказал: «почему то не срабатыва… а вот теперь сработал пик» (`homeworks/04`, `bugs/25`).
// Заодно бип больше не может занять `turn.player` и увести на себя следующее перебивание.
// ⚠️ СИГНАЛ ТОЖЕ ЗВУЧИТ В КОМНАТУ, и слушатель слышит его наравне с речью. Пока этого не учитывали,
// происходило вот что: имя услышано → слушатель начал писать фразу → заиграл колокольчик → автомат
// конца фразы принял его за начало речи → колокольчик кончился → 0.9 с тишины → «фраза закончилась».
// В ядро уезжал записанный СИГНАЛ, уши слов в нём не находили, и владелец видел «(тишина — ничего не
// распознано)» вместо своих пяти секунд (живой тест 2026-08-01). Поэтому сигнал объявляется тем же
// способом, что и речь ассистента (`bugs/26`): «я звучу» → слушатель откладывает захват.
function playChime(file) {
  if (!play || !file) return;
  tellSpeaking(true);
  const p = spawnPlayer(file);
  const done = () => tellSpeaking(false);
  p.on('error', done);
  p.on('close', done);
}

// ⭐ ОКНО ПРОДОЛЖЕНИЯ (`ideas/19`). Владелец 2026-08-01: «после реплики джарвиса не было сигнала,
// приглашающего меня произвести фразу. Нужно чтобы оно автоматически само запускало слушание и
// сигналом меня приглашало». Имя после этого нужно только чтобы НАЧАТЬ разговор или СМЕНИТЬ персону.
//
// Порядок важен: сначала приглашающий сигнал, потом команда слушателю. Слушатель заводит захват уже
// взведённым и ждёт тишины, поэтому сигнал не попадёт в запись и не съест окно (тот же механизм,
// что спас от записи собственной речи, `bugs/26`).
function openFollowup(persona) {
  playChime(CHIME_OPEN);
  try { listener?.stdin.write(`{"cmd":"followup","detector":"${persona.slug}"}\n`); }
  catch { /* слушатель мёртв — выход и так идёт */ }
}

function bargeIn(detector, score) {
  if (!turn || turn.aborted) return false;
  turn.aborted = true;
  try { turn.player?.kill(); } catch { /* уже завершился */ }
  // Говорим слушателю «я замолчал» СРАЗУ, не дожидаясь события закрытия процесса: он всё равно
  // ждёт ещё и реально тихого кадра, потому что звук гаснет позже убийства проигрывателя (`bugs/26`).
  tellSpeaking(false);
  console.log(`\n✋ перебито на «${PERSONAS[detector]?.name ?? detector}» (${score}) — замолкаю`);
  return true;
}

// --- Один разговорный ход по услышанному вопросу ---
async function handleUtterance(persona, wav) {
  const t0 = performance.now();
  let heard = '';
  try { heard = hear(wav, ears); } finally { rmSync(wav, { force: true }); }
  if (!heard) { console.log('(тишина — ничего не распознано)'); return; }
  const earsMs = performance.now() - t0;
  console.log(`🎤 Ты → ${persona.name}: ${heard}`);

  turn = { aborted: false, player: null, spoke: false, persona };
  const state = turn;
  try {
    const r = await runTurn({
      // Один резидентный рот на обе персоны: диктор задаётся НА ВЫЗОВ (tts-daemon.mjs).
      tts: { say: (text, out) => tts.say(text, out, persona.voice) },
      question: heard,
      // Своя беседа на каждую персону: общий ключ дал бы Джой память и реплики Джарвиса.
      user: `voice-${day}-${persona.slug}`,
      outDir: OUT_DIR,
      style: `${persona.prompt}\n${VOICE_STYLE}`,
      playFn: playWav,
    });
    const sec = (ms) => (ms / 1000).toFixed(1);
    console.log(`${state.aborted ? '🤖 (оборвано) ' : '🤖 '}${persona.name}: ${r.reply}`);
    for (const s of r.sentences.filter((x) => !x.ok)) {
      if (s.reason === 'nothing-to-say') console.log(`(не озвучено: «${s.text}» — ни букв, ни цифр, bugs/06)`);
      else console.error(`РОТ споткнулся на «${s.text}»: ${s.reason}`);
    }
    // TTFA — «время до первого ЗВУКА», поэтому у хода, перебитого раньше первого звука, его нет.
    // Конвейер отмечает момент, когда фраза ГОТОВА к воспроизведению, и не знает, что дирижёр её
    // проглотил, — судим по собственному наблюдению (`state.spoke`), а не по намерению конвейера.
    // В тихом прогоне (`--no-play`) звука нет вовсе, но число полезно харнессу — отдаём его с
    // честной подписью «готовность», а не как время до звука, которого не было.
    const ttfa = r.ttfaMs === null ? '—'
      : !play ? `${sec(earsMs + r.ttfaMs)} с (без звука: готовность)`
        : state.spoke ? `${sec(earsMs + r.ttfaMs)} с` : '—';
    console.log(`[тайминги] уши ${sec(earsMs)} с · ядро ${sec(r.coreMs)} с · всего ${sec(earsMs + r.totalMs)} с · ⚡TTFA ${ttfa}`);
    if (state.aborted && !state.spoke) console.log('   (ответ не прозвучал — перебит до первого звука)');

    // Шаг 3 плана 21: ответ прозвучал — приглашаем продолжить БЕЗ имени.
    // ⛔ Не открываем окно у ПЕРЕБИТОГО хода: там человек уже говорит следующей персоне, и
    // приглашение было бы ложью, а второй захват столкнулся бы с идущим.
    if (followupEnabled && !state.aborted) openFollowup(persona);
  } catch (e) {
    console.error(String(e.message || e));
  } finally {
    if (turn === state) turn = null;
  }
}

// --- main ---
if (play) {
  const lock = acquireVoiceSession('voice-wake');
  if (!lock.ok) {
    console.error(`Уже идёт голосовая сессия: ${lock.holder.who} (pid ${lock.holder.pid}, с ${lock.holder.at}).`);
    console.error('Две сессии говорят в одни колонки — на слух это каша. Закончи ту или запусти с --no-play.');
    process.exit(1);
  }
}

const tts = new TtsDaemon();      // диктор задаётся на каждый вызов say(), см. handleUtterance
const ready = await tts.ready();
if (ready.stage === 'dead') { console.error('РОТ не запустился — см. venv F:\\KLAS\\voice\\venv (plans/11)'); process.exit(1); }
if (ready.stage === 'encoding-broken') {
  console.error('РОТ отвечает в неверной кодировке — речь была бы моджибейком, а не словами (bugs/08).');
  console.error(`  отправлено: ${ready.sent}\n  вернулось : ${ready.got}`);
  process.exit(1);
}
gatewayToken();
if (!(await gatewayAlive())) {
  console.error('ЯДРО недоступно: гейтвей OpenClaw не поднят.\nПодними стек: powershell -File F:\\KLAS\\tools\\klas.ps1 -Action up');
  process.exit(1);
}
ensureChimes();

// `--parent`: слушатель обязан уйти вместе со мной. Без этого мой аварийный выход оставил бы
// ffmpeg держать микрофон, и следующий запуск не смог бы его открыть.
const listenerArgs = [LISTENER, '--out-dir', OUT_DIR, '--parent'];
if (wavArg) listenerArgs.push('--wav', wavArg);
if (args.includes('--realtime')) listenerArgs.push('--realtime');
if (device) listenerArgs.push('--device', device);
if (threshold) listenerArgs.push('--threshold', threshold);
// Перебивание посреди речи (bugs/25): звук идёт через встроенный AEC Windows, а не напрямую с
// микрофона. Микрофон при этом берётся СЫРОЙ (до шумодава) — подавитель моделирует ЛИНЕЙНЫЙ путь
// «колонки → микрофон», и нелинейная обработка перед ним не даёт фильтру сойтись.
if (args.includes('--aec')) {
  listenerArgs.push('--aec');
  const mic = flag('--aec-mic'); const spk = flag('--aec-spk');
  if (mic) listenerArgs.push('--aec-mic', mic);
  if (spk) listenerArgs.push('--aec-spk', spk);
}
listener = spawn(PY_WAKE, listenerArgs, { windowsHide: true });   // объявлен выше — им пользуется tellSpeaking
listener.on('error', (e) => { console.error(`Слушатель не запустился: ${e.message}`); process.exit(1); });
listener.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.error(`[слушатель] ${s.slice(0, 300)}`); });

// Ходы идут ПО ОДНОМУ: перебив ответ, человек задаёт следующий вопрос, а прошлый ход в это время
// ещё дописывается ядром. Два одновременных хода в одну беседу ядра — гонка, которой здесь не место.
let chain = Promise.resolve();
let done = false;

readline.createInterface({ input: listener.stdout }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }

  if (m.stage === 'ready') {
    console.log('='.repeat(68));
    console.log('  СЛУШАЮ ИМЕНА — скажи «Джарвис» или «Джой»');
    console.log('='.repeat(68));
    console.log(`  ${Object.values(PERSONAS).map((p) => `${p.name} → голос ${p.voice}`).join('   ·   ')}`);
    console.log(`  источник: ${m.source === 'wav' ? wavArg : m.device}   ·   уши: ${ears}`);
    console.log(`  ${muteWhileSpeaking ? 'пока говорю — не слушаю' : 'перебивать можно: скажи имя, пока говорю'}`);
    console.log(`${'='.repeat(68)}\n`);
    return;
  }
  if (m.stage === 'error') { console.error(`Слушатель отказал: ${JSON.stringify(m)}`); process.exitCode = 1; return; }
  // Окно продолжения открылось. Печатаем ВСЛУХ: сигнала мало — человек должен видеть, сколько у
  // него времени и с кем он продолжает говорить (`plans/21`, критерий «видно, что окно открыто»).
  if (m.stage === 'followup') {
    const p = personaByDetector(m.detector);
    console.log(`   🎧 говори дальше без имени — ${p?.name ?? m.detector} слушает ${m.seconds} с`);
    return;
  }
  if (m.stage === 'warn') { console.error(`[слушатель] ${JSON.stringify(m)}`); return; }
  if (m.stage === 'eof') { done = true; chain.then(() => shutdown(0)); return; }

  if (m.event === 'wake') {
    const persona = personaByDetector(m.detector);
    if (!persona) { console.error(`Неизвестный детектор «${m.detector}» — раскладка персон разошлась с моделями`); return; }
    if (!bargeIn(m.detector, m.score)) console.log(`\n🔔 ${persona.name} (${m.score})`);
    // Сигнал «услышал» (решение владельца). Не ждём его окончания: слушатель уже пишет фразу.
    // Сигнал звучит ВСЕГДА, в том числе на перебивании: именно там он и подтверждает, что услышан.
    playChime(CHIME_OPEN);
    return;
  }
  // Окно слушания закрылось: позвали и промолчали пять секунд. Нисходящий сигнал — прямое
  // требование владельца: «мне индикация, что слушание остановлено». Без него молчание неотличимо
  // от «он всё ещё ждёт» — тот же класс, ради которого появился сигнал «услышал».
  if (m.event === 'empty') {
    console.log('   (промолчал — слушание закрыто)');
    playChime(CHIME_CLOSE);
    return;
  }
  if (m.event === 'utterance') {
    const persona = personaByDetector(m.detector);
    if (!persona) return;
    chain = chain.then(async () => {
      if (muteWhileSpeaking) listener.stdin.write('{"cmd":"listen","on":false}\n');
      try { await handleUtterance(persona, m.wav); }
      finally { if (muteWhileSpeaking) listener.stdin.write('{"cmd":"listen","on":true}\n'); }
    });
  }
});

listener.on('close', () => { if (!done) shutdown(process.exitCode ?? 0); });

function shutdown(code) {
  try { listener.stdin.write('{"cmd":"quit"}\n'); } catch { /* уже мёртв */ }
  try { listener.kill(); } catch { /* уже мёртв */ }
  tts.stop();
  process.exit(code);
}

process.on('SIGINT', () => { console.log('\nПока!'); shutdown(0); });
