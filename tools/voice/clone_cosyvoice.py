# -*- coding: utf-8 -*-
"""
Клон голоса движком Fun-CosyVoice3-0.5B-2512 — единственный непробованный МУЛЬТИЯЗЫЧНЫЙ кандидат.

Зачем он в пуле. Владелец 2026-07-30, дословно: *«из движков-кандидатов есть мультиязычные? Чтобы
честно передавать английские слова и буквы… Решение с транслитерацией — это вынужденный костыль»*.
Он прав: ESpeech и F5-TTS_RUSSIAN — русские файнтюны, английских фонем в них нет вовсе, и
транслитерация им не выбор, а единственный способ. CosyVoice 3 заявляет 9 языков включая русский
и КРОСС-ЯЗЫЧНЫЙ zero-shot клон — то есть один голос, честно говорящий и по-русски, и по-английски.

Запускается ИЗ WSL в СВОЁМ окружении (`/opt/CosyVoice/.venv`, Python 3.10): модель требует 3.10,
а рабочий venv стоит на 3.14, и ставить её зависимости рядом с работающими f5-tts и qwen-tts —
риск уронить оба ради третьего кандидата.

    wsl -u root /opt/CosyVoice/.venv/bin/python /mnt/f/KLAS/tools/voice/clone_cosyvoice.py \
        <эталон.wav> <эталон.txt> <префикс> [speed]

Решения, прочитанные В КОДЕ движка, а не взятые по памяти:
  * `inference_zero_shot(tts_text, prompt_text, prompt_wav, speed=, text_frontend=)`
    (`cosyvoice/cli/cosyvoice.py:91`) — пара «звук + текст», как у Qwen и F5;
  * эталон подаётся ТЕНЗОРОМ 16 кГц через `load_wav(path, 16000)` (`utils/file_utils.py:44`);
  * `text_frontend=False` отключает ИХ нормализацию и их же разбиение (`frontend.py:134`:
    возвращает `[text]` целиком). Отключаем намеренно: текст нормализует НАШ общий слой, иначе
    сравнивались бы фронтенды, а не движки;
  * `spk2info.pt` в релизе отсутствует — код это переживает (`frontend.py:49`), zero-shot он не нужен.

Разбиение на предложения — НАШЕ, как у Qwen: владелец на прошлой итерации сказал «не делает паузы
между предложениями», и лечение оказалось именно в подаче по одному предложению.

⚠️ Транслитерация здесь 'abbrev', а НЕ 'full': смысл кандидата в том, что английское он произносит
сам. Полная транслитерация убила бы ровно то свойство, ради которого его берут.
"""
import os, re, sys, time, json

sys.path.insert(0, "/opt/CosyVoice")
sys.path.insert(0, "/opt/CosyVoice/third_party/Matcha-TTS")
sys.path.insert(0, "/mnt/f/KLAS/tools/voice")

import numpy as np
import soundfile as sf
import torch

from text_norm import normalize
from ref_pair import check_ref_pair
from cosyvoice.cli.cosyvoice import CosyVoice3
import cosyvoice.cli.frontend as _cosy_frontend
import torchaudio


def _load_wav_via_soundfile(wav, target_sr, min_sr=16000):
    """
    Замена `cosyvoice.utils.file_utils.load_wav` — та же арифметика, другой ридер.

    Зачем подмена. Их версия зовёт `torchaudio.load(..., backend='soundfile')`, но в torchaudio
    2.13 старые бэкенды сняты, и вызов уходит в `torchcodec`, которого нет (он тянет свою сборку
    ffmpeg). Ставить его ради чтения wav — покупка бинарной зависимости там, где хватает
    `soundfile`, который уже стоит.
    Семантику сохраняем дословно: свести каналы усреднением, переложить в target_sr, не давать
    АПсемплить (их `assert sample_rate >= min_sr`).

    ⚠️ Патчим имя в `cosyvoice.cli.frontend`, а НЕ в `utils.file_utils`: фронтенд импортировал
    функцию через `from … import load_wav`, то есть привязал её к своему модулю, и подмена в
    исходном модуле на него бы не подействовала.
    """
    data, sr = sf.read(wav, dtype="float32", always_2d=True)
    speech = torch.from_numpy(data.mean(axis=1)).unsqueeze(0)
    if sr != target_sr:
        assert sr >= min_sr, f"частота эталона {sr} должна быть не ниже {min_sr}"
        speech = torchaudio.transforms.Resample(orig_freq=sr, new_freq=target_sr)(speech)
    return speech


_cosy_frontend.load_wav = _load_wav_via_soundfile

MODEL_DIR = os.environ.get("COSY_DIR", "/opt/cosyvoice3")   # …-rl для RL-варианта весов
OUT = os.environ.get("CLONE_OUT", "/mnt/f/KLAS/voice/out/clone/v3/_parts")
SENT_PAUSE_S = 0.35

# ⚠️ РЕЖИМ ТРАНСЛИТЕРАЦИИ — ручкой наружу, а не константой (2026-07-31).
# Умолчание 'abbrev' сохранено: так решено каноном для мультиязычных движков. Но правило
# `abbrev` писалось под то, что «RTX по-русски читается Эр-Ти-Икс в любом случае», и на
# мультиязычной модели оно даёт ГИБРИДЫ — «Open веб-ю-ай», «эн-пи-эм run build», — то есть
# возвращает ровно тот костыль, ради снятия которого этот кандидат и взят.
# Что звучит лучше, решает УХО ВЛАДЕЛЬЦА (EXP-0031: агент не судит красоту), поэтому нужна
# возможность выдать оба варианта одним прогоном модели, а не спорить о них в документе.
TRANSLIT = os.environ.get("TRANSLIT", "abbrev")

