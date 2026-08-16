// gpu-watch.mjs — НАБЛЮДАТЕЛЬ эпика 26, живущий ВНУТРИ KLAS, в контейнере докера.
// Он смотрит и пишет. Он НИКОГДА не действует.
//
//   docker compose up -d gpu-watch          # штатный запуск (сервис KLAS)
//   node tools/gpu-watch.mjs --self-test    # один опрос всех датчиков, печать, выход 0
//
// ВЫКЛЮЧАТЕЛЬ (одна команда, работает и для контейнера):
//   New-Item -ItemType File F:\KLAS\logs\gpu-watch\STOP
// Наблюдатель замечает файл в течение одного тика, сбрасывает буфер и выходит с кодом 0.
//
// ─── ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ, если рядом лежит рабочий tools/gpu-watch.ps1 ──────────────────
// Требование владельца 2026-08-16 (ideas/21, дословно): «нужно чтобы механизм, который ты хотел
// сделать, жил внутри KLAS контейнера в докере, и чтобы не запускал окон терминала». Родилось из
// bugs/28: задача планировщика Windows каждые пять минут оставляла пустое окно терминала, и
// владелец несколько часов закрывал их руками, виня соседний проект.
//
// Контейнер лечит ОБА корня сразу: у него нет консоли, поэтому окно не может появиться в принципе,
// и он живёт внутри KLAS, а не отдельным предметом в ОС, который переживёт снос проекта.
//
// ─── ЧТО ПРОВЕРЕНО НАБЛЮДЕНИЕМ ПЕРЕД ТЕМ, КАК ЭТО ПИСАТЬ (2026-08-16) ─────────────────────────
// 1. Контейнер ВИДИТ карту: `docker run --rm --gpus all nvidia/cuda:12.8.1-base nvidia-smi` дал
//    2704/16303 МиБ и 6% — те же числа, что хост писал в журнал в ту же минуту.
// 2. `nvidia-smi` ВПРЫСКИВАЕТСЯ NVIDIA Container Toolkit в ЛЮБОЙ образ при `--gpus all` и
//    NVIDIA_DRIVER_CAPABILITIES=utility — проверено на голом `node:22-slim` (/usr/bin/nvidia-smi).
//    Поэтому у этого сервиса нет своего Dockerfile: официальный образ node плюс этот файл.
// 3. ⛔ СПИСОК ПРОЦЕССОВ КАРТЫ ИЗ КОНТЕЙНЕРА НЕ ВИДЕН. `--query-compute-apps` возвращает только
//    собственный `/Xwayland` прослойки WSL2, а не 24 клиента Windows. Это не настройка — граница
//    между гостем и хостом.
//
// ─── ЧТО ЭТОТ ДАТЧИК НЕ МЕРЯЕТ И ПОЧЕМУ ЭТО ЗАПИСАНО ЧЕСТНО ──────────────────────────────────
// Четыре величины хостового датчика привязаны к СЕАНСУ владельца и из контейнера недостижимы
// принципиально: `idle_s` (GetLastInputInfo), `fg` (окно на переднем плане), `fs` (во весь экран),
// `nproc`/`procs` (клиенты карты, пункт 3 выше).
//
// Они не подменяются нулями — нуль соврал бы, что величина измерена. Их в записи ПРОСТО НЕТ, а
// строка помечена `src:"docker"`, и gpu-watch-replay.mjs по этой метке отказывается оценивать
// правила, которым не хватает входа (правила R5/R6 опираются на `fs`), вместо того чтобы тихо
// посчитать их «никогда не занято».
//
// Цена решения, измеренная по самим правилам-кандидатам: из шести правил R3 и R4 опираются ТОЛЬКО
// на карту и работают здесь полностью; R1 и R2 (чужой процесс на карте) были признаны мёртвыми ещё
// на хосте — там постоянно 24 обычные программы; неоценимыми остаются R5 и R6. Отдельная находка:
// `idle_s`, ради которого датчик вообще привязывали к сеансу владельца, не использует НИ ОДНО из
// шести правил.
//
// ─── ИЗНОС ДИСКА (ограничение владельца, правило R1 плана 26) ────────────────────────────────
// Карта опрашивается каждые несколько секунд, но журнал ДОПИСЫВАЕТСЯ только при смене состояния,
// копится в памяти и сбрасывается на диск не чаще раза в FLUSH_SEC. Построчная запись на тик дала
// бы ~30 000 крошечных записей в сутки.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, access, unlink } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);

