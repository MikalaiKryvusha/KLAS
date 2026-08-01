# tools/voice/wake-bargein-probe.py — СТЕНД ПЕРЕБИВАНИЯ: слышно ли имя поверх собственной речи.
#
# Зачем. Владелец на живом микрофоне сказал: «не могу перебить, когда Джарвис или Джой отвечают»
# (`homeworks/04`, `bugs/25`). Код перебивания при этом исправен и проверен фикстурой — значит вопрос
# не в коде, а в АКУСТИКЕ: детектор слушает микрофон, в который из колонок льётся голос ассистента,
# и подавления собственного звука (AEC) у нас нет (EXP-0017). Гадать об этом нельзя — надо померить.
#
# Что меряет. Пиковую оценку детектора на ОДНОМ И ТОМ ЖЕ клипе имени в разных условиях:
#   · чистая комната (эталон)                     — сколько даёт имя, когда ассистент молчит;
#   · имя ПОВЕРХ речи ассистента при разных SNR    — сколько остаётся, когда он говорит;
#   · речь ассистента БЕЗ имени                    — контроль на ложное самоперебивание.
# Последнее условие обязательно: стенд, который умеет только терять оценку, доказывает лишь то, что
# он умеет портить сигнал. Контроль отвечает на встречный вопрос — не зажигается ли детектор от
# собственного голоса ассистента (та самая цена решения «слушать всегда»).
#
# Всё детерминированно: клип имени берётся из корпуса тем же правилом, что и `wake-talk-fixture.py`
# (сортировка + середина списка), реплика ассистента синтезируется ртом проекта. Тексты живут В ФАЙЛЕ:
# кириллица через argv на Windows запрещена (AGENT_GUIDE §9).
#
# Запуск:
#   F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wake-bargein-probe.py
#   … --snr 12,6,0,-6      ← насколько имя громче речи ассистента в микрофоне, дБ
#   … --threshold 0.5      ← порог боевого слушателя (для колонки «сработал бы?»)
#   … --keep               ← оставить смешанные wav в voice/out (послушать самому)
#
# [NOT-TESTED]

import argparse
import json
import os
import shutil
import subprocess
import sys

import time

import numpy as np
import soundfile as sf

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

CORPUS = r"F:\KLAS\voice\wakeword\corpus"
TRAINED = r"F:\KLAS\voice\wakeword\training"
OUT_DIR = r"F:\KLAS\voice\out"
SAY = r"F:\KLAS\tools\voice-say.mjs"
SR = 16000
FRAME = 1280            # 80 мс — родной шаг openWakeWord, тот же, что у слушателя

WORD = {"jarvis": "Джарвис", "joy": "Джой", "ariel": "Ариэль"}
# Реплика ассистента взята ДОСЛОВНО из лога владельца (homeworks/04): меряем на том, что реально
# звучало в комнате, а не на придуманной фразе.
ASSISTANT_LINE = "Дела отлично, сэр. Все системы работают в штатном режиме. Чем могу помочь?"
ASSISTANT_VOICE = "eugene"      # голос Джарвиса в тракте сегодня (заглушка Silero, plans/18)
MIC_DEFAULT = "Микрофон (NVIDIA Broadcast)"   # тот же дефолт, что у слушателя и voice-talk

# Пик живой речи владельца, снятый боевым микрофоном 2026-08-01 (`voice/out/wakeword-live-last.txt`,
# зафиксирован в шапке wakeword-listen.py). Нужен, чтобы перевести замер эха в SNR, а не в «попугаи».
OWNER_SPEECH_PEAK = 1272.0


def to_16k_mono(path):
    d, sr = sf.read(path, dtype="float32")
    if d.ndim > 1:
        d = d.mean(axis=1)
    if sr != SR:
        from scipy.signal import resample_poly
        g = np.gcd(int(sr), SR)
        d = resample_poly(d, SR // g, int(sr) // g)
    return np.clip(d, -1, 1).astype(np.float32)


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)))) or 1e-9


