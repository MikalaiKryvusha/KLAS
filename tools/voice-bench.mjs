#!/usr/bin/env node
// tools/voice-bench.mjs — БЕНЧ ГОЛОСОВОГО ТРАКТА (Г3, plans/13): проверяет тракт ПО ЗВУКУ, а не по
// таймингам, до того как его отдадут человеку.
//
// Зачем он есть. 2026-07-28 тракт был отдан владельцу «проверенным»: файлы создавались, тайминги
// печатались, метрики выглядели прекрасно — а в динамиках был шум («сррс рсрср срр»). Проверялось
// всё, кроме единственного, что имеет значение: СОДЕРЖИМОЕ ЗВУКА. Этот бенч закрывает тот разрыв.
//
// Что делает: гоняет НАСТОЯЩИЙ конвейер (tools/voice/pipeline.mjs — тот же, что у voice-talk) на
// наборе разноформенных вопросов и по каждому ходу проверяет пять вещей:
//   T1 ход завершился, ядро вернуло непустой текст;
//   T2 у каждой фразы СВОЙ файл (совпадение имён = следующая фраза затирает играющую → шум);
//   T3 файл не изменился за окно воспроизведения (sha256 до и после) — прямая улика гонки;
//   T4 ЗВУК соответствует тексту: файл распознаётся ушами (GigaAM), доля совпавших слов ≥ 0.6;
//   T5 каждая фраза с кириллицей озвучена (молчание допустимо только по bugs/06).
// Итог — доля пройденных проверок, как в остальных бенчах проекта.
//
// Динамики подменены проверкой, но окно воспроизведения ВЫДЕРЖИВАЕТСЯ по длительности аудио —
// иначе гонка «затирание играющего файла» просто не успеет случиться и бенч останется зелёным на
// сломанном коде. Записывающего loopback-устройства на машине нет (проверено: ffmpeg dshow отдаёт
// только микрофоны), поэтому «что слышно в динамиках» доказывается парой «STT файла + неизменность
// файла в момент проигрывания», без новых зависимостей.
//
// Использование:
//   node tools/voice-bench.mjs                 → полный набор (5 ходов)
//   node tools/voice-bench.mjs --quick         → только два самых опасных случая
//   node tools/voice-bench.mjs --audible       → ещё и реально проигрывать (слышимый прогон)
//   node tools/voice-bench.mjs --acoustic      → АКУСТИЧЕСКАЯ ПЕТЛЯ (включает --audible): весь ход
//        играется в динамики и ОДНОВРЕМЕННО пишется микрофоном, запись распознаётся и сверяется с
//        ответом ядра. Это единственная проверка, которая слышит ровно то, что слышит человек, —
//        вместе с плеером ОС и звуковым трактом Windows (T6). Идея владельца, 2026-07-28.
//   node tools/voice-bench.mjs --voice baya
// ⚠️ Требует поднятого гейтвея (`powershell -File tools\klas.ps1 -Action up`).

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { TtsDaemon } from './voice/tts-daemon.mjs';
import { firstSentenceCut, gatewayAlive, runTurn } from './voice/pipeline.mjs';
import { acquireVoiceSession } from './voice/single-instance.mjs';

const HERE = import.meta.dirname;
const OUT_DIR = 'F:\\KLAS\\voice\\bench';          // отдельная папка: не мешаем артефактам диалога
const WORD_MATCH_MIN = 0.6;                        // порог совпадения слов «сказано vs услышано»

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const voice = flag('--voice') ?? 'eugene';
const acoustic = args.includes('--acoustic');
const audible = args.includes('--audible') || acoustic;   // петлю без звука не замкнуть
const quick = args.includes('--quick');
const MIC = flag('--device') ?? 'Микрофон (NVIDIA Broadcast)';

