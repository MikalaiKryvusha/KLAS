# tools/voice/wakeword-compare.py — СРАВНИТЕЛЬНЫЙ замер активаторов (план 19, шаг 3).
#
# Зачем отдельно от `wakeword-probe.py`. Тот стенд зашит на ГОТОВЫЕ модели (`hey_jarvis`, `alexa`) и
# отвечал на вопрос «годятся ли они». Теперь вопрос другой: как наши ОБУЧЕННЫЕ модели соотносятся с
# ними и друг с другом. Прежний стенд оставлен нетронутым — он несёт зафиксированный результат
# 2026-07-29 и служит историческим свидетельством.
#
# ⚠️ ПОЧЕМУ ВСЁ МЕРЯЕТСЯ В ОДНОМ ПРОГОНЕ, а не сравнивается с записанными числами.
# Фикстура `voice/out/kws` лежит ВНЕ git и была утеряна между 07-29 и 08-01; пересозданные клипы
# дали sherpa 2/6 там, где журнал помнил 3/6. Значит запомненным числам верить нельзя: сравнивать
# надо то, что измерено ЗДЕСЬ И СЕЙЧАС на ОДНОМ И ТОМ ЖЕ звуке. Иначе меряется не качество моделей,
# а разница фикстур (то же правило, что в `tts-sherpa-probe.mjs`: сравнение с числом из документа
# меряет погоду, а не движки).
#
# ⚠️ КОНТРОЛЬ ОБЯЗАТЕЛЕН. Клипы `ctrl_*` синтезированы настоящей английской моделью; `alexa` на них
# обязана сработать. Молчащий на всём детектор — обычно сломанный стенд, а не негодная модель
# (EXP-0027). Если контроль не зажёгся, все прочие числа этого прогона недействительны.
#
# ⚠️ ПЕРЕКРЁСТНАЯ ПРОВЕРКА. «Джарвис» не должен зажигаться на «Джои» и наоборот — два активатора
# выбирают РАЗНЫЕ персоны, и путаница между ними хуже пропуска: ассистент ответит не тем голосом.
# Поэтому для каждой модели клипы ЧУЖОГО имени считаются ОТРИЦАТЕЛЬНЫМИ.
#
# Запуск:
#   F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-compare.py
#
# [NOT-TESTED] — родился 2026-08-01.

import glob
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

from openwakeword.model import Model  # noqa: E402

CLIPS_DIR = r"F:\KLAS\voice\out\kws"
TRAINED_DIR = r"F:\KLAS\voice\wakeword\training"
TARGET_SR = 16000
THRESHOLD = 0.5            # штатный порог библиотеки
FRAME = 1280               # 80 мс — так библиотека работает с живым потоком

# Модель → какой префикс клипов считается для неё ПОЛОЖИТЕЛЬНЫМ. Всё остальное (кроме контроля) —
# отрицательное, включая клипы ЧУЖОГО имени.
MODELS = [
    ("jarvis", os.path.join(TRAINED_DIR, "jarvis.onnx"), "pos_jarvis"),
    # Прежняя версия «Джарвиса» (до перекрёстных негативов) — чтобы эффект лечения был ВИДЕН
    # прямым сравнением в одном прогоне, а не сверкой с числами из отчёта. Разброс замера ±0.018,
    # поэтому «стало лучше» надо доказывать на одном звуке в один момент.
    ("jarvis_v1", os.path.join(TRAINED_DIR, "jarvis_v1_baseline.onnx"), "pos_jarvis"),
    ("joy", os.path.join(TRAINED_DIR, "joy.onnx"), "pos_joi"),
    ("hey_jarvis", "hey_jarvis", "pos_jarvis"),      # готовая — для сравнения на ТОМ ЖЕ звуке
    ("alexa", "alexa", "__ctrl_only__"),             # только контроль исправности стенда
]


