# -*- coding: utf-8 -*-
"""
Стенд: ПОТЯНЕТ ЛИ ПРОЦЕССОР одобренный владельцем голос — и с каким запасом.

Зачем этот замер существует
---------------------------
Владелец выбрал голос JARVIS (`espeech_bystree.mp3`, движок ESpeech-TTS-1 RL-V2) и голос JOI
(F5-TTS_RUSSIAN). Претензий к звуку нет — есть претензия к РЕСУРСАМ: движку нужно 3 150 МБ VRAM,
а рядом с загруженной основной моделью свободно ~950 МБ. Обход через лёгкий Piper владелец
забраковал словом «отвратительно» (`plans/18`).

Но ВСЕ прежние замеры RTF (0.167–0.197) сняты **на GPU**. Сколько тот же движок стоит на
ПРОЦЕССОРЕ, не мерил никто, — а на CPU видеопамяти не нужно вовсе, и тогда противоречие
«качество против ресурсов» исчезает без всякой замены движка.

Что меряем
----------
  * RTF = время синтеза / длительность звука. **RTF < 1 = быстрее реального времени.**
  * время ХОЛОДНОГО СТАРТА (загрузка весов) — от него зависит, нужен ли резидентный демон;
  * пик RAM процесса;
  * то же на разных `nfe_step`. Это единственная настоящая ручка скорости у flow-matching:
    число шагов решателя. 32 — умолчание, меньше — быстрее и грубее.

⚠️ Гонять ТОЛЬКО на свободном процессоре. Рядом с обучением (6 воркеров загрузки данных) стенд
измерит конкуренцию за CPU, а не движок — тот же класс, что EXP-0033.

Использование (из WSL):
    CUDA_VISIBLE_DEVICES= /opt/f5ru/.venv/bin/python tools/voice/tts-cpu-bench.py [--nfe 32,16,8]

[NOT-TESTED] — маркер снимается после первого прогона с числами.
"""
import argparse
import os
import resource
import sys
import time

# ⛔ ДО импорта torch: прячем видеокарту, иначе движок молча уйдёт на GPU и замерит не то.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

import soundfile as sf  # noqa: E402
import torch  # noqa: E402

sys.path.insert(0, "/mnt/f/KLAS/tools/voice")
from text_norm import normalize  # noqa: E402
from ref_pair import check_ref_pair  # noqa: E402

from f5_tts.infer.utils_infer import (  # noqa: E402
    infer_process, load_model, load_vocoder, preprocess_ref_audio_text,
)
from f5_tts.model import DiT  # noqa: E402

SOURCES = "/mnt/f/KLAS/voice/sources"
p = argparse.ArgumentParser()
p.add_argument("--model", default="/opt/espeech/rl_v2/espeech_tts_rlv2.pt")
p.add_argument("--vocab", default="/opt/espeech/rl_v2/vocab.txt")
p.add_argument("--ref-wav", default=os.path.join(SOURCES, "jarvis_vihrov", "ref_vihrov_12s.wav"))
p.add_argument("--ref-txt", default=os.path.join(SOURCES, "jarvis_vihrov", "ref_vihrov_12s.txt"))
p.add_argument("--speed", type=float, default=1.06)      # канон владельца для JARVIS
p.add_argument("--nfe", default="32,16,8")
p.add_argument("--out", default="/mnt/f/KLAS/voice/out/cpu_bench")
args = p.parse_args()

# Одна КОРОТКАЯ реплика — типичный ход ассистента. Длинные тексты кастинга тут не нужны:
# нас интересует не качество (его судит владелец), а цена секунды речи.
PHRASE = "Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам."

print(f"=== устройство: {'CUDA ВИДНА — ЗАМЕР НЕВЕРЕН!' if torch.cuda.is_available() else 'CPU (видеокарта скрыта)'}")
print(f"=== потоков torch: {torch.get_num_threads()}   ядер: {os.cpu_count()}")

# ГЕЙТ: пара «эталонный звук ↔ его текст» проверяется ДО загрузки модели (bugs/16).
ref_text = open(args.ref_txt, encoding="utf-8").read().strip()
pair = check_ref_pair(args.ref_wav, ref_text, engine="f5")
print(f"=== эталон принят: {pair}")

t0 = time.time()
vocoder = load_vocoder()
model = load_model(DiT, dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4),
                   args.model, vocab_file=args.vocab)
cold = time.time() - t0
print(f"\n=== ХОЛОДНЫЙ СТАРТ (загрузка весов на CPU): {cold:.1f} с")

ref_proc, ref_text_proc = preprocess_ref_audio_text(args.ref_wav, ref_text)
spoken = normalize(PHRASE, translit="full")
os.makedirs(args.out, exist_ok=True)

print(f"\n=== фраза ({len(spoken)} симв.): {spoken}")
print(f"{'nfe':>5} | {'синтез, с':>10} | {'звук, с':>8} | {'RTF':>6} | вердикт")
print("-" * 62)
for nfe in [int(x) for x in args.nfe.split(",")]:
    t = time.time()
    wave, sr, _ = infer_process(ref_proc, ref_text_proc, spoken, model, vocoder,
                                cross_fade_duration=0.15, nfe_step=nfe, speed=args.speed)
    dt = time.time() - t
    audio_s = len(wave) / sr
    rtf = dt / audio_s
    sf.write(os.path.join(args.out, f"cpu_nfe{nfe}.wav"), wave, sr)
    verdict = "быстрее реального времени" if rtf < 1 else f"МЕДЛЕННЕЕ реального времени в {rtf:.1f}x"
    print(f"{nfe:>5} | {dt:>10.2f} | {audio_s:>8.2f} | {rtf:>6.2f} | {verdict}")

peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
print(f"\n=== пик RAM процесса: {peak_mb:.0f} МБ · VRAM: 0 (видеокарта не использовалась)")
print(f"=== файлы для прослушивания: {args.out}")
