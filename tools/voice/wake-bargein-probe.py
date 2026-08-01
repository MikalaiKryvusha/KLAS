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

WORD = {"jarvis": "Джарвис", "joy": "Джой"}
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


def synth_assistant():
    """Реплика ассистента ртом проекта — тем же, что звучит в бою."""
    wav = os.path.join(OUT_DIR, "bargein-assistant.wav")
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
    a = ap.parse_args()
    snrs = [float(s) for s in a.snr.split(",") if s.strip()]
    noise_snrs = [float(s) for s in a.noise_snr.split(",") if s.strip()]

    os.makedirs(OUT_DIR, exist_ok=True)
    paths = [os.path.join(TRAINED, f"{s}.onnx") for s in WORD]
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        raise SystemExit(f"нет моделей: {missing}")

    from openwakeword.model import Model
    model = Model(wakeword_models=paths, inference_framework="onnx")
    slugs = list(model.models.keys())
    print(f"детекторы: {slugs}   ·   порог боевого слушателя: {a.threshold}\n")

    assistant = synth_assistant()
    print(f"реплика ассистента: {len(assistant)/SR:.2f} с · «{ASSISTANT_LINE}»\n")

    if a.selfcheck:
        return 0 if selfcheck(model) else 1

    rows = []
    for slug in slugs:
        name = to_16k_mono(pick_name_clip(slug))
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
            print(f"\n=== {WORD[slug]} ===")
            cur = slug
        fired = "СРАБОТАЛ БЫ" if score >= a.threshold else "молчит"
        control = cond.startswith("ТОЛЬКО")
        mark = ("OK " if (score < a.threshold) else "!!!") if control else ("OK " if score >= a.threshold else "!!!")
        print(f"  {mark} {cond.ljust(w)}  пик {score:.3f}  → {fired}")

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