def load_16k(path: str) -> np.ndarray:
    data, sr = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != TARGET_SR:
        g = np.gcd(int(sr), TARGET_SR)
        data = resample_poly(data, TARGET_SR // g, int(sr) // g)
    return (np.clip(data, -1.0, 1.0) * 32767).astype(np.int16)


def main() -> int:
    available = [(n, p, pos) for n, p, pos in MODELS
                 if not p.endswith(".onnx") or os.path.exists(p)]
    missing = [n for n, p, _ in MODELS if p.endswith(".onnx") and not os.path.exists(p)]
    if missing:
        print(f"⚠️ ещё не обучены, пропускаю: {', '.join(missing)}\n")

    files = sorted(glob.glob(os.path.join(CLIPS_DIR, "*.wav")))
    if not files:
        print(f"нет wav в {CLIPS_DIR} — фикстуру собирают kws-probe.mjs и wakeword-fixture-ctrl.py",
              file=sys.stderr)
        return 2

    # Одна модель на прогон: openWakeWord держит своё состояние потока, и мешать их в одном объекте
    # значит мерить взаимное влияние, а не модели.
    scores = {}
    for name, path, _ in available:
        model = Model(wakeword_models=[path], inference_framework="onnx")
        key = list(model.models.keys())[0]
        for f in files:
            audio = load_16k(f)
            model.reset()
            pad = (-len(audio)) % FRAME
            if pad:
                audio = np.concatenate([audio, np.zeros(pad, dtype=audio.dtype)])
            best = 0.0
            for i in range(0, len(audio), FRAME):
                best = max(best, model.predict(audio[i:i + FRAME]).get(key, 0.0))
            scores[(name, os.path.basename(f))] = best

    names = [n for n, _, _ in available]
    clips = [os.path.basename(f) for f in files]

    print(f"{'клип':<24}" + "".join(f"{n:>13}" for n in names))
    print("-" * (24 + 13 * len(names)))
    for c in clips:
        row = "".join(f"{scores[(n, c)]:>13.3f}" for n in names)
        print(f"{c:<24}{row}")

    # --- Контроль: без него числа выше недействительны ---------------------------------------------
    ctrl = scores.get(("alexa", "ctrl_alexa_en.wav"), 0.0)
    print(f"\nКОНТРОЛЬ СТЕНДА: «Alexa.» настоящей моделью → alexa = {ctrl:.3f}")
    if ctrl < THRESHOLD:
        print("❌ КОНТРОЛЬ НЕ ЗАЖЁГСЯ — стенд неисправен, все числа этого прогона недействительны.")
        return 1
    print("✅ стенд исправен: формат звука и кадровая подача верны.")

    # --- Счёт по каждой модели ---------------------------------------------------------------------
    print(f"\n{'модель':<14}{'верных':>10}{'ложных':>10}   разбор")
    print("-" * 64)
    ok = True
    for name, _, pos_prefix in available:
        if pos_prefix == "__ctrl_only__":
            continue
        tp = fn = fp = 0
        misses, falses = [], []
        for c in clips:
            if c.startswith("ctrl_"):
                continue
            hit = scores[(name, c)] >= THRESHOLD
            if c.startswith(pos_prefix):
                if hit:
                    tp += 1
                else:
                    fn += 1
                    misses.append(c)
            else:
                if hit:
                    fp += 1
                    falses.append(c)
        detail = []
        if misses:
            detail.append("пропуски: " + ", ".join(m.replace(".wav", "") for m in misses))
        if falses:
            detail.append("ЛОЖНЫЕ: " + ", ".join(m.replace(".wav", "") for m in falses))
        print(f"{name:<14}{tp:>5}/{tp + fn:<4}{fp:>6}     {' · '.join(detail) or '—'}")
        if name in ("jarvis", "joy"):
            ok = ok and fp == 0
    print(f"\n(порог {THRESHOLD}; для каждой модели клипы ЧУЖОГО имени считаются отрицательными)")
    print("⚠️ Речь СИНТЕЗИРОВАНА. Положительный результат — зелёный свет живой проверке "
          "микрофоном владельца, а НЕ вердикт (EXP-0016).")
    return 0 if ok else 0


if __name__ == "__main__":
    raise SystemExit(main())
