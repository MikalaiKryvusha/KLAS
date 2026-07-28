// tools/voice/tts-daemon.mjs — Node-обёртка над РЕЗИДЕНТНЫМ сайдкаром Silero (silero_daemon.py).
// Держит питон-процесс живым, чтобы модель грузилась ОДИН раз за сессию, а не на каждую фразу
// (замер 2026-07-28: загрузка 2.2 с против синтеза 1.5 с — researches/12 §3).
//
// Использование:
//   const tts = new TtsDaemon({ voice: 'eugene' });
//   await tts.ready();                       // ждём загрузку модели (один раз)
//   const r = await tts.say('Привет.', 'out.wav');   // r.ok / r.reason === 'no-cyrillic'
//   tts.stop();
//
// Питон обрабатывает запросы строго по одному и по порядку, поэтому очередь ожидающих — обычный FIFO.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

const PY = 'F:\\KLAS\\voice\\venv\\Scripts\\python.exe';   // venv голосового тракта (вне git)
const SIDECAR = path.join(import.meta.dirname, 'silero_daemon.py');

export class TtsDaemon {
  #proc = null;
  #pending = [];          // FIFO ожидающих ответа резолверов
  #readyResolve = null;
  #readyPromise = null;

  constructor({ voice = 'eugene' } = {}) {
    this.voice = voice;
    this.#readyPromise = new Promise((res) => { this.#readyResolve = res; });
    this.#proc = spawn(PY, [SIDECAR], { windowsHide: true });
    this.#proc.stderr.resume();   // тайминги/варнинги питона нам в диалоге не нужны

    readline.createInterface({ input: this.#proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.stage === 'ready') { this.#readyResolve(msg); return; }
      const resolve = this.#pending.shift();
      if (resolve) resolve(msg);
    });

    // Смерть резидента не должна вешать вызывающего: все ждущие получают внятную ошибку
    this.#proc.on('exit', (code) => {
      this.#readyResolve({ stage: 'dead', code });
      for (const resolve of this.#pending.splice(0)) resolve({ ok: false, error: `РОТ умер (код ${code})` });
    });
  }

  ready() { return this.#readyPromise; }

  /** Синтезировать фразу в файл. Возвращает ответ сайдкара: {ok, audio_sec, t_synth_sec} либо
   *  {ok:false, reason:'no-cyrillic'} — «нечего произносить» (bugs/06), это НЕ поломка. */
  say(text, outWav) {
    if (!this.#proc || this.#proc.exitCode !== null) return Promise.resolve({ ok: false, error: 'РОТ не запущен' });
    return new Promise((resolve) => {
      this.#pending.push(resolve);
      this.#proc.stdin.write(`${JSON.stringify({ text, out: outWav, voice: this.voice })}\n`);
    });
  }

  stop() { try { this.#proc?.stdin.end('quit\n'); } catch { /* уже мёртв */ } }
}
