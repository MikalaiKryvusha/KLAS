# tools/voice/wake-talk-fixture.py — ФИКСТУРА «имя + вопрос» для сквозной проверки шага 5 плана 19.
#
# Зачем. Диспетчер `tools/voice-wake.mjs` можно проверить целиком БЕЗ человека и БЕЗ микрофона:
# подать ему один wav, в котором сначала звучит имя, потом вопрос, — и посмотреть, услышал ли он имя,
# ту ли выбрал персону, где отрезал конец фразы и что расслышали уши. Это тот же код, что в бою:
# слушатель читает файл ровно теми же кадрами по 80 мс.
#
# ⛔ Почему это СКРИПТ, а не собранный руками файл. План 19 уже оплатил этот урок: контрольные клипы
# прошлого замера сделали руками и не оставили генератора — фикстура протухла, и замер, на который
# опирался канон, стало нельзя повторить. Здесь фикстура ВОСПРОИЗВОДИМА: клип имени берётся из
# корпуса детерминированно (сортировка + фиксированный индекс), вопрос синтезируется ртом проекта.
#
# Тексты вопросов живут ЗДЕСЬ, в файле, а не в аргументах командной строки: кириллица через argv на
# Windows — запрещённая практика (AGENT_GUIDE, пункт 13a).
#
# Запуск: F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wake-talk-fixture.py [--detector joy]
# Результат: F:\KLAS\voice\out\fixture-wake-<detector>.wav + напечатанный ожидаемый текст вопроса.
#
# [TESTED: 2026-08-01 · обе фикстуры собраны, детектор зажигается на своей и молчит на чужой]

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
OUT_DIR = r"F:\KLAS\voice\out"
SAY = r"F:\KLAS\tools\voice-say.mjs"
SR = 16000

# Вопрос на каждую персону. Короткий, с однозначным ответом — проверяется ТРАКТ, а не эрудиция ядра.
QUESTIONS = {
    "jarvis": "Сколько будет два плюс два?",
    "joy": "Как называется столица Беларуси?",
}
WORD = {"jarvis": "Джарвис", "joy": "Джой"}

LEAD_SEC = 2.5      # тишина до имени: окно детектора 2.0 с должно успеть наполниться
GAP_SEC = 0.4       # пауза между именем и вопросом — как в живой речи
TAIL_SEC = 1.5      # тишина после вопроса: слушателю нужно 0.9 с, чтобы объявить конец фразы


def to_16k_mono(path):
    d, sr = sf.read(path, dtype="float32")
    if d.ndim > 1:
        d = d.mean(axis=1)
    if sr != SR:
        from scipy.signal import resample_poly
        g = np.gcd(int(sr), SR)
        d = resample_poly(d, SR // g, int(sr) // g)
    return np.clip(d, -1, 1).astype(np.float32)


def pick_name_clip(slug):
    """Клип имени из корпуса — детерминированно: слово должно ЗАКАНЧИВАТЬ фразу (иначе модель его
    не учила, план 19 шаг 3), список сортируется, берётся середина."""
    man = os.path.join(CORPUS, slug, "manifest.clean.json")
    m = json.load(open(man, encoding="utf-8"))
    w = WORD[slug]
    good = sorted(c["file"] for c in m["clips"]
                  if c["file"].startswith("positive/")
                  and c["text"].strip().rstrip(".!?").endswith(w))
    if not good:
        raise SystemExit(f"в корпусе {slug} нет клипов, где «{w}» заканчивает фразу")
    return os.path.join(CORPUS, slug, good[len(good) // 2])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--detector", default="jarvis", choices=sorted(QUESTIONS))
    ap.add_argument("--voice", default="baya", help="диктор синтеза ВОПРОСА (не голос персоны)")
    # Два обращения подряд в одном файле: проверяет СМЕНУ ПЕРСОНЫ и то, что второе обращение,
    # пришедшее пока идёт первый ход, обрабатывается по очереди, а не наперегонки.
    ap.add_argument("--both", action="store_true", help="склеить обе фикстуры: Джарвис, затем Джой")
    a = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    if a.both:
        parts = []
        for slug in ("jarvis", "joy"):
            p = os.path.join(OUT_DIR, f"fixture-wake-{slug}.wav")
            if not os.path.exists(p):
                raise SystemExit(f"сначала собери {p} (запуск без --both)")
            parts.append(to_16k_mono(p))
        out = os.path.join(OUT_DIR, "fixture-wake-both.wav")
        sf.write(out, np.concatenate(parts), SR, subtype="PCM_16")
        print(out)
        print(f"  Джарвис, затем Джой · всего {sum(len(p) for p in parts)/SR:.2f} с")
        return 0

    q_text = QUESTIONS[a.detector]
    q_wav = os.path.join(OUT_DIR, f"fixture-question-{a.detector}.wav")
    # ⛔ БЕЗ shell=True. С ним Windows завернул бы вызов в `cmd /c`, и текст вопроса поехал бы в
    # ЯДРО через консольную кодировку — ровно запрещённая практика «кириллица через аргументы»
    # (AGENT_GUIDE §9). Прямой CreateProcessW отдаёт argv как UTF-16 и ничего не портит; поэтому же
    # node ищется явно, а не надеждой на разрешение имени без расширения.
    node = shutil.which("node")
    if not node:
        raise SystemExit("node не найден в PATH")
    r = subprocess.run([node, SAY, q_text, "--out", q_wav, "--voice", a.voice], capture_output=True)
    if r.returncode != 0 or not os.path.exists(q_wav):
        print(r.stderr.decode("utf-8", "replace")[-400:], file=sys.stderr)
        raise SystemExit("рот не синтезировал вопрос")

    name = to_16k_mono(pick_name_clip(a.detector))
    question = to_16k_mono(q_wav)
    fixture = np.concatenate([
        np.zeros(int(LEAD_SEC * SR), dtype=np.float32),
        name,
        np.zeros(int(GAP_SEC * SR), dtype=np.float32),
        question,
        np.zeros(int(TAIL_SEC * SR), dtype=np.float32),
    ])
    out = os.path.join(OUT_DIR, f"fixture-wake-{a.detector}.wav")
    sf.write(out, fixture, SR, subtype="PCM_16")
    os.remove(q_wav)

    print(out)
    print(f"  имя: «{WORD[a.detector]}» ({len(name)/SR:.2f} с) · вопрос: «{q_text}» ({len(question)/SR:.2f} с)")
    print(f"  всего {len(fixture)/SR:.2f} с")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