// Набор форм, а не «нормальных примеров» (урок EXP-0013: фикстура из однотипных фраз проверяет себя).
// Каждый случай ловит свой класс дефектов.
const CASES = [
  { id: 'одна фраза', q: 'Назови столицу Беларуси одним словом.', danger: 'базовый путь' },
  { id: 'много фраз', q: 'Назови три главные реки Беларуси и добавь предложение про их значение.', danger: 'ГОНКА: фразы режутся из одного всплеска дельт', hot: true },
  { id: 'длинный ответ', q: 'Расскажи четырьмя предложениями про погоду летом в Минске.', danger: 'много фраз подряд, очередь воспроизведения', hot: true },
  { id: 'число', q: 'Сколько будет сорок два плюс четырнадцать? Ответь только числом.', danger: 'bugs/06: ответ без букв — раньше молчал' },
  { id: 'латиница', q: 'Как по-английски будет слово «кот»? Ответь одним словом.', danger: 'bugs/06: чистая латиница — раньше молчала' },
  { id: 'смесь языков', q: 'Закончи фразу по-русски одним предложением: «Эта технология называется …», подставив английский термин machine learning прямо в предложение.', danger: 'требование владельца: переключение языков внутри реплики' },
  { id: 'единицы', q: 'Одним предложением: какая скорость и температура у видеокарты RTX 5070 Ti под нагрузкой?', danger: 'требование владельца: числа и единицы должны звучать словами, а не «20 C»' },
];

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hear(wav) {
  const r = spawnSync('node', [path.join(HERE, 'voice-hear.mjs'), wav], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : '';
}

function playWav(wav) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { windowsHide: true });
    p.on('close', resolve);
  });
}

/**
 * Доля слов исходной фразы, реально услышанных в её звуке.
 * ⚠️ Сверяются только РУССКИЕ слова: уши KLAS — GigaAM, модель русского языка, она физически не
 * распознаёт английские куски. Считать их непроизнесёнными было бы ложным обвинением исправного
 * тракта. Следствие, которое надо знать: КАЧЕСТВО английского произношения этот бенч не проверяет —
 * его судит только человек (или будущий английский STT).
 */
const LAT_WORD = /[a-z]/i;
function wordMatch(said, heard) {
  const a = norm(said).filter((w) => !LAT_WORD.test(w));
  const b = new Set(norm(heard));
  if (!a.length) return 1;                    // фраза целиком английская — проверять нечем
  return a.filter((w) => b.has(w)).length / a.length;
}

/** Запись микрофона на всё время хода — акустическая петля «динамики → воздух → микрофон». */
function startMicRecording(outWav) {
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow',
    '-i', `audio=${MIC}`, '-ac', '1', '-ar', '16000', outWav], { windowsHide: true });
  return {
    stop: async () => {
      await sleep(600);                 // хвост последней фразы не обрезать
      try { ff.stdin.write('q'); } catch { /* уже завершился */ }
      await new Promise((res) => ff.on('close', res));
    },
  };
}

