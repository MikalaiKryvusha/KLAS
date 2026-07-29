# tools/voice/wakeword-probe.py — СТЕНД слова-активатора на openWakeWord (интервью 007, Q3).
#
# Зачем. Владелец выбрал разговор «только по слову-активатору», имена — «Джарвис» и «Джои».
# Разведка `researches/16` нашла у openWakeWord ГОТОВУЮ предобученную модель; проверка показала, что
# на деле она называется `hey_jarvis` — то есть обучена на фразе «hey jarvis», а не на голом имени.
# Этот стенд меряет, что из этого работает на РУССКОМ произношении.
#
# Почему отдельный venv (F:\KLAS\voice\venv-wakeword): ставить пакеты рядом с рабочими Silero и
# GigaAM — риск уронить голосовой тракт. Изоляция дешевле надежды.
#
# ⚠️ Честная граница (EXP-0016): речь СИНТЕЗИРОВАНА нашим ртом, а не записана с микрофона владельца.
# Положительный результат = зелёный свет живой проверке, отрицательный = достаточное основание не
# идти этим путём.
#
# Запуск: F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-probe.py
# [TESTED: 2026-07-29 · 0/10 верных на русском произношении при 0/3 ложных. Стенд доказан контролем:
#  «Alexa.» настоящей английской моделью Silero даёт alexa=1.000 и hey_jarvis=0.000, то есть формат
#  звука и кадровая подача верны, а нули на русском — свойство модели. «Hey Jarvis.» английским
#  синтезом = 0.259 (в 60 раз выше русского, но всё равно ниже порога 0.5)]

import os
import sys
import glob
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from openwakeword.model import Model

CLIPS_DIR = r"F:\KLAS\voice\out\kws"
TARGET_SR = 16000          # openWakeWord работает только на 16 кГц моно
THRESHOLD = 0.5            # штатный порог библиотеки; ниже него срабатывание не считается

# Ожидание по каждому файлу: True = слово ДОЛЖНО быть найдено. Имена файлов заданы стендом kws-probe
# и синтезом ниже; префикс pos_/neg_ несёт ожидание, чтобы фикстура не разъезжалась с проверкой.
def expected(name: str) -> bool:
    return os.path.basename(name).startswith("pos_")


def load_16k(path: str) -> np.ndarray:
    """Прочитать wav и привести к 16 кГц моно int16 — формат, который требует openWakeWord."""
    data, sr = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != TARGET_SR:
        g = np.gcd(int(sr), TARGET_SR)
        data = resample_poly(data, TARGET_SR // g, int(sr) // g)
    return (np.clip(data, -1.0, 1.0) * 32767).astype(np.int16)


def main() -> int:
    # Две модели сразу: `alexa` служит НЕЗАВИСИМЫМ контролем стенда. Детектор, который молчит на всём,
    # включая собственную обучающую фразу, — это скорее сломанный стенд, чем негодная модель
    # (BUG_FIXING: находка не находка, пока не проверена). Файлы `ctrl_*` синтезированы НАСТОЯЩЕЙ
    # английской моделью Silero v3_en — если стенд исправен, они обязаны зажечь свой детектор.
    model = Model(wakeword_models=["hey_jarvis", "alexa"], inference_framework="onnx")
    files = sorted(glob.glob(os.path.join(CLIPS_DIR, "*.wav")))
    if not files:
        print(f"нет wav в {CLIPS_DIR}", file=sys.stderr)
        return 2

    tp = fn = fp = tn = 0
    print(f"{'файл':<24} {'ожидание':<11} {'hey_jarvis':>10} {'alexa':>7}  вердикт")
    for f in files:
        audio = load_16k(f)
        model.reset()
        best = {}
        # Кормим кадрами по 1280 сэмплов (80 мс) — так библиотека работает с живым потоком,
        # значит и мерить надо так же, иначе замер не про боевой режим.
        for i in range(0, len(audio) - 1280, 1280):
            for k, v in model.predict(audio[i:i + 1280]).items():
                best[k] = max(best.get(k, 0.0), v)
        bj = best.get("hey_jarvis", 0.0)
        ba = best.get("alexa", 0.0)
        name = os.path.basename(f)
        if name.startswith("ctrl_"):
            # контрольные файлы не входят в счёт — они проверяют СТЕНД, а не гипотезу
            print(f"{name:<24} {'КОНТРОЛЬ':<11} {bj:>10.3f} {ba:>7.3f}  —")
            continue
        hit = bj >= THRESHOLD
        exp = expected(f)
        if exp:
            tp, fn = (tp + 1, fn) if hit else (tp, fn + 1)
        else:
            fp, tn = (fp + 1, tn) if hit else (fp, tn + 1)
        verdict = "ok" if hit == exp else ("ПРОПУСК" if exp else "ЛОЖНОЕ")
        label = "ждём слово" if exp else "слова нет"
        print(f"{name:<24} {label:<11} {bj:>10.3f} {ba:>7.3f}  {verdict}")

    print(f"\n=== ИТОГ === верных {tp}/{tp + fn} · ложных {fp}/{fp + tn} (порог {THRESHOLD})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