argv = sys.argv[1:]
REF_WAV = argv[0]
REF_TXT = open(argv[1], encoding="utf-8").read().strip()
PREFIX = argv[2] if len(argv) > 2 else "cosy"
SPEED = float(argv[3]) if len(argv) > 3 else 1.0

TEXTS = [
    ("1-подпись", "Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам."),
    ("2-имена",   "Ядро Qwen три и шесть отвечает через llama.cpp, чат Open WebUI поднят, а база знаний Kiwix содержит русскую Википедию."),
    ("3-цифры",   "Видеокарта RTX 5070 Ti заняла 11.4 ГБ из 16, температура 62 °C, скорость 115 КБ/с, до встречи осталось 15 минут."),
    ("4-код",     "Выполните команду git commit -m \"fix voice\", затем npm run build. Функция f(x) = 2x при x от 1 до 5 вернёт 10."),
    ("5-смесь",   "Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель, а результат сохраняется в файл model.onnx."),
]
_only = [t.strip() for t in os.environ.get("ONLY_TAGS", "").split(",") if t.strip()]
if _only:
    TEXTS = [t for t in TEXTS if t[0] in _only]

# ГЕЙТ пары до загрузки модели (`bugs/16`). engine="cosy" — порога обрезки у него нет,
# проверяется только сходимость темпа «символов в секунду».
pair = check_ref_pair(REF_WAV, REF_TXT, engine="cosy")
print(f"=== эталон принят: {pair} · speed={SPEED} · модель {MODEL_DIR} · транслит={TRANSLIT} ===", flush=True)

os.makedirs(OUT, exist_ok=True)


def split_sentences(text: str):
    try:
        from razdel import sentenize
        parts = [s.text.strip() for s in sentenize(text)]
    except Exception:
        parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text)]
    return [p for p in parts if p]


t0 = time.time()
cosy = CosyVoice3(MODEL_DIR, fp16=torch.cuda.is_available())
print(f"=== модель загружена за {time.time()-t0:.1f} с, sample_rate={cosy.sample_rate} ===", flush=True)
# ⚠️ В CosyVoice 3 `prompt_wav` — это ПУТЬ, а не тензор: фронтенд перечитывает файл трижды
# (24 кГц для фич, 16 кГц для токенов речи и для эмбеддинга диктора — `frontend.py:109/121`).
prompt = REF_WAV

# ⚠️ ФОРМАТ ЭТАЛОННОГО ТЕКСТА У COSYVOICE 3. Движок падает с
#   AssertionError: <|endofprompt|> not detected in CosyVoice3 text or prompt_text
# Его собственные реализации показывают требуемый вид (`runtime/.../model.py:261`,
# `vllm_example.py:28`): текст эталона предваряется системной строкой с маркером.
# Побочно это отключает и их нормализацию (`frontend.py:132`: при наличии `<|…|>`
# text_frontend принудительно False) — что нам и нужно, текст уже нормализован нашим слоем.
PROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"
REF_TXT_MODEL = REF_TXT if "<|endofprompt|>" in REF_TXT else PROMPT_PREFIX + REF_TXT

report = []
for tag, raw in TEXTS:
    spoken = normalize(raw, translit=TRANSLIT)
    # ⛔ БЕЗ разбиения на предложения — в отличие от Qwen. Причина в их собственном охраннике
    # (`cosyvoice.py:94`): если кусок короче половины текста эталона, движок предупреждает
    # «this may lead to bad performance». Наши эталоны ~160 символов, а «Добрый вечер, Николай.»
    # это 22 — каждое предложение попадало бы под предупреждение. Реплика идёт одним куском,
    # паузы движок расставляет сам по пунктуации: он авторегрессионный, просодия его сильная сторона.
    t0 = time.time()
    chunks = []
    for out in cosy.inference_zero_shot(spoken, REF_TXT_MODEL, prompt, stream=False,
                                        speed=SPEED, text_frontend=False):
        chunks.append(out["tts_speech"].squeeze(0).cpu().numpy())
    el = time.time() - t0
    joined = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    sents = chunks
    p = os.path.join(OUT, f"{PREFIX}_{tag}.wav")
    sf.write(p, joined, cosy.sample_rate)
    dur = len(joined) / cosy.sample_rate
    print(f"[{tag}] {len(sents)} предл. · {el:.2f} с / звук {dur:.2f} с / RTF {el/dur:.3f}", flush=True)
    report.append({"engine": PREFIX, "tag": tag, "spoken": spoken, "file": p,
                   "synth_s": round(el, 3), "audio_s": round(dur, 3), "rtf": round(el / dur, 4),
                   "sr": cosy.sample_rate})

with open(os.path.join(OUT, f"report_{PREFIX}.json"), "w", encoding="utf-8") as f:
    json.dump({"ref": pair, "items": report,
               "vram_peak_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 2)
               if torch.cuda.is_available() else 0},
              f, ensure_ascii=False, indent=2)
print("=== ГОТОВО ===", flush=True)
