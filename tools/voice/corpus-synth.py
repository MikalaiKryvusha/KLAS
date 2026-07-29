#!/usr/bin/env python3
# tools/voice/corpus-synth.py — озвучить текстовый корпус эталонным тембром (план 15, этап 1).
#
# Зачем. Гейт переноса спрашивает: сохраняется ли качество голоса при обучении копии? Чтобы это
# проверить, нужен датасет «текст → звук», где звук произнесён ИМЕННО тем голосом, который владелец
# одобрил (`eugene`, вердикт кастинга 2026-07-29: «хорошо, нравится»).
#
# Почему напрямую через Silero, а не через наш резидентный сайдкар:
#   * нужна частота 24 кГц (Silero умеет 8/24/48) — это годная частота для обучения VITS, и она
#     избавляет от пересэмплирования 3000 файлов;
#   * не нужны нормализация чисел и разрезание по алфавиту — корпус уже чисто русский и без цифр
#     (об этом позаботился corpus-from-zim.py), а лишние преобразования здесь только внесли бы
#     расхождение текста и звука;
#   * модель грузится ОДИН раз, протокол JSON не нужен.
#
# На выходе — раскладка LJSpeech (её понимают все обучалки VITS/Piper):
#   dataset/wavs/000001.wav …   dataset/metadata.csv строки «000001|текст|текст»
#
# Запуск (Windows, venv голосового тракта):
#   F:\KLAS\voice\venv\Scripts\python.exe tools/voice/corpus-synth.py \
#       --texts F:\KLAS\voice\dataset\sentences.txt --out F:\KLAS\voice\dataset
# [NOT-TESTED]

import argparse
import sys
import time
import wave
from pathlib import Path

import torch

MODEL = Path(r"F:\KLAS\voice\models\v5_ru.pt")
SAMPLE_RATE = 24000          # Silero поддерживает 8000/24000/48000; 24 кГц — рабочая частота для VITS


def write_wav(path: Path, audio, sr: int) -> float:
    """Записать моно-PCM16. Возвращает длительность в секундах."""
    pcm = (audio.clamp(-1.0, 1.0) * 32767).to(torch.int16).numpy().tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return len(audio) / sr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--texts", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="eugene", help="одобренный владельцем тембр")
    ap.add_argument("--limit", type=int, default=0, help="0 = весь корпус (для пробного прогона поставь 20)")
    a = ap.parse_args()

    out = Path(a.out)
    wavs = out / "wavs"
    wavs.mkdir(parents=True, exist_ok=True)

    lines = [s.strip() for s in Path(a.texts).read_text(encoding="utf-8").splitlines() if s.strip()]
    if a.limit:
        lines = lines[: a.limit]
    print(f"фраз к синтезу: {len(lines)} · голос: {a.voice} · частота: {SAMPLE_RATE}", file=sys.stderr)

    t0 = time.perf_counter()
    model = torch.package.PackageImporter(str(MODEL)).load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    print(f"модель загружена за {time.perf_counter() - t0:.1f} с", file=sys.stderr)

    meta = []
    total_audio = 0.0
    failed = 0
    t_start = time.perf_counter()
    for i, text in enumerate(lines, 1):
        name = f"{i:06d}"
        try:
            audio = model.apply_tts(text=text, speaker=a.voice, sample_rate=SAMPLE_RATE)
        except Exception as e:
            # Пропускаем фразу, но НЕ молча: тихий пропуск исказил бы соответствие текст↔звук,
            # а именно его и должен сохранить датасет.
            failed += 1
            print(f"[{name}] пропуск: {e}", file=sys.stderr)
            continue
        total_audio += write_wav(wavs / f"{name}.wav", audio, SAMPLE_RATE)
        meta.append(f"{name}|{text}|{text}")
        if i % 250 == 0:
            el = time.perf_counter() - t_start
            print(f"  {i}/{len(lines)} · {el:.0f} с · звука {total_audio / 60:.1f} мин", file=sys.stderr)

    (out / "metadata.csv").write_text("\n".join(meta) + "\n", encoding="utf-8")
    el = time.perf_counter() - t_start
    print(
        f"готово: {len(meta)} файлов, пропущено {failed}, звука {total_audio / 60:.1f} мин, "
        f"синтез {el:.0f} с (RTF {el / max(total_audio, 1):.3f}) → {out}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