async function runCase(tts, c) {
  const checks = [];
  const add = (name, ok, note) => checks.push({ name, ok, note });
  const played = [];   // что реально «проигралось»: имя, хеш до/после, услышанный текст

  // Подменяем динамики проверкой, СОХРАНЯЯ окно воспроизведения — иначе гонка не воспроизведётся.
  const playFn = async (wav, item) => {
    const before = sha(wav);
    if (audible) await playWav(wav);
    else await sleep(Math.round((item.audioSec ?? 1) * 1000));   // окно той же длительности
    const after = existsSync(wav) ? sha(wav) : null;
    // Сверяем с тем, что РЕАЛЬНО произнесено (цифры развёрнуты в слова), а не с исходной строкой
    played.push({ wav, text: item.spoken ?? item.text, before, after, heard: hear(wav) });
  };

  const micWav = path.join(OUT_DIR, `acoustic-${c.id.replace(/\s+/g, '_')}.wav`);
  const mic = acoustic ? startMicRecording(micWav) : null;
  if (mic) await sleep(1200);            // дать ffmpeg открыть устройство до первого звука

  let r;
  try {
    r = await runTurn({ tts, question: c.q, user: `bench-${Date.now()}`, outDir: OUT_DIR, playFn });
  } catch (e) {
    await mic?.stop();
    add('T1 ход завершён', false, String(e.message || e));
    return { checks, reply: '', r: null };
  }
  await mic?.stop();

  add('T1 ход завершён', Boolean(r.reply), r.reply ? `${r.reply.length} симв.` : 'пустой ответ ядра');

  // T2 — уникальность имён файлов. Совпадение = следующий синтез пишет в играющий файл.
  const names = r.sentences.map((s) => s.wav);
  const uniq = new Set(names);
  add('T2 файлы уникальны', uniq.size === names.length, `${uniq.size} уникальных из ${names.length} фраз`);

  // T3 — файл не изменился за окно воспроизведения. Прямая улика затирания.
  const mutated = played.filter((p) => p.before !== p.after);
  add('T3 файл не менялся при проигрывании', mutated.length === 0,
    mutated.length ? `ЗАТЁРТ во время воспроизведения: ${mutated.map((m) => path.basename(m.wav)).join(', ')}` : `${played.length} проверено`);

  // T4 — ЗВУК соответствует тексту (главная проверка: именно её не было, когда тракт отдали владельцу)
  const bad = played.filter((p) => wordMatch(p.text, p.heard) < WORD_MATCH_MIN);
  add('T4 звук соответствует тексту', played.length > 0 && bad.length === 0,
    played.length === 0 ? 'ничего не озвучено' :
      bad.length ? bad.map((p) => `«${p.text}» → услышано «${p.heard || '(тишина)'}»`).join(' | ')
        : `совпадение слов ${played.map((p) => wordMatch(p.text, p.heard).toFixed(2)).join('/')}`);

  // T5 — фразы с кириллицей обязаны звучать; молчание законно только по bugs/06
  const HAS_CYR = /[а-яёА-ЯЁ]/;
  const silentButShould = r.sentences.filter((s) => !s.ok && HAS_CYR.test(s.text));
  add('T5 кириллица озвучена', silentButShould.length === 0,
    silentButShould.length ? silentButShould.map((s) => `«${s.text}» → ${s.reason}`).join(' | ')
      : r.sentences.filter((s) => !s.ok).length ? 'молчание только по bugs/06 (ожидаемо)' : 'все фразы озвучены');

  // T6 — АКУСТИЧЕСКАЯ ПЕТЛЯ: что реально прозвучало в комнате. Проверяет всё разом, включая плеер ОС
  // и звуковой тракт Windows, которых не видит ни одна проверка по файлам.
  if (acoustic) {
    const roomHeard = hear(micWav);
    const spokenText = r.sentences.filter((s) => s.ok).map((s) => s.text).join(' ');
    const m = spokenText ? wordMatch(spokenText, roomHeard) : 0;
    add('T6 акустическая петля (микрофон)', m >= WORD_MATCH_MIN,
      spokenText ? `совпадение ${m.toFixed(2)} · услышано в комнате: «${roomHeard || '(тишина)'}»`
        : 'озвучивать было нечего');
  }

  return { checks, reply: r.reply, r };
}

// --- main ---
// Звуковой бенч НЕ имеет права перебивать живой диалог человека: наложение двух голосов в одних
// колонках на слух неотличимо от сломанного звука — на этом уже потерян вечер 2026-07-28.
if (audible) {
  const lock = acquireVoiceSession('voice-bench');
  if (!lock.ok) {
    console.error(`Идёт голосовая сессия: ${lock.holder.who} (pid ${lock.holder.pid}) — звуковой бенч перебил бы её.`);
    console.error('Дождись её конца либо гоняй бенч без звука (без --audible/--acoustic).');
    process.exit(1);
  }
}

