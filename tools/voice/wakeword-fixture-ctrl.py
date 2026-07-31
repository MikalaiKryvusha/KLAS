# tools/voice/wakeword-fixture-ctrl.py — КОНТРОЛЬНЫЕ клипы для замера активатора (план 19, шаг 3).
#
# Зачем именно контроль. Детектор, молчащий на всех клипах, обычно означает СЛОМАННЫЙ СТЕНД, а не
# негодную модель. Отличить одно от другого можно только положительным контролем: клипом, который
# ОБЯЗАН зажечь свой детектор. Ровно этим в замере 2026-07-29 был доказан вердикт «0/10» для готовой
# `hey_jarvis`: рядом лежала «Alexa.», синтезированная НАСТОЯЩЕЙ английской моделью, и она дала
# alexa=1.000. Без неё ноль был бы неотличим от неверного формата звука (EXP-0027).
#
# ⛔ ПОЧЕМУ ЭТОТ ФАЙЛ ПОЯВИЛСЯ ТОЛЬКО СЕЙЧАС — и это дефект процесса, а не задачи.
# Контрольные клипы 2026-07-29 сделали РУКАМИ и не оставили генератора. Каталог `voice/out/kws`
# вне git; к 2026-08-01 он был вычищен — и вместе с ним исчезла возможность повторить замер.
# Правило харнесса («сделал руками — оставь скрипт») здесь нарушили, и цена ровно такая: замер,
# на который опирается канон проекта, стал невоспроизводимым.
#
# ⚠️ Честная граница: ДИКТОР контроля в записях 07-29 не зафиксирован. Здесь взят `en_23` — дефолт
# английского голоса проекта, выбранный измерением F0 (`bugs/11`). На счёт это не влияет: контроль
# в подсчёт верных и ложных не входит, он проверяет исправность СТЕНДА.
#
# Запуск: F:\KLAS\voice\venv\Scripts\python.exe tools/voice/wakeword-fixture-ctrl.py [каталог]
#
# [NOT-TESTED] — родился 2026-08-01.

import sys
import wave
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).parent))
from silero_say import MODELS_DIR, SAMPLE_RATE  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="strict")

OUT_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else r"F:\KLAS\voice\out\kws")
SPEAKER = "en_23"          # дефолт английского голоса проекта (bugs/11, выбран по F0)

# Два контроля с РАЗНЫМ назначением:
#   alexa      — обязан зажечь детектор `alexa` (доказывает, что стенд исправен);
#   hey_jarvis — англоязычный оригинал фразы, на которой обучена готовая модель. В замере 07-29 он
#                дал лишь 0.259 при пороге 0.5 — то есть модель, обученная на ЖИВОЙ речи, к синтезу
#                относится строже. Это важная поправка на мягкость синтетической фикстуры.
CASES = [
    ("ctrl_alexa_en", "Alexa."),
    ("ctrl_hey_jarvis_en", "Hey Jarvis."),
]


def main() -> int:
    path = MODELS_DIR / "v3_en.pt"
    if not path.exists():
        print(f"нет модели {path} — её качает silero_daemon.py при первом английском синтезе",
              file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    model = torch.package.PackageImporter(str(path)).load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))

    for name, text in CASES:
        audio = model.apply_tts(text=text, speaker=SPEAKER, sample_rate=SAMPLE_RATE)
        pcm = (audio.numpy() * 32767).astype("<i2")
        out = OUT_DIR / f"{name}.wav"
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(pcm.tobytes())
        print(f"  ✅ {out.name} — {len(pcm) / SAMPLE_RATE:.2f} с, диктор {SPEAKER}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