// ─── Настройки. Значения совпадают с tools/gpu-watch.ps1, иначе журналы двух источников
// несравнимы, а весь смысл контейнерного датчика — в том, чтобы реплей читал их одинаково.
const INTERVAL_SEC = num(process.env.GPU_WATCH_INTERVAL, 3);
const HEARTBEAT_MIN = num(process.env.GPU_WATCH_HEARTBEAT, 5);
const FLUSH_SEC = num(process.env.GPU_WATCH_FLUSH, 60);
// Сколько подряд опросов новое состояние обязано продержаться, прежде чем в него поверят.
// При 3 с это ~15 с «да, это правда происходит» — оплачено первым живым прогоном (см. ниже).
const CONFIRM_POLLS = num(process.env.GPU_WATCH_CONFIRM, 5);
const KLAS_EVERY_SEC = num(process.env.GPU_WATCH_KLAS_EVERY, 15);
const LOG_DIR = process.env.GPU_WATCH_LOGDIR || '/logs';
// Внутри контейнера llama-swap хоста доступен через шлюз, снаружи — напрямую.
const KLAS_URL = process.env.GPU_WATCH_KLAS_URL || 'http://host.docker.internal:8080/running';

// ─── Пороги «что считать СМЕНОЙ состояния, достойной строки журнала». Нарочно грубые: рабочий
// стол весь день дрожит на десятки МиБ и несколько процентов, и каждая дрожь стоила бы записи.
const MEM_STEP_MIB = 256; // игра или наша модель двигают гигабайты — 256 МиБ далеко ниже любого события
const UTIL_STEP_PCT = 20; // простаивающий стол дрожит в пределах ~10%

const SELF_TEST = process.argv.includes('--self-test');

function num(v, d) { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; }

// ─── Опрос карты ──────────────────────────────────────────────────────────────────────────────
// Один вызов nvidia-smi на все числа карты. Память НА ПРОЦЕСС не спрашивается намеренно: на
// Windows WDDM она возвращается как [N/A] (проверено 2026-08-16), существуют только итоги карты.
const GPU_FIELDS = 'memory.used,memory.total,utilization.gpu,utilization.memory,clocks.sm,power.draw,temperature.gpu';

async function sampleGpu() {
  try {
    const { stdout } = await run('nvidia-smi', [`--query-gpu=${GPU_FIELDS}`, '--format=csv,noheader,nounits'],
      { timeout: 10_000 });
    const f = stdout.split('\n')[0].split(',').map((s) => s.trim());
    if (f.length < 7) return null;
    return {
      mem_used: parseInt(f[0], 10),
      mem_total: parseInt(f[1], 10),
      util_gpu: parseInt(f[2], 10),
      util_mem: parseInt(f[3], 10),
      clk_sm: parseInt(f[4], 10),
      pwr_w: parseFloat(f[5]),
      temp_c: parseInt(f[6], 10),
    };
  } catch { return null; }
}

// Какую модель сейчас держит llama-swap. Пустая строка = ни одной, "?" = llama-swap молчит.
async function klasRunning() {
  try {
    const ctl = AbortSignal.timeout(2000);
    const res = await fetch(KLAS_URL, { signal: ctl });
    if (!res.ok) return '?';
    const j = await res.json();
    if (Array.isArray(j.running) && j.running.length > 0) return j.running.map((r) => r.model).join(',');
    return '';
  } catch { return '?'; }
}

// Отметка времени в ЛОКАЛЬНОЙ зоне со смещением — тот же вид, что пишет хостовой датчик
// (`2026-08-16T20:48:07+03:00`), иначе реплей склеит два журнала со сдвигом в три часа.
// Зона контейнера задаётся переменной TZ в docker-compose.
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

const exists = async (p) => access(p).then(() => true, () => false);

// ─── Самопроверка: один опрос, всё напечатано, выход 0 ───────────────────────────────────────
if (SELF_TEST) {
  console.log('gpu-watch (контейнер) — самопроверка, один опрос каждого датчика');
  const g = await sampleGpu();
  if (!g) { console.log('ПРОВАЛ: nvidia-smi не ответил (карта проброшена в контейнер?)'); process.exit(1); }
  console.log(`  время        : ${stamp()}`);
  console.log(`  память       : ${g.mem_used} / ${g.mem_total} МиБ занято`);
  console.log(`  утилизация   : gpu ${g.util_gpu}%  mem ${g.util_mem}%`);
  console.log(`  частоты/ватты: ${g.clk_sm} МГц  ${g.pwr_w} Вт  ${g.temp_c} °C`);
  console.log(`  модель KLAS  : '${await klasRunning()}'  (пусто = ни одной, ? = llama-swap молчит)`);
  console.log('  сеансовые величины (idle_s, fg, fs, nproc): НЕ ИЗМЕРЯЮТСЯ — граница контейнера, см. шапку');
  console.log('самопроверка OK');
  process.exit(0);
}

// ─── Журнал ───────────────────────────────────────────────────────────────────────────────────
await mkdir(LOG_DIR, { recursive: true });
const stopFile = path.join(LOG_DIR, 'STOP');
if (await exists(stopFile)) await unlink(stopFile).catch(() => {});

let buffer = [];
const addEvent = (o) => buffer.push(JSON.stringify(o));

async function flush() {
  if (buffer.length === 0) return;
  const file = path.join(LOG_DIR, `${stamp().slice(0, 10)}.jsonl`);
  const text = buffer.join('\n') + '\n';
  buffer = [];
  await appendFile(file, text, 'utf8');
}

