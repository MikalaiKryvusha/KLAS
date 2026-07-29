# -*- coding: utf-8 -*-
"""
Медианный F0 произвольного wav — объективная ось «ниже/выше» для навигации по кастингу.

Зачем отдельно от `pitch-check.py`: тот меряет ТОЛЬКО синтез Silero (сам его и порождает),
а нам нужно мерить ЧУЖИЕ файлы — записи живых дикторов.

⚠️ Граница, названная заранее (EXP-0030): **герцы меряют регистр, а не красоту.** Этот
инструмент помогает владельцу быстро найти в списке мужские и женские голоса, и НЕ УЧАСТВУЕТ
в выборе тембра — выбор за владельцем.

⚠️⚠️ **ВТОРАЯ ГРАНИЦА, найденная замером 2026-07-29 — УДВОЕНИЕ ОКТАВЫ НА СЖАТОМ ЗВУКЕ.**
[TESTED: 2026-07-29 · контроль на известных голосах Silero — eugene 97.0 (эталон 96),
baya 246.2 (246), kseniya 243.7 (245): инструмент ТОЧЕН на чистом 48 кГц]
Но на шести архивных аудиокнигах (старые mp3 низкого битрейта) все шесть дикторов дали
167–179 Гц — так не бывает. Причина: у сжатых записей срезан низ, основной тон слаб, и
автокорреляция цепляется за ВТОРУЮ ГАРМОНИКУ. Мужские 85 Гц читаются как 170.
**Вывод: на сжатом/полосно-ограниченном источнике вердикту «регистр» ВЕРИТЬ НЕЛЬЗЯ.**
Разметку по этим числам не делать; если она понадобится — сначала фильтр нижних частот
и проверка на контроле того же битрейта.

Метод — автокорреляция по окнам, без новых зависимостей (нужен только numpy).
Использование: python f0-of-wav.py <файл.wav> [...]
"""
import sys, wave, statistics
import numpy as np

FMIN, FMAX = 60, 400          # человеческий диапазон основного тона
WIN, HOP = 2048, 512


def f0_median(path: str):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    x /= (np.abs(x).max() or 1.0)

    lag_min, lag_max = int(sr / FMAX), int(sr / FMIN)
    vals = []
    for start in range(0, len(x) - WIN, HOP):
        seg = x[start:start + WIN]
        if np.sqrt((seg ** 2).mean()) < 0.02:      # тишину не меряем
            continue
        seg = seg - seg.mean()
        ac = np.correlate(seg, seg, mode="full")[WIN - 1:]
        if ac[0] <= 0:
            continue
        ac /= ac[0]
        window = ac[lag_min:lag_max]
        if len(window) == 0:
            continue
        lag = int(np.argmax(window)) + lag_min
        # слабый пик = шум или шёпот, а не тон: такое окно не засчитываем
        if ac[lag] < 0.3:
            continue
        vals.append(sr / lag)
    if not vals:
        return None, 0
    return statistics.median(vals), len(vals)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for p in sys.argv[1:]:
        f0, n = f0_median(p)
        if f0 is None:
            print(f"{p}\tтона не найдено")
        else:
            register = "мужской" if f0 < 165 else "женский"
            print(f"{p}\tF0={f0:.1f} Гц\tокон={n}\tрегистр: {register}")