// --- T0: НАРЕЗКА (охранник bugs/09) ---
// Детерминированная проверка ДО обращения к ядру: нарезка по предложениям не должна зависеть от
// того, что сегодня ответит модель, а прежний дефект был именно в ней. Разбивать ответ обязана
// каждая граница предложения, дающая достаточный кусок, — а не только самая ранняя. На старом коде
// первый случай давал ОДИН кусок вместо трёх, потому что «Привет!» короче порога и цикл выходил
// навсегда: стриминг молча обнулялся, TTFA становился равен полному ответу.
function chunk(text) {
  const out = [];
  let buf = text;
  for (;;) {
    const cut = firstSentenceCut(buf);
    if (cut === -1) break;
    out.push(buf.slice(0, cut).trim());
    buf = buf.slice(cut);
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
// [текст, минимум кусков]. Ожидания выведены из КОНТРАКТА нарезки, а не из желаемого: короткий
// огрызок склеивается со следующей фразой (в этом смысл порога), поэтому «Привет!» и «Да!» не дают
// отдельного куска — они дают ПРАВО резать дальше. Первые два случая различают старую логику и
// новую: старая на них выдавала ОДИН кусок на весь ответ.
const CHUNK_FIXTURE = [
  ['Привет! У меня пока нет имени. Давай выберем его вместе, если хочешь.', 2],
  ['Да! Отлично. Теперь давай проверим, как это звучит вслух.', 2],
  ['Три реки: Днепр, Припять и Двина. Они важны для страны.', 2],
  ['Минск.', 1],                                    // одна короткая фраза уходит в хвост — это норма
];
const chunkFails = CHUNK_FIXTURE.filter(([t, min]) => chunk(t).length < min);
console.log(`[T0 нарезка] ${chunkFails.length === 0 ? '✅' : '❌'} ${CHUNK_FIXTURE.length - chunkFails.length}/${CHUNK_FIXTURE.length}` +
  (chunkFails.length ? ` — не режется: ${chunkFails.map(([t]) => `«${t.slice(0, 40)}…» → ${chunk(t).length} кусков`).join(' | ')}` : ''));
if (chunkFails.length) {
  console.error('Нарезка по предложениям сломана (bugs/09) — стриминг обнулён, TTFA = полный ответ.');
  process.exit(1);
}

if (!(await gatewayAlive())) {
  console.error('Гейтвей OpenClaw не поднят — бенч невозможен.\nПодними стек: powershell -File F:\\KLAS\\tools\\klas.ps1 -Action up');
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const tts = new TtsDaemon({ voice });
const ttsReady = await tts.ready();
if (ttsReady.stage === 'dead') { console.error('РОТ не запустился — см. plans/11'); process.exit(1); }
// Бенч обязан краснеть на сломанной кодировке, а не мерить тайминги моджибейка (bugs/08). Именно
// эта проверка отсутствовала, когда тракт «прошёл 35/35» у агента и бормотал у владельца: бенч
// гонялся в окружении с заданной PYTHONIOENCODING, которой в терминале владельца нет.
if (ttsReady.stage === 'encoding-broken') {
  console.error('❌ ОХРАННИК КОДИРОВКИ: текст портится на пути Node↔Python (bugs/08) — тракт говорил бы моджибейком.');
  console.error(`   отправлено «${ttsReady.sent}» · вернулось «${ttsReady.got}» · потоки питона ${JSON.stringify(ttsReady.enc)}`);
  process.exit(1);
}
console.log(`[рот] кодировка потоков питона: ${JSON.stringify(ttsReady.enc)} · канарейка прошла`);

const cases = quick ? CASES.filter((c) => c.hot) : CASES;
console.log(`=== БЕНЧ ГОЛОСОВОГО ТРАКТА (голос ${voice}, ${audible ? 'со звуком' : 'без звука, окно воспроизведения выдерживается'}) ===`);
let passed = 0, total = 0;
const rows = [];
for (const c of cases) {
  console.log(`\n— ${c.id} — ${c.danger}\n  ? ${c.q}`);
  const { checks, reply, r } = await runCase(tts, c);
  console.log(`  🤖 ${reply || '(нет ответа)'}`);
  for (const ch of checks) {
    console.log(`     ${ch.ok ? '✅' : '❌'} ${ch.name}: ${ch.note}`);
    passed += ch.ok ? 1 : 0; total += 1;
  }
  rows.push({ id: c.id, ok: checks.filter((x) => x.ok).length, of: checks.length, ttfa: r?.ttfaMs, tot: r?.totalMs });
}
tts.stop();

console.log('\n=== ИТОГ ===');
for (const row of rows) {
  const t = row.ttfa === null || row.ttfa === undefined ? '—' : `${(row.ttfa / 1000).toFixed(1)} с`;
  console.log(`  ${row.ok === row.of ? '✅' : '❌'} ${row.id.padEnd(16)} ${row.ok}/${row.of}  TTFA ${t}`);
}
console.log(`\nБАЛЛ: ${passed}/${total} (${(100 * passed / total).toFixed(0)}%)`);
process.exit(passed === total ? 0 : 1);