// ─── Главный цикл ─────────────────────────────────────────────────────────────────────────────
let lastMem = -99999, lastUtil = -99999, lastKlas = 'init';
let lastHb = 0, lastFlush = Date.now(), lastKlasPoll = 0;
let klas = '?', ticks = 0;

// Гашение дребезга. Оплачено первым живым прогоном хостового датчика (2026-08-16): sdc_fma.exe
// появлялся и умирал каждые ~10 с, каждый раз загоняя утилизацию до 54%, и датчик без гашения
// написал 38 строк за 5 минут — 2.7 МиБ/сутки против бюджета владельца в 1 МиБ. Сторож, живущий
// на таком сигнале, качал бы модель туда-сюда весь день (риск «качели», критерий P5 плана 26).
let candSig = '', candCount = 0, candFirstSeen = null;

// Агрегаты с последней записанной строки. Они существуют, чтобы гашение не СТИРАЛО дребезг из
// записи: сердцебиение всё равно сообщит пик и среднее.
let aggUtilMax = 0, aggUtilSum = 0, aggUtilN = 0;
const resetAgg = () => { aggUtilMax = 0; aggUtilSum = 0; aggUtilN = 0; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
// Контейнер останавливают сигналом, а не файлом, — буфер обязан долететь до диска.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; });

try {
  while (!stopping) {
    if (await exists(stopFile)) break;
    ticks++;

    const g = await sampleGpu();
    if (!g) { await sleep(INTERVAL_SEC * 1000); continue; }

    const now = Date.now();
    if (now - lastKlasPoll >= KLAS_EVERY_SEC * 1000) { klas = await klasRunning(); lastKlasPoll = now; }

    aggUtilMax = Math.max(aggUtilMax, g.util_gpu);
    aggUtilSum += g.util_gpu;
    aggUtilN++;

    const why = [];
    if (Math.abs(g.mem_used - lastMem) >= MEM_STEP_MIB) why.push('mem');
    if (Math.abs(g.util_gpu - lastUtil) >= UTIL_STEP_PCT) why.push('util');
    if (klas !== lastKlas) why.push('klas');

    // Подпись грубая НАМЕРЕННО: это и есть «состояние карты» в терминах эпика. Два отсчёта с
    // одной подписью — одна и та же ситуация, как бы ни дрожали сырые числа.
    const sig = `${Math.floor(g.mem_used / MEM_STEP_MIB)}|${Math.floor(g.util_gpu / UTIL_STEP_PCT)}|${klas}`;

    const isFirst = ticks === 1;
    const isHb = now - lastHb >= HEARTBEAT_MIN * 60_000;

    let confirmed = false;
    if (why.length > 0) {
      if (sig === candSig) { candCount++; }
      else { candSig = sig; candCount = 1; candFirstSeen = now; }
      if (candCount >= CONFIRM_POLLS) confirmed = true;
    } else {
      // Вернулись к последнему записанному состоянию: то, что дребезжало, не закрепилось.
      candSig = ''; candCount = 0;
    }

    if (isFirst || isHb || confirmed) {
      const ev = isFirst ? 'start' : (confirmed ? 'change' : 'hb');
      const rec = {
        ts: stamp(),
        ev,
        // Метка источника. По ней реплей понимает, каких полей в строке нет ПО УСТРОЙСТВУ,
        // и отказывается судить правила, которым не хватает входа, вместо тихого нуля.
        src: 'docker',
        why: isFirst ? [] : why,
        mem_used: g.mem_used,
        mem_free: g.mem_total - g.mem_used,
        util_gpu: g.util_gpu,
        util_mem: g.util_mem,
        clk_sm: g.clk_sm,
        pwr_w: g.pwr_w,
        temp_c: g.temp_c,
        klas,
        // Что происходило МЕЖДУ строками. Без них гашение тихо стёрло бы дребезжащего
        // потребителя из записи, и реплей увидел бы спокойный день, которого не было.
        util_max: aggUtilMax,
        util_avg: Math.round((aggUtilSum / Math.max(aggUtilN, 1)) * 10) / 10,
      };
      // Когда строка — подтверждённая смена, скажи, когда новое состояние УВИДЕЛИ впервые:
      // задержка подтверждения наша, и реплей, меряющий время реакции, не должен её платить.
      if (confirmed && candFirstSeen) rec.first_seen = stamp(new Date(candFirstSeen));

      addEvent(rec);
      lastMem = g.mem_used; lastUtil = g.util_gpu; lastKlas = klas;
      lastHb = now; candSig = ''; candCount = 0;
      resetAgg();
    }

    if (now - lastFlush >= FLUSH_SEC * 1000) { await flush(); lastFlush = now; }
    await sleep(INTERVAL_SEC * 1000);
  }

  addEvent({ ts: stamp(), ev: 'stop', src: 'docker', why: [stopping ? 'signal' : 'stopfile'] });
} finally {
  await flush();
  if (await exists(stopFile)) await unlink(stopFile).catch(() => {});
}
