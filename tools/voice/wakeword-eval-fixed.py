# tools/voice/wakeword-eval-fixed.py — оценка активатора на НЕИЗМЕННОМ наборе (план 19, шаг 3).
#
# ⛔ ЗАЧЕМ ТРЕТИЙ СТЕНД. Два предыдущих оказались негодны, и оба по одной причине — ЛИНЕЙКА ДВИГАЛАСЬ.
#
#   `wakeword-compare.py`  — меряет потоком. Три прогона одной модели на одном клипе дали
#                            0.52 / 0.052 / 0.084: клипы короче окна детектора, и результат зависит
#                            от наполнения буфера. Показания недостоверны.
#   `wakeword-eval-holdout.py` — меряет на отложенных ФИЧАХ. Честнее, но фичи ПЕРЕСЧИТЫВАЮТСЯ при
#                            каждом обучении, а аугментация случайна (реверберация и шум). То есть
#                            каждое поколение судилось СВОИМ набором, и сравнение поколений между
#                            собой оказалось бессмысленным: у трёх старых моделей ложные скакнули до
#                            100% просто потому, что набор стал другим.
#
# Здесь линейка закреплена по построению:
#   · окна строятся из ИСХОДНЫХ wav корпуса, а не из аугментированных фич;
#   · выравнивание ДЕТЕРМИНИРОВАНО — слово по правому краю окна, как учит `create_fixed_size_clip`,
#     но БЕЗ его случайного джиттера;
#   · никакой аугментации: сравниваются модели, а не реализации случайного шума;
#   · выбор клипов — равномерным шагом по отсортированному списку, то есть воспроизводим.
# Один и тот же набор для всех поколений, сегодня и через месяц.
#
# ⚠️ Что этот стенд НЕ измеряет: устойчивость к шуму и реверберации (аугментации здесь нет) и
# поведение в живом потоке. Он отвечает на один вопрос — научилась ли модель отличать своё слово от
# чужого и от ловушек в том виде, в каком её обучали. Живой микрофон владельца не заменяет ничто.
#
# Запуск: F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-eval-fixed.py
#
# [NOT-TESTED] — родился 2026-08-01.

import json
import os
import sys

import numpy as np
import onnxruntime as ort
import soundfile as sf

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

from openwakeword.utils import AudioFeatures  # noqa: E402

CORPUS_ROOT = r"F:\KLAS\voice\wakeword\corpus"
TRAINED_DIR = r"F:\KLAS\voice\wakeword\training"
SR = 16000
WINDOW = 32000        # 2.0 с — окно детектора, задано формой скачанных негативов
THRESHOLD = 0.5
SAMPLE_N = 300        # сколько клипов каждого рода брать: хватает для процентов, быстро считается

FEATS = AudioFeatures(device="cpu")


def right_aligned_window(path: str) -> np.ndarray:
    """Окно с клипом, прижатым к ПРАВОМУ краю — ровно так учит create_fixed_size_clip, но без его
    случайного джиттера. Клип длиннее окна берётся ПОСЛЕДНИМИ 2 с (там и стоит слово, если оно
    завершает фразу)."""
    d, sr = sf.read(path, dtype="float32")
    if d.ndim > 1:
        d = d.mean(axis=1)
    if sr != SR:
        from scipy.signal import resample_poly
        g = np.gcd(int(sr), SR)
        d = resample_poly(d, SR // g, int(sr) // g)
    x = (np.clip(d, -1, 1) * 32767).astype(np.int16)
    out = np.zeros(WINDOW, dtype=np.int16)
    if len(x) >= WINDOW:
        out[:] = x[-WINDOW:]
    else:
        out[WINDOW - len(x):] = x
    return out


def pick(items, n):
    """Равномерный шаг по отсортированному списку: имя файла кодирует диктора, темп, обрамление и
    повтор, поэтому шаг сохраняет разнообразие, а «первые N» дали бы один голос на одном темпе."""
    if len(items) <= n:
        return items
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


def embed_all(paths):
    return np.stack([FEATS.embed_clips(right_aligned_window(p)[None, :], batch_size=1)[0]
                     for p in paths])


def score(model_path, feats):
    s = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    nm = s.get_inputs()[0].name
    return np.array([float(s.run(None, {nm: feats[i:i + 1].astype(np.float32)})[0].ravel()[0])
                     for i in range(len(feats))])


def build_set(slug, other_slug, word):
    """Три рода клипов, и каждый отвечает на свой вопрос:
       СВОИ положительные   — узнаёт ли модель имя (полнота);
       ловушки и обычная речь — молчит ли она на постороннем;
       клипы ЧУЖОГО имени   — не путает ли две персоны (это хуже пропуска)."""
    m = json.load(open(os.path.join(CORPUS_ROOT, slug, "manifest.clean.json"), encoding="utf-8"))
    ends_with_word = lambda t: not any(  # noqa: E731
        ch.isalnum() for ch in t[t.rfind(word) + len(word):]) if word in t else False

    pos = sorted([c["file"] for c in m["clips"]
                  if c["file"].startswith("positive/") and ends_with_word(c["text"])])
    neg = sorted([c["file"] for c in m["clips"] if c["file"].startswith("negative/")])

    mo = json.load(open(os.path.join(CORPUS_ROOT, other_slug, "manifest.clean.json"), encoding="utf-8"))
    cross = sorted([c["file"] for c in mo["clips"] if c["file"].startswith("positive/")])

    root = os.path.join(CORPUS_ROOT, slug)
    root_o = os.path.join(CORPUS_ROOT, other_slug)
    return (
        [os.path.join(root, f) for f in pick(pos, SAMPLE_N)],
        [os.path.join(root, f) for f in pick(neg, SAMPLE_N)],
        [os.path.join(root_o, f) for f in pick(cross, SAMPLE_N)],
    )


def main() -> int:
    plan = [
        ("jarvis", "joy", "Джарвис", ["jarvis", "jarvis_v3_short", "jarvis_v2_cross", "jarvis_v1_baseline"]),
        ("joy", "jarvis", "Джой", ["joy"]),
    ]
    for slug, other, word, models in plan:
        pos_p, neg_p, cross_p = build_set(slug, other, word)
        print(f"\n=== «{word}» · НЕИЗМЕННЫЙ набор: {len(pos_p)} своих · {len(neg_p)} ловушек и речи · "
              f"{len(cross_p)} клипов чужого имени ===")
        fp_, fn_, fc_ = embed_all(pos_p), embed_all(neg_p), embed_all(cross_p)

        print(f"{'модель':<22}{'полнота':>9}{'ложных':>9}{'на чужом имени':>17}")
        print("-" * 60)
        for name in models:
            mp = os.path.join(TRAINED_DIR, f"{name}.onnx")
            if not os.path.exists(mp):
                print(f"{name:<22}   — нет файла, пропуск")
                continue
            sp, sn, sc = score(mp, fp_), score(mp, fn_), score(mp, fc_)
            print(f"{name:<22}{(sp >= THRESHOLD).mean() * 100:>8.1f}%"
                  f"{(sn >= THRESHOLD).mean() * 100:>8.1f}%{(sc >= THRESHOLD).mean() * 100:>16.1f}%")
        print(f"(порог {THRESHOLD}; выравнивание по правому краю окна, без аугментации)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
