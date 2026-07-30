# -*- coding: utf-8 -*-
"""
Клон голоса движком Qwen3-TTS-12Hz-1.7B (Apache-2.0, WER на русском 3.212 — ниже ElevenLabs 3.878).

Запускается ИЗ WSL, лежит в репозитории (см. шапку `clone_espeech.py` — там же про /opt).

    wsl -e /opt/voicetrain/.venv/bin/python /mnt/f/KLAS/tools/voice/clone_qwen.py

ДВА условия эталона в одном прогоне — потому что они отвечают на РАЗНЫЕ вопросы:

  `12s`  тот же эталон 11.77 с, что у ESpeech  → ЧЕСТНОЕ сравнение движков: различается
         только движок. Сравнивать движки на разных эталонах — сравнивать голоса, а не движки.
  `60s`  полная одобренная минута                → отвечает «а больше эталона помогает?».
         У Qwen обрезки нет (в `qwen_tts` не нашлось ни `max_ref`, ни клипа), минута идёт целиком.

Правило владельца «не скупимся: между 10 секундами и минутой берём длиннее» соблюдается там,
где движок это позволяет; там, где не позволяет (F5 с порогом 12 с), правило уступает контракту
движка, и это записано в `bugs/16`, а не решено молча.

Тексты кастинга ЗАФИКСИРОВАНЫ (`homeworks/03`) — менять нельзя.
"""
import os, re, sys, time, json
import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, "/mnt/f/KLAS/tools/voice")
from text_norm import normalize
from ref_pair import check_ref_pair
from qwen_tts import Qwen3TTSModel

OUT = os.environ.get("CLONE_OUT", "/mnt/f/KLAS/voice/out/clone")

# ── Настройки, появившиеся из отслушивания владельцем 2026-07-30 ──────────────────────────
#
# ВЫРАЗИТЕЛЬНОСТЬ. Вердикт по эталону 60 с: «слишком чопорный голос, паузы делает неестественные,
# балуется голосом… хочется чуть-чуть меньше выразительности». У Qwen нет ручки `speed`, зато
# просодия рождается СЭМПЛИРОВАНИЕМ: штатные значения `temperature=0.9`, `subtalker_temperature=0.9`
# (см. qwen3_tts_model.py:321-328). Ниже температура — ровнее интонация. Это ручка модели, а не
# пост-обработка: пост-обработку тона владелец уже забраковал («слышно искажение голоса машинерией»).
TEMPERATURE = float(os.environ.get("QWEN_TEMP", "0.9"))
#
# ПАУЗЫ МЕЖДУ ПРЕДЛОЖЕНИЯМИ. Вердикт: «не делает паузы между предложениями», «глотает окончания
# иногда». Причина в том, что мы отдавали движку ВСЮ реплику одним куском. Синтезируем по
# предложениям и склеиваем через тишину — заодно короткий кусок реже теряет окончание.
SENT_PAUSE_S = 0.35

BASE = "/opt/qwentts/base"          # 1.7B для клона голоса (model.safetensors 3.86 ГБ)
REFS_DIR = "/mnt/f/KLAS/voice/refs_vihrov"

# Без аргументов — два условия эталона для Jarvis (Вихров). С аргументами
# `<эталон> <текст> <имя>` — одно условие для ДРУГОГО голоса (Joi) тем же кодом:
# копия скрипта под каждый голос разъезжается с оригиналом при первой же правке.
argv = sys.argv[1:]
if len(argv) >= 3:
    CONDITIONS = [(argv[2], argv[0], argv[1])]
else:
    CONDITIONS = [
        ("12s", os.path.join(OUT, "ref_vihrov_12s.wav"), os.path.join(OUT, "ref_vihrov_12s.txt")),
        ("60s", os.path.join(REFS_DIR, "ref_3_52m14s.mp3"), os.path.join(REFS_DIR, "ref_3_52m14s.txt")),
    ]

TEXTS = [
    ("1-подпись", "Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам."),
    ("2-имена",   "Ядро Qwen три и шесть отвечает через llama.cpp, чат Open WebUI поднят, а база знаний Kiwix содержит русскую Википедию."),
    ("3-цифры",   "Видеокарта RTX 5070 Ti заняла 11.4 ГБ из 16, температура 62 °C, скорость 115 КБ/с, до встречи осталось 15 минут."),
    ("4-код",     "Выполните команду git commit -m \"fix voice\", затем npm run build. Функция f(x) = 2x при x от 1 до 5 вернёт 10."),
    ("5-смесь",   "Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель, а результат сохраняется в файл model.onnx."),
]

