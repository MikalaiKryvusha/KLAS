# tools/voice/wakeword-eval-holdout.py — ЧЕСТНАЯ оценка активатора на ОТЛОЖЕННЫХ данных (план 19).
#
# ⛔ ЗАЧЕМ ОТДЕЛЬНЫЙ СТЕНД, если уже есть `wakeword-compare.py`.
# Тот меряет ПОТОКОМ: кормит модель кадрами по 80 мс, как в живом микрофоне. Замер 2026-08-01
# показал, что в таком виде он НЕ ВОСПРОИЗВОДИМ — три прогона одной модели на одном клипе дали
# 0.52 / 0.052 / 0.084. Числа, снятые нестабильным прибором, не значат ничего, и вчерашние 4/4
# держались именно на них.
#
# Причина видна в том, КАК обучались клипы: `create_fixed_size_clip` (data.py) выравнивает слово по
# ПРАВОМУ краю двухсекундного окна с джиттером до 200 мс. То есть модель ждёт слово в конце окна, а
# наши испытательные клипы длиной 0.6–1.0 с короче самого окна — потоковый стенд оценивает почти
# пустой буфер, и результат зависит от его наполнения.
#
# Этот стенд убирает потоковую неопределённость целиком: он берёт УЖЕ ПОСЧИТАННЫЕ фичи отложенной
# выборки (`positive_features_test.npy` / `negative_features_test.npy`) — ровно тот формат, на
# котором модель обучалась, и ровно те клипы, которых она НЕ ВИДЕЛА. Одна матрица на входе, один
# проход, никакого состояния между вызовами ⇒ результат детерминирован по построению.
#
# ⚠️ Граница честности: это оценка КАЧЕСТВА МОДЕЛИ, а не поведения в живом потоке. Потоковый режим —
# отдельный вопрос, и он остаётся открытым (см. план 19, шаг 3). Ни то, ни другое не заменяет
# проверку живым микрофоном владельца (EXP-0016).
#
# Запуск: F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-eval-holdout.py
#
# [NOT-TESTED] — родился 2026-08-01.

import os
import sys

import numpy as np
import onnxruntime as ort

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

TRAINED_DIR = r"F:\KLAS\voice\wakeword\training"
THRESHOLD = 0.5

# модель → каталог с её отложенной выборкой
# Три поколения «Джарвиса» на ОДНОЙ отложенной выборке — чтобы эффект каждой правки был виден
# числом, а не рассказом. Выборка берётся из каталога обучения текущей версии, поэтому старые модели
# судятся ровно тем же материалом, что новая.
CASES = [
    ("jarvis", "jarvis"),               # v3: перекрёстные негативы + только короткие клипы
    ("jarvis_v2_cross", "jarvis"),      # v2: перекрёстные негативы, длинные клипы ещё внутри
    ("jarvis_v1_baseline", "jarvis"),   # v1: без перекрёстных негативов
    ("joy", "joy"),
]


def run(model_path: str, feats: np.ndarray) -> np.ndarray:
    """Прогон по одному примеру: экспортированная модель несёт ФИКСИРОВАННЫЙ вход [1, 16, 96],
    поэтому пачками её кормить нельзя (onnxruntime честно ругается на размерность)."""
    s = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    name = s.get_inputs()[0].name
    return np.array([
        float(s.run(None, {name: feats[i:i + 1].astype(np.float32)})[0].ravel()[0])
        for i in range(len(feats))
    ])


def main() -> int:
    print(f"{'модель':<22}{'выборка':<10}{'полнота':>9}{'ложных':>9}{'порог':>8}   разбор")
    print("-" * 86)
    for model_name, corpus in CASES:
        mp = os.path.join(TRAINED_DIR, f"{model_name}.onnx")
        pos_p = os.path.join(TRAINED_DIR, corpus, "positive_features_test.npy")
        neg_p = os.path.join(TRAINED_DIR, corpus, "negative_features_test.npy")
        if not (os.path.exists(mp) and os.path.exists(pos_p) and os.path.exists(neg_p)):
            print(f"{model_name:<22}{corpus:<10}  — нет модели или отложенной выборки, пропуск")
            continue

        pos, neg = np.load(pos_p), np.load(neg_p)
        sp, sn = run(mp, pos), run(mp, neg)

        recall = float((sp >= THRESHOLD).mean())
        fpr = float((sn >= THRESHOLD).mean())
        print(f"{model_name:<22}{corpus:<10}{recall * 100:>8.1f}%{fpr * 100:>8.1f}%{THRESHOLD:>8.2f}"
              f"   положительных {len(pos)}, отрицательных {len(neg)}")

        # Разделяются ли классы вообще — важнее любой одной точки порога. Если распределения
        # перекрываются, никакой порог не спасёт, и это надо видеть числом, а не догадываться.
        print(f"{'':<22}{'':<10}  положительные: медиана {np.median(sp):.3f}, "
              f"5-й перцентиль {np.percentile(sp, 5):.3f}")
        print(f"{'':<22}{'':<10}  отрицательные: медиана {np.median(sn):.3f}, "
              f"95-й перцентиль {np.percentile(sn, 95):.3f}")
        gap = float(np.percentile(sp, 5) - np.percentile(sn, 95))
        verdict = "✅ классы разделены" if gap > 0 else "⚠️ распределения ПЕРЕКРЫВАЮТСЯ — порогом не развести"
        print(f"{'':<22}{'':<10}  зазор между ними: {gap:+.3f}  {verdict}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
