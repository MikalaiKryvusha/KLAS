// tools/voice/tts-daemon.mjs — Node-обёртка над РЕЗИДЕНТНЫМ сайдкаром Silero (silero_daemon.py).
// Держит питон-процесс живым, чтобы модель грузилась ОДИН раз за сессию, а не на каждую фразу
// (замер 2026-07-28: загрузка 2.2 с против синтеза 1.5 с — researches/12 §3).
//
// Использование:
//   const tts = new TtsDaemon({ voice: 'eugene' });
//   await tts.ready();                       // ждём загрузку модели + проверку кодировки (один раз)
//   const r = await tts.say('Привет.', 'out.wav');   // r.ok / r.reason === 'no-cyrillic'
//   tts.stop();
//
// Питон обрабатывает запросы строго по одному и по порядку, поэтому очередь ожидающих — обычный FIFO.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

const PY = 'F:\\KLAS\\voice\\venv\\Scripts\\python.exe';   // venv голосового тракта (вне git)
const SIDECAR = path.join(import.meta.dirname, 'silero_daemon.py');

// ОХРАННИК КОДИРОВКИ (bugs/08). Порча текста на стыке Node↔Python не падает и не логируется —
// она ЗВУЧИТ: моджибейк «РџСЂРёРІРµС‚» состоит из настоящих кириллических букв, поэтому проходит
// все проверки и выходит в динамики бормотанием. Единственная надёжная улика — прогнать эталонную
// строку туда-обратно и сверить побуквенно. Канарейка нарочно несёт всё, на чём ломаются кодировки:
// кириллицу, «ё», длинное тире и цифры.
const CANARY = 'Проверка кодировки — ёжик, 42.';

export class TtsDaemon {
  #proc = null;
  #pending = [];          // FIFO ожидающих ответа резолверов
  #readyResolve = null;
  #readyPromise = null;
  #checked = null;        // мемоизированный результат «загружен + кодировка целая»

  // voiceEn === null ⇒ решает сайдкар (там лежит подобранный измерением дефолт, bugs/11).
  // Дублировать значение здесь нельзя: два дефолта в двух файлах разъезжаются молча.
  constructor({ voice = 'eugene', voiceEn = null } = {}) {
    this.voice = voice;
    this.voiceEn = voiceEn;
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

  /** Одна строка запроса → один ответ сайдкара (FIFO). */
  #request(obj) {
    if (!this.#proc || this.#proc.exitCode !== null) return Promise.resolve({ ok: false, error: 'РОТ не запущен' });
    return new Promise((resolve) => {
      this.#pending.push(resolve);
      this.#proc.stdin.write(`${JSON.stringify(obj)}\n`);
    });
  }

  /**
   * Готовность РТА: модель загружена И текст не портится по дороге.
   * Возвращает {stage:'ready'|'dead'|'encoding-broken', …}. Вызывающий ОБЯЗАН отличать
   * 'encoding-broken' от 'ready': на сломанной кодировке синтез «работает», но говорит мусор.
   */
  ready() {
    this.#checked ??= this.#readyPromise.then(async (msg) => {
      if (msg.stage === 'dead') return msg;
      const back = await this.#request({ echo: CANARY });
      if (back?.echo === CANARY) return msg;
      return { stage: 'encoding-broken', sent: CANARY, got: back?.echo ?? null, enc: msg.enc ?? null };
    });
    return this.#checked;
  }

  /** Синтезировать фразу в файл. Возвращает ответ сайдкара: {ok, audio_sec, t_synth_sec} либо
   *  {ok:false, reason:'nothing-to-say'} — в тексте нет ни букв, ни цифр (bugs/06): это НЕ поломка. */
  say(text, outWav) {
    return this.#request({ text, out: outWav, voice: this.voice, ...(this.voiceEn ? { voice_en: this.voiceEn } : {}) });
  }

  stop() { try { this.#proc?.stdin.end('quit\n'); } catch { /* уже мёртв */ } }
}
