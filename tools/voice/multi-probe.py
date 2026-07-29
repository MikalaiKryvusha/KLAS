#!/usr/bin/env python3
# tools/voice/multi-probe.py — ПРОВЕРКА ГОТОВОГО РЕШЕНИЯ: одна модель Silero на два языка.
#
# Вопрос владельца (2026-07-29): «неужели нет готового решения, модели, которая сразу два языка
# умеет? и нужно своё учить?» — законный, и проверить его надо ДО того, как вкладывать дни в
# обучение (Оккам: сначала готовое).
#
# Находка: у Silero есть `multi_v2` — ОДНА модель, чей алфавит содержит и кириллицу, и латиницу,
# а дикторы, по документации, говорят на всех языках. Это ровно та архитектура, к которой мы шли
# обучением: язык — внутреннее дело модели, а не точка склейки в рантайме.
#
# Что этот стенд обязан выяснить наблюдением, а не по документации:
#   1. ПРАВДА ЛИ один диктор произносит и русский, и английский (а не молчит на чужом алфавите);
#   2. НЕ ПРОСЕЛО ЛИ качество: `multi_v2` — поколение v2, а владелец одобрял голоса из v5_ru.
#      Поэтому рядом синтезируется та же фраза голосом из v5 — сравнение честное, на одном тексте.
#
# ⚠️ Ограничение, известное заранее: в `multi_v2` НЕТ `eugene` и `xenia` — двух голосов, которые
# владелец одобрил. Есть `aidar`, `baya`, `kseniya`, `irina`, `ruslan`, `natasha`.
#
# Запуск: F:\KLAS\voice\venv\Scripts\python.exe tools/voice/multi-probe.py
# [NOT-TESTED]

import sys
import time
import wave
from pathlib import Path

import torch

MODELS = Path(r"F:\KLAS\voice\models")
OUT = Path(r"F:\KLAS\voice\out\multi")
SR = 24000

# Тексты кастинга: смесь языков — главный вопрос; чистый русский — контроль качества тембра.
TEXTS = [
    ("смесь", "Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель."),
    ("русский", "Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам."),
]
MULTI_SPEAKERS = ["baya", "aidar", "ruslan", "kseniya"]


def write_wav(path: Path, audio, sr: int) -> float:
    pcm = (audio.clamp(-1.0, 1.0) * 32767).to(torch.int16).numpy().tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return len(audio) / sr


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    print("=== multi_v2: ОДНА модель, оба языка ===", file=sys.stderr)
    multi = torch.package.PackageImporter(str(MODELS / "v2_multi.pt")).load_pickle("tts_models", "model")
    multi.to(torch.device("cpu"))
    for spk in MULTI_SPEAKERS:
        for tag, text in TEXTS:
            t0 = time.perf_counter()
            try:
                audio = multi.apply_tts(texts=text, speakers=spk, sample_rate=SR)
            except Exception as e:
                print(f"multi/{spk} {tag}: ОШИБКА {e}", file=sys.stderr)
                continue
            # apply_tts мультимодели возвращает список (по числу текстов) — берём первый
            if isinstance(audio, (list, tuple)):
                audio = audio[0]
            sec = write_wav(OUT / f"multi_{spk}_{tag}.wav", audio, SR)
            print(f"multi/{spk:8} {tag:8} {sec:5.2f} с звука за {time.perf_counter() - t0:5.2f} с", file=sys.stderr)

    print("=== v5_ru: контроль качества (одобренный владельцем тембр) ===", file=sys.stderr)
    v5 = torch.package.PackageImporter(str(MODELS / "v5_ru.pt")).load_pickle("tts_models", "model")
    v5.to(torch.device("cpu"))
    for spk in ["eugene", "baya"]:
        for tag, text in TEXTS:
            t0 = time.perf_counter()
            try:
                audio = v5.apply_tts(text=text, speaker=spk, sample_rate=48000)
            except Exception as e:
                print(f"v5/{spk} {tag}: ОШИБКА {e}", file=sys.stderr)
                continue
            sec = write_wav(OUT / f"v5_{spk}_{tag}.wav", audio, 48000)
            print(f"v5/{spk:11} {tag:8} {sec:5.2f} с звука за {time.perf_counter() - t0:5.2f} с", file=sys.stderr)

    print(f"\nфайлы: {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