# Пересчёт ТОЛЬКО части текстов: `ONLY_TAGS=1-подпись,3-цифры`. Нужно потому, что правка словаря
# произношения задевает обычно один-два текста из пяти, а полный прогон Qwen идёт минуты — при
# живой работе с владельцем это разница между «через минуту» и «через двадцать».
# ⚠️ Тексты кастинга при этом НЕ меняются: фильтруется НАБОР, а не содержимое.
_only = [t.strip() for t in os.environ.get("ONLY_TAGS", "").split(",") if t.strip()]
if _only:
    TEXTS = [t for t in TEXTS if t[0] in _only]
    print(f"=== пересчитываю только: {[t[0] for t in TEXTS]} ===", flush=True)

# ГЕЙТ до загрузки модели. engine="qwen" — порог обрезки не проверяется (его у Qwen нет),
# но темп «символов в секунду» проверяется всё равно: он ловит текст от ДРУГОГО куска записи.
checked = []
for name, wav, txt in CONDITIONS:
    text = open(txt, encoding="utf-8").read().strip()
    # длительность mp3 stdlib-модуль wave не читает — меряем soundfile, он умеет оба формата
    dur = sf.info(wav).duration
    n = len(text)
    cps = n / dur
    print(f"=== эталон {name}: {dur:.2f} с, {n} символов, {cps:.1f} симв/с ===", flush=True)
    if wav.endswith(".wav"):
        checked.append((name, wav, text, check_ref_pair(wav, text, engine="qwen")))
    else:
        # тот же инвариант, что в check_ref_pair, для формата, который он не читает
        assert 8.0 <= cps <= 22.0, f"пара {name} не сходится: {cps:.1f} симв/с (bugs/16)"
        checked.append((name, wav, text, {"ref_audio_s": round(dur, 2), "ref_chars": n, "cps": round(cps, 1)}))

os.makedirs(OUT, exist_ok=True)
print("=== загружаю Qwen3-TTS 1.7B ===", flush=True)
m = Qwen3TTSModel.from_pretrained(BASE, device_map="cuda:0", dtype=torch.bfloat16)

def split_sentences(text: str):
    """
    Разбиение на предложения. `razdel` уже стоит в venv (русский сплиттер, знает сокращения);
    регулярка оставлена запасным путём, чтобы скрипт не падал, если пакета не окажется.
    """
    try:
        from razdel import sentenize
        parts = [s.text.strip() for s in sentenize(text)]
    except Exception:
        parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text)]
    return [p for p in parts if p]


report = []
for name, wav, text, pair in checked:
    print(f"\n########## ЭТАЛОН {name} ({pair}) · temp={TEMPERATURE} ##########", flush=True)
    for tag, raw in TEXTS:
        # 'abbrev': аббревиатуры и имена файлов правим, обычный английский оставляем — его
        # владелец назвал у Qwen «сильно лучше», транслитерация только добавила бы акцент.
        spoken = normalize(raw, translit="abbrev")
        sents = split_sentences(spoken)
        t0 = time.time()
        chunks, sr = [], None
        for s in sents:
            w, sr = m.generate_voice_clone(text=s, language="russian", ref_audio=wav,
                                           ref_text=text, temperature=TEMPERATURE,
                                           subtalker_temperature=TEMPERATURE)
            chunks.append(w[0])
        gap = np.zeros(int(sr * SENT_PAUSE_S), dtype=chunks[0].dtype)
        joined = chunks[0]
        for c in chunks[1:]:
            joined = np.concatenate([joined, gap, c])
        wavs = [joined]
        el = time.time() - t0
        print(f"  ({len(sents)} предложений)", flush=True)
        p = os.path.join(OUT, f"qwen{name}_{tag}.wav" if name.endswith("s") and name[0].isdigit()
                              else f"{name}_{tag}.wav")
        sf.write(p, wavs[0], sr)
        dur = len(wavs[0]) / sr
        print(f"[{tag}] {el:.2f} с / звук {dur:.2f} с / RTF {el/dur:.3f}", flush=True)
        report.append({"engine": f"qwen-{name}", "tag": tag, "spoken": spoken, "file": p,
                       "ref": pair, "synth_s": round(el, 3), "audio_s": round(dur, 3),
                       "rtf": round(el / dur, 4)})

with open(os.path.join(OUT, f"report_qwen_{CONDITIONS[0][0]}.json"), "w", encoding="utf-8") as f:
    json.dump({"items": report,
               "vram_peak_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 2)},
              f, ensure_ascii=False, indent=2)
print("\n=== ГОТОВО ===", flush=True)
