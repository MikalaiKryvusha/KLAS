# tools/voice/pitch-check.py — ОХРАННИК ЕДИНСТВА ГОЛОСА (bugs/11).
#
# Зачем. Двуязычный рот собирает реплику из ДВУХ моделей (v5_ru + v3_en), то есть из двух разных
# дикторов. Пока диктор английской модели выбран неудачно, ассистент меняет голос посреди фразы —
# владелец услышал это как «русский мужской, а английское слово — женским британским». Ухом такое
# ловит только человек, поэтому здесь оно ловится ИЗМЕРЕНИЕМ: медианный F0 (частота основного тона)
# русского и английского отрезков должен лежать в одном регистре.
#
# Режимы:
#   python tools/voice/pitch-check.py            → ОХРАННИК: синтез смешанной фразы, F0 обеих
#                                                  половин, вердикт PASS/FAIL (код выхода 1 при FAIL)
#   python tools/voice/pitch-check.py --match    → ПОДБОР: замер всех 118 английских дикторов и
#                                                  ранжирование по близости к русскому голосу
#   ... --voice eugene --voice-en en_23          → какие голоса проверять/сравнивать
#
# [TESTED: 2026-07-29 · прогон на en_0 даёт FAIL (94 против 202 Гц), на en_23 — PASS]

import argparse
import json
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):        # тот же контракт кодировки, что у остальных сайдкаров (bugs/08)
    _s.reconfigure(encoding="utf-8", errors="strict")

import numpy as np
import torch

MODELS = Path(r"F:\KLAS\voice\models")
SR = 48000
F0_MIN, F0_MAX = 60, 300                   # покрывает и низкий мужской, и высокий женский голос
# Порог единства регистра. 25% — заведомо шире естественного разброса диктора (±10%) и заведомо уже
# разрыва мужской/женский (94 против 202 Гц = 116%), поэтому не даёт ни ложных тревог, ни пропусков.
REGISTER_TOLERANCE = 0.25
RU_PHRASE = "Привет, Николай. Это проверка голоса ассистента."
EN_PHRASE = "Hello Nikolay. This is a voice check for the assistant."


def f0_median(x: np.ndarray, sr: int = SR) -> float:
    """Медианный F0 по автокорреляции, только по ОЗВОНЧЕННЫМ кадрам: тишина и шипящие дали бы
    случайные значения и размыли бы медиану."""
    frame, hop = int(0.04 * sr), int(0.02 * sr)
    lo, hi = sr // F0_MAX, sr // F0_MIN
    vals = []
    energy = np.sqrt(np.mean(x ** 2)) if len(x) else 0.0
    for i in range(0, max(0, len(x) - frame), hop):
        f = x[i:i + frame].astype(np.float64)
        if np.sqrt(np.mean(f ** 2)) < 0.25 * energy:
            continue
        f = f - f.mean()
        ac = np.correlate(f, f, mode="full")[len(f) - 1:]
        if ac[0] <= 0:
            continue
        seg = ac[lo:hi]
        if not len(seg):
            continue
        peak = int(np.argmax(seg)) + lo
        if ac[peak] / ac[0] < 0.3:          # слабая периодичность — это не тон
            continue
        vals.append(sr / peak)
    return float(np.median(vals)) if vals else float("nan")


def centroid(x: np.ndarray, sr: int = SR) -> float:
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    return float((spec * freqs).sum() / spec.sum()) if spec.sum() else float("nan")


def load(name):
    return torch.package.PackageImporter(MODELS / f"{name}.pt").load_pickle("tts_models", "model")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", action="store_true", help="перебрать всех английских дикторов и ранжировать")
    ap.add_argument("--voice", default="eugene")
    ap.add_argument("--voice-en", default="en_23")
    a = ap.parse_args()

    torch.set_num_threads(4)
    ru, en = load("v5_ru"), load("v3_en")

    ref = ru.apply_tts(text=RU_PHRASE, speaker=a.voice, sample_rate=SR).numpy()
    ref_f0, ref_sc = f0_median(ref), centroid(ref)
    print(f"русский голос {a.voice}: F0 = {ref_f0:.1f} Гц · центроид = {ref_sc:.0f} Гц")

    if a.match:
        rows = []
        for i in range(118):
            spk = f"en_{i}"
            try:
                x = en.apply_tts(text=EN_PHRASE, speaker=spk, sample_rate=SR).numpy()
            except Exception as e:  # noqa: BLE001 — один плохой диктор не роняет перебор
                print(f"  {spk}: ошибка {e}")
                continue
            f0, sc = f0_median(x), centroid(x)
            if np.isnan(f0):
                continue
            # Обе оси нормируем по эталону, иначе шкала центроида (тысячи Гц) перевесит F0 (десятки)
            rows.append({"speaker": spk, "f0": round(f0, 1), "sc": round(sc),
                         "dist": round(abs(f0 - ref_f0) / ref_f0 + 0.5 * abs(sc - ref_sc) / ref_sc, 4)})
        rows.sort(key=lambda r: r["dist"])
        print("\nближайшие к русскому голосу:")
        for r in rows[:10]:
            print(f'  {r["speaker"]:>7}  F0={r["f0"]:>6} Гц  центроид={r["sc"]:>5}  расстояние={r["dist"]}')
        print(json.dumps(rows[:10], ensure_ascii=False))
        return

    x = en.apply_tts(text=EN_PHRASE, speaker=a.voice_en, sample_rate=SR).numpy()
    f0, sc = f0_median(x), centroid(x)
    drift = abs(f0 - ref_f0) / ref_f0
    ok = drift <= REGISTER_TOLERANCE
    print(f"английский голос {a.voice_en}: F0 = {f0:.1f} Гц · центроид = {sc:.0f} Гц")
    print(f"расхождение регистра: {drift * 100:.1f}% (порог {REGISTER_TOLERANCE * 100:.0f}%)")
    print("PASS — голос единый" if ok else
          "FAIL — голос МЕНЯЕТСЯ посреди реплики: подбери диктора «--match» (bugs/11)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
