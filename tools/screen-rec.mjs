#!/usr/bin/env node
/**
 * screen-rec.mjs — «ЗРЕНИЕ» KLAS: запись экрана кадрами, которые агент потом читает сам.
 *
 * Зачем (идея владельца, 2026-07-28): когда агент управляет Windows (план 16) или гоняет живой тест,
 * он видит только текст в консоли и вынужден ВЕРИТЬ самоотчёту модели о том, что произошло на экране.
 * Запись 1 кадр/с делает происходившее наблюдаемым постфактум: агент открывает кадры и смотрит сам
 * (`PHILOSOPHY.md` — наблюдение вместо домысла). Тот же инструмент нужен Jarvis/Joi как зрение
 * рабочего стола (идея 05), поэтому он живёт в харнессе, а не в одноразовом скрипте.
 *
 * Кадры — JPEG в `F:\KLAS\screenrec\<сессия>\f_00001.jpg`, по одному в секунду (настраивается).
 * ⚠️ Кадры содержат ВСЁ, что на экране владельца (переписка, пароли, личное) — папка в `.gitignore`,
 *    в git не попадает никогда.
 *
 * ⚠️⚠️ ГЛАВНОЕ ПРАВИЛО ЧИТАЕМОСТИ (оплачено ошибкой 2026-07-28): **не уменьшай кадр, если собираешься
 * ЧИТАТЬ по нему текст.** Рабочий стол здесь 3840 px в ширину; кадр, сжатый до 1920, а потом ещё раз
 * ужатый просмотрщиком агента, превращает мелкий шрифт в кашу — агент уверенно «прочитал» `KLAS IIA
 * test` там, где на экране было `KLAS UIA test`, и записал ложный дефект в баг-документ. Уменьшённый
 * кадр годится ТОЛЬКО для «что происходило вообще» (какое окно, есть ли диалог). Для текста снимай
 * **кроп нужной области в нативном масштабе**: `--crop 1200x400+40+120`.
 *
 * Запуск:
 *   node tools/screen-rec.mjs start [--fps 1] [--name uia-test] [--crop WxH+X+Y] [--width N]
 *   node tools/screen-rec.mjs stop                                    # стоп + сводка
 *   node tools/screen-rec.mjs shot [--crop WxH+X+Y] [--name x]        # один кадр «сейчас»
 *   node tools/screen-rec.mjs list [--last 5]                         # пути свежих кадров
 *
 *   --crop  WxH+X+Y  снимать только прямоугольник экрана (нативный масштаб — текст читается)
 *   --width N        принудительно ужать кадр до N px по ширине (по умолчанию НЕ ужимаем)
 *
 * Требует ffmpeg в PATH (тот же, что у голосового тракта; захват — gdigrab по всему рабочему столу).
 *
 * ⚠️ ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ ЗАХВАТА (найдено разведкой 2026-07-29, `researches/11_agent_vision.md` §1.3):
 * gdigrab работает через GDI/BitBlt и потому **НЕ СНИМАЕТ аппаратно-ускоренные окна** — содержимое,
 * нарисованное GPU (браузеры с аппаратным ускорением, часть UWP, игры), минует конвейер GDI и даёт
 * ЧЁРНЫЙ или битый кадр. Отказ коварен тем, что выглядит как нормальный кадр: агент честно «смотрит»
 * на чёрный прямоугольник и домысливает содержимое. Увидел непонятную черноту на месте окна — это
 * скорее всего ОНО, а не сломанное приложение. Целевое лечение — Windows.Graphics.Capture (или
 * Desktop Duplication с кропом); пока не сделано, живые UI-прогоны проверяй по окнам, которые GDI
 * отдаёт (классические Win32, Блокнот), либо сверяй вывод строкой ОС, а не картинкой (EXP-0010).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REC_ROOT = 'F:\\KLAS\\screenrec';
const STATE = path.join(REC_ROOT, '.current.json');

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

/** Имя сессии: метка + время старта, чтобы записи не перетирали друг друга и читались глазами. */
function sessionDir(name) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(REC_ROOT, `${ts}_${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Общие аргументы захвата. По умолчанию — весь рабочий стол в НАТИВНОМ масштабе (ничего не ужимаем:
 * ужатый кадр врёт при чтении текста). `crop` вида `WxH+X+Y` снимает только нужный прямоугольник —
 * это и есть правильный способ прочитать мелкий шрифт. `width` (необязательно) ужимает кадр, когда
 * нужен обзор, а не текст.
 */
function grabArgs(fps, width, crop) {
  const a = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'gdigrab', '-framerate', String(fps)];
  if (crop) {
    const m = crop.match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
    if (!m) throw new Error(`--crop ждёт формат WxH+X+Y, получено: ${crop}`);
    a.push('-offset_x', m[3], '-offset_y', m[4], '-video_size', `${m[1]}x${m[2]}`);
  }
  a.push('-i', 'desktop');
  if (width) a.push('-vf', `scale=${width}:-1`);
  return a.concat(['-q:v', '3']);
}

if (cmd === 'start') {
  if (fs.existsSync(STATE)) {
    const prev = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    console.error(`уже идёт запись (pid ${prev.pid}, ${prev.dir}) — сначала: node tools/screen-rec.mjs stop`);
    process.exit(2);
  }
  const fps = Number(opt('fps', '1'));
  const width = Number(opt('width', '0'));      // 0 = нативный масштаб (см. правило читаемости выше)
  const crop = opt('crop', '');
  const dir = sessionDir(opt('name', 'rec'));
  const child = spawn('ffmpeg', [...grabArgs(fps, width, crop), path.join(dir, 'f_%05d.jpg')],
    { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, dir, fps, startedAt: new Date().toISOString() }, null, 2), 'utf8');
  console.log(`● запись пошла: ${fps} кадр/с → ${dir} (pid ${child.pid})`);
} else if (cmd === 'stop') {
  if (!fs.existsSync(STATE)) { console.error('записи нет'); process.exit(2); }
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  spawnSync('taskkill', ['/PID', String(st.pid), '/T', '/F'], { encoding: 'utf8' });
  fs.rmSync(STATE, { force: true });
  const frames = fs.existsSync(st.dir) ? fs.readdirSync(st.dir).filter((f) => f.endsWith('.jpg')) : [];
  const secs = (Date.now() - new Date(st.startedAt).getTime()) / 1000;
  console.log(`■ стоп: ${frames.length} кадров за ${secs.toFixed(0)} с → ${st.dir}`);
  // Кадр N снят примерно через N/fps секунд после старта — по этому правилу агент выбирает,
  // какие кадры читать, не открывая все подряд.
  if (frames.length) console.log(`   первый: ${path.join(st.dir, frames[0])}\n   последний: ${path.join(st.dir, frames[frames.length - 1])}`);
} else if (cmd === 'shot') {
  const dir = sessionDir(opt('name', 'shot'));
  const out = path.join(dir, 'f_00001.jpg');
  const r = spawnSync('ffmpeg', [...grabArgs(1, Number(opt('width', '0')), opt('crop', '')), '-frames:v', '1', out], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || 'ffmpeg упал'); process.exit(1); }
  console.log(out);
} else if (cmd === 'list') {
  const last = Number(opt('last', '5'));
  const sessions = fs.existsSync(REC_ROOT)
    ? fs.readdirSync(REC_ROOT).filter((d) => fs.statSync(path.join(REC_ROOT, d)).isDirectory()).sort()
    : [];
  if (!sessions.length) { console.log('записей нет'); process.exit(0); }
  const dir = path.join(REC_ROOT, sessions[sessions.length - 1]);
  const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  console.log(`сессия: ${dir} (${frames.length} кадров)`);
  for (const f of frames.slice(-last)) console.log(path.join(dir, f));
} else {
  console.log('команды: start [--fps 1] [--crop WxH+X+Y] [--width N] [--name x] | stop | shot [--crop …] | list [--last 5]');
}