def base_slug(model_name):
    """Какому ИМЕНИ принадлежит модель. Поколения зовутся `jarvis_v4_prespeech`, `joy_v1_control` и
    т.п., а клип имени и подпись берутся по базовому слугу — иначе сравнить поколения нечем."""
    for s in WORD:
        if model_name == s or model_name.startswith(s + "_"):
            return s
    raise SystemExit(f"не понял, какому имени принадлежит модель «{model_name}»")


def pick_name_clip(slug):
    """Тот же выбор, что в wake-talk-fixture.py: слово ОБЯЗАНО заканчивать фразу (иначе модель его
    не учила), список сортируется, берётся середина — замер обязан быть повторяемым."""
    man = os.path.join(CORPUS, slug, "manifest.clean.json")
    with open(man, encoding="utf-8") as f:
        m = json.load(f)
    w = WORD[slug]
    good = sorted(c["file"] for c in m["clips"]
                  if c["file"].startswith("positive/")
                  and c["text"].strip().rstrip(".!?").endswith(w))
    if not good:
        raise SystemExit(f"в корпусе {slug} нет клипов, где «{w}» заканчивает фразу")
    return os.path.join(CORPUS, slug, good[len(good) // 2])


def synth_assistant(resynth=False):
    """Реплика ассистента ртом проекта — тем же, что звучит в бою.

    ⛔ СТИМУЛ КЭШИРУЕТСЯ, И ЭТО НЕ ОПТИМИЗАЦИЯ. Silero стохастичен: два синтеза одного текста тем же
    голосом дают РАЗНЫЙ звук (записано в каноне про генератор корпуса). Пока стимул пересинтезировался
    на каждом запуске, у каждого прогона была своя помеха — и числа разных прогонов оказывались
    несравнимы. Поймано числом 2026-08-01: один и тот же файл модели дал контроль 0.001 утром и 0.666
    вечером. Теперь реплика синтезируется ОДИН раз и лежит файлом; `--resynth` пересоздаёт её
    осознанно, и после этого прошлые числа сравнивать уже нельзя.
    """
    wav = os.path.join(OUT_DIR, "bargein-assistant.wav")
    if os.path.exists(wav) and not resynth:
        return to_16k_mono(wav)
    node = shutil.which("node")
    if not node:
        raise SystemExit("node не найден в PATH")
    # Без shell=True: cmd /c провёл бы кириллицу через консольную кодировку (AGENT_GUIDE §9).
    r = subprocess.run([node, SAY, ASSISTANT_LINE, "--out", wav, "--voice", ASSISTANT_VOICE],
                       capture_output=True)
    if r.returncode != 0 or not os.path.exists(wav):
        print(r.stderr.decode("utf-8", "replace")[-500:], file=sys.stderr)
        raise SystemExit("рот не синтезировал реплику ассистента")
    return to_16k_mono(wav)


def peak_score(model, x, slug):
    """Максимальная оценка детектора `slug` по всему сигналу. Буфер модели сбрасывается перед
    каждым прогоном: иначе предыдущее условие «догорает» в окне и портит следующее."""
    model.reset()
    peak = 0.0
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    for i in range(len(pcm) // FRAME):
        scores = model.predict(pcm[i * FRAME:(i + 1) * FRAME])
        peak = max(peak, float(scores.get(slug, 0.0)))
    return peak


AEC_EXE = r"F:\KLAS\tools\voice\aec-capture\aec-capture.exe"
ECHO_LEN_ARGS = []      # заполняется из --echo-length: длина хвоста эха, мс


def capture_while_playing(cmd, wav, seconds, out_path):
    """Записать поток дочернего процесса, пока в колонках играет реплика ассистента.

    Один код на оба захвата — с подавлением и контрольный без него: сравнивать «с AEC» надо с ТЕМ ЖЕ
    трактом, иначе меряешь разницу двух программ, а не работу подавителя.
    """
    # ⛔ ПОРЯДОК НЕ ПРОИЗВОЛЕН. Сначала ИГРАЕМ, потом захватываем: встроенный DSP в режиме source
    # отказывается стартовать, если на колонках нет активного потока, и возвращает
    # `WMAAECMA_E_NO_ACTIVE_RENDER_STREAM` (0x87CC000A — имя найдено в wmcodecdsp.h, не угадано).
    # Обратный порядок «сначала микрофон, через секунду речь» давал именно эту ошибку.
    play = subprocess.Popen(
        ["powershell", "-NoProfile", "-Command", f"(New-Object Media.SoundPlayer '{wav}').PlaySync()"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.3)                                   # даём потоку на колонках реально открыться
    cap = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    need = int(seconds * SR) * 2
    buf = bytearray()
    while len(buf) < need:
        chunk = cap.stdout.read(min(FRAME * 2, need - len(buf)))
        if not chunk:
            break
        buf += chunk
    play.wait()
    cap.terminate()
    err = cap.stderr.read().decode("utf-8", "replace")
    x = np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32) / 32767.0
    if len(x):
        sf.write(out_path, x, SR, subtype="PCM_16")
    return x, err


def aec_compare(model, mic, spk):
    """ЗАМЕР ПОДАВЛЕНИЯ: один и тот же тракт с AEC и без, пока играет реплика ассистента.

    Критерий приёмки задан числом заранее (`plans/20`): подавление ≥15 дБ, потому что в комнате
    SNR 0…+3 дБ, а детектору нужно +18 дБ.
    """
    wav = os.path.join(OUT_DIR, "bargein-assistant.wav")
    play_len = len(to_16k_mono(wav)) / SR
    dur = play_len + 1.5
    res = {}
    for label, extra in (("БЕЗ AEC (контроль)", ["--no-aec"]), ("С AEC", [])):
        cmd = [AEC_EXE, "--mic", str(mic), "--spk", str(spk)] + extra + ECHO_LEN_ARGS
        out = os.path.join(OUT_DIR, f"aec-{'off' if extra else 'on'}.wav")
        x, err = capture_while_playing(cmd, wav, dur, out)
        if not len(x):
            print(f"  ✖ {label}: захват пуст. stderr: {err.strip()[:300]}")
            return
        pcm = np.abs(x * 32767.0)
        # Захват стартует ЧЕРЕЗ 0.3 с после начала речи (иначе DSP не запустится, см. выше),
        # поэтому эхо — это начало записи, а тишина для пола — её хвост, уже после конца реплики.
        body = pcm[: int(max(play_len - 0.5, 0.5) * SR)]
        floor = float(pcm[int((play_len + 0.2) * SR):].mean()) if len(pcm) > int((play_len + 0.4) * SR) else 0.0
        res[label] = (floor, float(body.mean()), float(body.max()), x)
        print(f"  {label:18} пол после речи {floor:6.1f} · эхо средний {body.mean():7.1f} · пик {body.max():6.0f}")

    off, on = res["БЕЗ AEC (контроль)"], res["С AEC"]
    supp_mean = 20.0 * np.log10(max(off[1], 1e-6) / max(on[1], 1e-6))
    supp_peak = 20.0 * np.log10(max(off[2], 1e-6) / max(on[2], 1e-6))
    print(f"\n  ⇒ подавление эха: {supp_mean:+.1f} дБ по среднему · {supp_peak:+.1f} дБ по пику")
    print(f"  критерий приёмки (plans/20): ≥15 дБ  →  {'ДОСТИГНУТ' if supp_mean >= 15 else 'НЕ достигнут'}")
    for slug in model.models:
        print(f"  детектор {WORD[slug]} на остатке эха: пик {peak_score(model, on[3], slug):.3f} "
              f"(должен молчать, порог 0.5)")


def aec_converge(mic, spk, seconds):
    """СХОДИТСЯ ЛИ ФИЛЬТР. Адаптивный подавитель эха настраивается на акустику комнаты не мгновенно;
    короткий замер судит холодный старт и потому занижает результат. Здесь стимул длинный — реплика
    по кругу, — и уровень эха печатается по окнам: падает от окна к окну ⇒ фильтр сходится, и в бою
    (слушатель работает непрерывно) подавление будет тем, что видно в ХВОСТЕ, а не в начале.
    """
    src = to_16k_mono(os.path.join(OUT_DIR, "bargein-assistant.wav"))
    stim = np.resize(src, int(seconds * SR)).astype(np.float32)
    wav = os.path.join(OUT_DIR, "bargein-stimulus.wav")
    sf.write(wav, stim, SR, subtype="PCM_16")

    cmd = [AEC_EXE, "--mic", str(mic), "--spk", str(spk)]
    x, err = capture_while_playing(cmd, wav, seconds - 0.5, os.path.join(OUT_DIR, "aec-converge.wav"))
    if not len(x):
        print(f"  ✖ захват пуст. stderr: {err.strip()[:300]}")
        return
    pcm = np.abs(x * 32767.0)
    win = 5 * SR
    print(f"  окна по 5 с (эхо в микрофоне после подавления):")
    levels = []
    for i in range(len(pcm) // win):
        m = float(pcm[i * win:(i + 1) * win].mean())
        levels.append(m)
        print(f"    {i*5:3d}–{(i+1)*5:3d} с : средний {m:7.1f}")
    if len(levels) >= 2:
        drop = 20.0 * np.log10(max(levels[0], 1e-6) / max(levels[-1], 1e-6))
        print(f"\n  ⇒ от первого окна к последнему: {drop:+.1f} дБ "
              f"({'фильтр сходится' if drop > 3 else 'сходимости не видно'})")


def selfcheck(model):
    """СТЕНД ОБЯЗАН ДОКАЗАТЬ, ЧТО ЕМУ МОЖНО ВЕРИТЬ — до того, как его числа попадут в документ.

    Проект это уже оплатил: потоковый стенд `wakeword-compare.py` давал 0.52 / 0.052 / 0.084 на ОДНОМ
    клипе, и его показания едва не стали каноном (EXP-0047). Здесь две проверки, отвечающие на два
    разных вопроса:
      1. ПОВТОРЯЕМОСТЬ — один и тот же вход трижды обязан дать одно и то же число (иначе меряем погоду);
      2. ВЫРОЖДЕННЫЙ СЛУЧАЙ — фон, умноженный на НОЛЬ, обязан вернуть в точности эталон (иначе врёт
         арифметика смешивания, а не модель).
    """
    ok = 0
    total = 0
    print("\n=== Самопроверка стенда ===")
    for slug in model.models:
        name = to_16k_mono(pick_name_clip(slug))
        clean = np.concatenate([np.zeros(int(2.5 * SR), dtype=np.float32), name,
                                np.zeros(int(1.0 * SR), dtype=np.float32)])
        runs = [peak_score(model, clean, slug) for _ in range(3)]
        same = max(runs) - min(runs) < 1e-6
        total += 1
        ok += same
        print(f"  {'OK  ' if same else 'ПРОВАЛ'} {WORD[slug]}: три прогона одного клипа → "
              f"{', '.join(f'{r:.3f}' for r in runs)}")

        bed = np.resize(to_16k_mono(os.path.join(OUT_DIR, 'bargein-assistant.wav')), len(clean))
        zero = np.clip(clean + bed * 0.0, -1, 1).astype(np.float32)
        z = peak_score(model, zero, slug)
        good = abs(z - runs[0]) < 1e-6
        total += 1
        ok += good
        print(f"  {'OK  ' if good else 'ПРОВАЛ'} {WORD[slug]}: фон × 0 → {z:.3f} (эталон {runs[0]:.3f})")
    print(f"\n  {ok}/{total}")
    return ok == total


def live_echo(model, device):
    """ЖИВОЙ замер эха: играем реплику в колонки и одновременно пишем микрофон.

    Синтетическая смесь отвечает на вопрос «что будет при таком-то SNR», но НЕ говорит, какой SNR в
    комнате владельца на самом деле. Здесь это меряется: сколько остаётся от собственного голоса
    ассистента в его же микрофоне (эхо), при том что микрофон идёт через NVIDIA Broadcast, у которого
    есть шумодав и подавление реверберации, но НЕТ подавления эха из колонок.
    Записывается ещё и тишина ДО проигрывания — иначе «громко» не с чем сравнивать.
    """
    wav = os.path.join(OUT_DIR, "bargein-assistant.wav")
    rec = os.path.join(OUT_DIR, "bargein-live-capture.wav")
    dur = len(to_16k_mono(wav)) / SR + 2.0        # +1 с тишины до и после

    cap = subprocess.Popen(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "dshow",
         "-i", f"audio={device}", "-ac", "1", "-ar", str(SR), "-t", f"{dur:.2f}", rec],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    time.sleep(1.0)                                # секунда тишины: пол шума комнаты
    play = subprocess.Popen(
        ["powershell", "-NoProfile", "-Command",
         f"(New-Object Media.SoundPlayer '{wav}').PlaySync()"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    play.wait()
    err = cap.communicate()[1].decode("utf-8", "replace")
    if not os.path.exists(rec):
        print(f"  запись не удалась: {err[:300]}")
        return

    x = to_16k_mono(rec)
    pcm = np.abs((np.clip(x, -1, 1) * 32767).astype(np.int32))
    head = pcm[: int(0.8 * SR)]                   # тишина до проигрывания
    body = pcm[int(1.0 * SR):]                    # то, что слышно во время речи ассистента
    silence = float(head.mean()) if len(head) else 0.0
    echo_mean, echo_peak = float(body.mean()), float(body.max())
    # SNR = насколько речь владельца громче эха. Пик его речи снят тем же микрофоном.
    snr = 20.0 * np.log10(OWNER_SPEECH_PEAK / max(echo_peak, 1e-6))

    print("\n=== ЖИВОЙ ЗАМЕР ЭХА (колонки → микрофон) ===")
    print(f"  тишина комнаты до проигрывания : средний модуль {silence:.1f}")
    print(f"  во время речи ассистента       : средний {echo_mean:.1f} · пик {echo_peak:.0f}")
    print(f"  пик живой речи владельца (замер 2026-08-01): {OWNER_SPEECH_PEAK:.0f}")
    print(f"  ⇒ реальный SNR «владелец против эха»: {snr:+.1f} дБ")
    for slug in model.models:
        print(f"  детектор {WORD[slug]} на ОДНОМ эхе: пик {peak_score(model, x, slug):.3f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--snr", default="12,6,0,-6",
                    help="на сколько дБ имя громче речи ассистента в микрофоне")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--keep", action="store_true", help="оставить смешанные wav для прослушивания")
    ap.add_argument("--noise-snr", default="",
                    help="проверить устойчивость к ШИРОКОПОЛОСНОМУ шуму (модель «микрофон без "
                         "шумодава»), напр. 30,24,18,12 — насколько активатор держится без NVIDIA Broadcast")
    ap.add_argument("--selfcheck", action="store_true",
                    help="доказать повторяемость стенда (тихо: без звука и без микрофона)")
    ap.add_argument("--live-echo", action="store_true",
                    help="ЖИВОЙ замер: проиграть реплику в колонки и записать микрофоном — насколько "
                         "громко ассистент слышен сам себе (~7 с звука в комнате). ⚠️ ТРЕБУЕТ --room-is-quiet")
    # ⭐ ПРАВИЛО ВЛАДЕЛЬЦА (2026-08-01, дословно): «КОГДА МЕРЯЕШЬ ШУМ - ПРЕДУПРЕЖДАЙ МЕНЯ!!! У МЕНЯ
    # БЫВАЕТ ШУМНО В КОМНАТЕ». Причина двойная: агент шумит в живой комнате без спроса, И замер,
    # снятый в шумной комнате, ЛОЖЕН — а выглядит как настоящий. Поэтому флаг не косметический:
    # он означает «я спросил владельца, и он подтвердил, что в комнате тихо».
    ap.add_argument("--room-is-quiet", action="store_true",
                    help="владелец предупреждён и подтвердил тишину — без этого живой замер не пойдёт")
    ap.add_argument("--device", default=MIC_DEFAULT)
    ap.add_argument("--resynth", action="store_true",
                    help="пересоздать реплику-стимул (после этого числа прошлых прогонов несравнимы)")
    ap.add_argument("--models", default="",
                    help="какие файлы моделей мерить В ОДНОМ прогоне, через запятую "
                         "(напр. jarvis,jarvis_v4_prespeech) — только так сравнимы поколения")
    ap.add_argument("--echo-length", type=int, default=0,
                    help="длина хвоста эха для DSP, мс (звук через телевизор по HDMI приходит поздно)")
    ap.add_argument("--aec-converge", type=float, default=0.0,
                    help="сходится ли фильтр: N секунд непрерывного стимула, уровень эха по окнам. "
                         "⚠️ ТРЕБУЕТ --room-is-quiet")
    ap.add_argument("--aec-compare", action="store_true",
                    help="замерить ПОДАВЛЕНИЕ эха: тот же тракт с AEC и без. ⚠️ ТРЕБУЕТ --room-is-quiet")
    ap.add_argument("--aec-mic", type=int, default=0, help="индекс waveIn СЫРОГО микрофона (до шумодава)")
    ap.add_argument("--aec-spk", type=int, default=0, help="индекс waveOut колонок ассистента")
    a = ap.parse_args()
    snrs = [float(s) for s in a.snr.split(",") if s.strip()]
    noise_snrs = [float(s) for s in a.noise_snr.split(",") if s.strip()]
    if a.echo_length > 0:
        ECHO_LEN_ARGS[:] = ["--echo-length", str(a.echo_length)]

    os.makedirs(OUT_DIR, exist_ok=True)
    paths = [os.path.join(TRAINED, f"{s}.onnx") for s in WORD]
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        raise SystemExit(f"нет моделей: {missing}")

    # ⚠️ Сравнивать поколения моделей ЧИСЛАМИ ИЗ РАЗНЫХ ПРОГОНОВ нельзя — это уже подвело на другом
    # стенде (`wakeword-eval-fixed.py`: контрольная модель дала 73.7% и 35.0% в двух прогонах).
    # Поэтому здесь можно подать ЛЮБЫЕ файлы моделей и получить их числа в ОДНОМ прогоне, на одних
    # и тех же клипах: `--models jarvis,jarvis_v4_prespeech`.
    if a.models:
        paths = [os.path.join(TRAINED, f"{n.strip()}.onnx") for n in a.models.split(",") if n.strip()]
        missing = [p for p in paths if not os.path.exists(p)]
        if missing:
            raise SystemExit(f"нет моделей: {missing}")

    from openwakeword.model import Model
    model = Model(wakeword_models=paths, inference_framework="onnx")
    slugs = list(model.models.keys())
    print(f"детекторы: {slugs}   ·   порог боевого слушателя: {a.threshold}\n")

    assistant = synth_assistant(a.resynth)
    stim = os.path.join(OUT_DIR, "bargein-assistant.wav")
    import hashlib
    sha = hashlib.sha256(open(stim, "rb").read()).hexdigest()[:12]
    # Отпечаток стимула печатается ВСЕГДА: он и есть доказательство, что два прогона мерили одно и
    # то же. Разные отпечатки — числа несравнимы, сколько бы одинаково они ни выглядели.
    print(f"реплика ассистента: {len(assistant)/SR:.2f} с · sha {sha} · «{ASSISTANT_LINE}»\n")

    if a.selfcheck:
        return 0 if selfcheck(model) else 1

    rows = []
    for slug in slugs:
        name = to_16k_mono(pick_name_clip(base_slug(slug)))
        lead = np.zeros(int(2.5 * SR), dtype=np.float32)   # окно детектора 2.0 с должно наполниться
        tail = np.zeros(int(1.0 * SR), dtype=np.float32)

        clean = np.concatenate([lead, name, tail])
        rows.append((slug, "чистая комната (эталон)", peak_score(model, clean, slug)))

        # Речь ассистента идёт НЕПРЕРЫВНО, имя ложится поверх неё — как в комнате, где из колонок
        # звучит ответ, а человек говорит имя. Кусок речи берётся с начала и зацикливается по длине.
        bed = np.resize(assistant, len(clean))
        for snr in snrs:
            gain = rms(name) / rms(bed) / (10 ** (snr / 20.0))
            mixed = np.clip(clean + bed * gain, -1, 1).astype(np.float32)
            rows.append((slug, f"имя поверх речи ассистента, SNR {snr:+.0f} дБ",
                         peak_score(model, mixed, slug)))
            if a.keep:
                sf.write(os.path.join(OUT_DIR, f"bargein-{slug}-snr{int(snr)}.wav"), mixed, SR,
                         subtype="PCM_16")

        # Контроль: одна речь ассистента, имени в ней нет. Детектор ОБЯЗАН молчать, иначе решение
        # «слушать всегда» даёт ложные самоперебивания.
        only = np.concatenate([lead, np.resize(assistant, len(name) + len(tail))])
        rows.append((slug, "ТОЛЬКО речь ассистента (контроль)", peak_score(model, only, slug)))

        # ⭐ Вопрос владельца 2026-08-01: «может мне выключить NVIDIA Broadcast? там шумоподавление
        # включено, ты меряешь не совсем комнату». Замечание верное, и вот его цена: активаторы
        # учились на синтезе, окружённом ПОЧТИ ЦИФРОВОЙ ТИШИНОЙ, а шумодав даёт им ровно такой пол
        # (0.0). Значит выключение шумодава — не нейтральное действие: оно поднимает пол шума и
        # может само по себе ослепить детектор. Меряем ШИРОКОПОЛОСНЫМ шумом (не речью!) — это и
        # есть модель «микрофон без подавления».
        if noise_snrs:
            rng = np.random.default_rng(20260801)     # фиксированное зерно: замер обязан повторяться
            hiss = rng.standard_normal(len(clean)).astype(np.float32)
            for snr in noise_snrs:
                gain = rms(name) / rms(hiss) / (10 ** (snr / 20.0))
                rows.append((slug, f"имя поверх ШУМА (без шумодава), SNR {snr:+.0f} дБ",
                             peak_score(model, np.clip(clean + hiss * gain, -1, 1).astype(np.float32), slug)))

    w = max(len(r[1]) for r in rows)
    cur = None
    for slug, cond, score in rows:
        if slug != cur:
            print(f"\n=== {WORD[base_slug(slug)]}  ·  модель {slug} ===")
            cur = slug
        fired = "СРАБОТАЛ БЫ" if score >= a.threshold else "молчит"
        control = cond.startswith("ТОЛЬКО")
        mark = ("OK " if (score < a.threshold) else "!!!") if control else ("OK " if score >= a.threshold else "!!!")
        print(f"  {mark} {cond.ljust(w)}  пик {score:.3f}  → {fired}")

    if a.aec_converge > 0:
        if not a.room_is_quiet:
            print("\n⛔ НЕ ЗАПУЩЕНО: это длинный прогон со звуком. Предупреди владельца и повтори с --room-is-quiet.")
            return 1
        print(f"\n=== СХОДИМОСТЬ ФИЛЬТРА ({a.aec_converge:.0f} с непрерывного стимула) ===")
        aec_converge(a.aec_mic, a.aec_spk, a.aec_converge)

    if a.aec_compare:
        if not a.room_is_quiet:
            print("\n⛔ ЗАМЕР ПОДАВЛЕНИЯ НЕ ЗАПУЩЕН: два прогона со звуком в колонки и записью микрофона.")
            print("   Предупреди владельца, дождись подтверждения тишины и повтори с --room-is-quiet.")
            return 1
        print("\n=== ЗАМЕР ПОДАВЛЕНИЯ ЭХА (тот же тракт с AEC и без) ===")
        aec_compare(model, a.aec_mic, a.aec_spk)

    if a.live_echo:
        if not a.room_is_quiet:
            print("\n⛔ ЖИВОЙ ЗАМЕР НЕ ЗАПУЩЕН: он играет звук в колонки и пишет микрофон.")
            print("   Сначала предупреди владельца и дождись подтверждения, что в комнате тихо —")
            print("   замер в шумной комнате даёт ЛОЖНОЕ число, неотличимое на вид от настоящего.")
            print("   Затем повтори с флагом --room-is-quiet.")
            return 1
        live_echo(model, a.device)

    print("\nЧитается так: строки «имя поверх речи» с пометкой !!! — это условия, в которых владелец")
    print("говорит имя, а ассистент его не слышит. Контрольная строка с !!! — обратная беда:")
    print("ассистент перебивает сам себя собственным голосом.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
