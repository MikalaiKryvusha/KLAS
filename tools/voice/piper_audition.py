# -*- coding: utf-8 -*-
"""
Экспорт обученного голоса Piper в ONNX и озвучка пяти текстов кастинга — на выслушку владельцу.

Зачем отдельный скрипт
----------------------
Обучение даёт `.ckpt`, которым говорить нельзя: в разговоре должен крутиться маленький `.onnx`
на CPU (архитектура владельца из `ideas/05_Jarvis.md` — «тяжёлое один раз офлайн, лёгкое каждый
раз»). Между «обучилось» и «услышал» стоят четыре обязательных шага, и каждый уже стоил нам
времени, если его пропустить:

  1. ЭКСПОРТ `.ckpt` → `.onnx` (штатный `piper.train.export_onnx`) + рядом `.onnx.json` —
     без конфига голос не грузится вовсе.
  2. НОРМАЛИЗАЦИЯ ТЕКСТА через общий слой `text_norm` в режиме `full`. Piper фонемизирует
     espeak-ng голосом `ru`: английских фонем в нём нет, цифры он читает как придётся.
     Режим — свойство ДВИЖКА, а не текста (`AGENT_GUIDE.md` → `text_norm.py`).
  3. СКЛЕЙКА пяти текстов в ОДИН файл: владелец сказал дословно — «по одному файлу на выслушку
     по варианту · клей кусочки воедино, кусочки удаляй · папки делай по кандидатам».
  4. ВЫРАВНИВАНИЕ ГРОМКОСТИ до −14 LUFS (делается отдельно, `tools/voice/normalize-loudness.mjs`):
     при разных уровнях человек на прослушивании сравнивает громкость, а не голос.

Тексты кастинга ЗАФИКСИРОВАНЫ (`homeworks/03`) — менять нельзя, иначе сравниваются тексты,
а не голоса.

Использование (из WSL):
    /opt/piper1-gpl/.venv/bin/python /mnt/f/KLAS/tools/voice/piper_audition.py \
        [--ckpt <путь>] [--name vihrov]

[NOT-TESTED] — маркер снимается после прогона, давшего слышимый голос.
"""
import argparse
import pathlib
import subprocess
import sys
import wave

sys.path.insert(0, "/mnt/f/KLAS/tools/voice")
from text_norm import normalize  # noqa: E402

# Тексты кастинга — те же пять, что у всех прежних кандидатов (homeworks/03).
TEXTS = [
    ("1-подпись", "Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам."),
    ("2-имена",   "Ядро Qwen три и шесть отвечает через llama.cpp, чат Open WebUI поднят, а база знаний Kiwix содержит русскую Википедию."),
    ("3-цифры",   "Видеокарта RTX 5070 Ti заняла 11.4 ГБ из 16, температура 62 °C, скорость 115 КБ/с, до встречи осталось 15 минут."),
    ("4-код",     "Выполните команду git commit -m \"fix voice\", затем npm run build. Функция f(x) = 2x при x от 1 до 5 вернёт 10."),
    ("5-смесь",   "Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель, а результат сохраняется в файл model.onnx."),
]

PAUSE_S = 0.6   # тишина между текстами: владельцу должно быть слышно, где кончается один и начался другой

p = argparse.ArgumentParser()
p.add_argument("--name", default="vihrov")
p.add_argument("--train-dir", default=None)
p.add_argument("--ckpt", default=None, help="по умолчанию last.ckpt самой свежей версии обучения")
p.add_argument("--out", default=None)
args = p.parse_args()

train_dir = pathlib.Path(args.train_dir or f"/opt/piper_train/{args.name}")
out_dir = pathlib.Path(args.out or f"/mnt/f/KLAS/voice/out/piper_{args.name}")
out_dir.mkdir(parents=True, exist_ok=True)

# --- чекпойнт -------------------------------------------------------------------------------
if args.ckpt:
    ckpt = pathlib.Path(args.ckpt)
else:
    cands = sorted(train_dir.glob("lightning_logs/*/checkpoints/last.ckpt"),
                   key=lambda p: p.stat().st_mtime)
    if not cands:
        sys.exit(f"⛔ не найден last.ckpt в {train_dir}/lightning_logs/*/checkpoints/")
    ckpt = cands[-1]
print(f"=== чекпойнт: {ckpt}", flush=True)

onnx = out_dir / f"{args.name}.onnx"
cfg_src = train_dir / "config.json"
cfg_dst = out_dir / f"{args.name}.onnx.json"

# --- 1. экспорт -----------------------------------------------------------------------------
print("=== экспорт в ONNX...", flush=True)
r = subprocess.run([sys.executable, "-m", "piper.train.export_onnx",
                    "--checkpoint", str(ckpt), "--output-file", str(onnx)])
if r.returncode != 0:
    sys.exit(f"⛔ экспорт не удался (код {r.returncode})")
if not cfg_src.exists():
    sys.exit(f"⛔ нет конфига голоса {cfg_src} — без него .onnx не загрузится")
cfg_dst.write_bytes(cfg_src.read_bytes())
print(f"=== {onnx.name} {onnx.stat().st_size/1e6:.1f} МБ · конфиг рядом", flush=True)

# --- 2–3. синтез и склейка ------------------------------------------------------------------
from piper import PiperVoice  # noqa: E402  (импорт после экспорта: он тяжёлый)

voice = PiperVoice.load(str(onnx), config_path=str(cfg_dst))
parts_dir = out_dir / "parts"
parts_dir.mkdir(exist_ok=True)

part_files = []
for tag, raw in TEXTS:
    # translit='full': Piper фонемизирует голосом espeak-ng `ru`, английских фонем в нём НЕТ
    spoken = normalize(raw, translit="full")
    wav_path = parts_dir / f"{tag}.wav"
    with wave.open(str(wav_path), "wb") as wf:
        voice.synthesize_wav(spoken, wf)
    with wave.open(str(wav_path)) as wf:
        secs = wf.getnframes() / wf.getframerate()
    print(f"  {tag:10s} {secs:5.2f} с · {spoken[:70]}", flush=True)
    part_files.append(wav_path)

silence = parts_dir / "_pause.wav"
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                "-i", f"anullsrc=r={voice.config.sample_rate}:cl=mono",
                "-t", str(PAUSE_S), "-y", str(silence)], check=True)

listing = parts_dir / "concat.txt"
with open(listing, "w", encoding="utf-8") as f:
    for i, wp in enumerate(part_files):
        if i:
            f.write(f"file '{silence.name}'\n")
        f.write(f"file '{wp.name}'\n")

glued = out_dir / f"piper_{args.name}.wav"
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "concat",
                "-safe", "0", "-i", str(listing), "-y", str(glued)], check=True)

# «кусочки удаляй» — прямое указание владельца о форме выдачи
for wp in part_files + [silence, listing]:
    wp.unlink(missing_ok=True)
parts_dir.rmdir()

with wave.open(str(glued)) as wf:
    total = wf.getnframes() / wf.getframerate()
print(f"\nГОТОВО: {glued}  ({total:.1f} с)")
print("Дальше — выровнять громкость и положить к кандидатам:")
print(f"  node tools/voice/normalize-loudness.mjs {glued.as_posix().replace('/mnt/f', 'F:')} "
      f"--out F:\\KLAS\\voice\\out\\candidates\\JARVIS --lufs -14")
