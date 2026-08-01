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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--snr", default="12,6,0,-6",
                    help="на сколько дБ имя громче речи ассистента в микрофоне")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--keep", action="store_true", help="оставить смешанные wav для прослушивания")
    a = ap.parse_args()
    snrs = [float(s) for s in a.snr.split(",") if s.strip()]

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

    print("\nЧитается так: строки «имя поверх речи» с пометкой !!! — это условия, в которых владелец")
    print("говорит имя, а ассистент его не слышит. Контрольная строка с !!! — обратная беда:")
    print("ассистент перебивает сам себя собственным голосом.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
