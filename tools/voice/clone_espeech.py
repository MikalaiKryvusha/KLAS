# -*- coding: utf-8 -*-
"""
Клон голоса движком ESpeech-TTS-1 RL-V2 (архитектура F5, 4000+ ч русской речи, Apache-2.0).

Запускается ИЗ WSL (движок и torch живут там), но лежит в репозитории KLAS, а не в /opt:
прошлая сессия держала свои скрипты синтеза в /opt, вне git, и свежая сессия о них не узнавала.
Путь `/mnt/f/KLAS/tools/voice` уже в `sys.path` у обоих движков — оттуда же берётся `text_norm`.

    wsl -e /opt/voicetrain/.venv/bin/python /mnt/f/KLAS/tools/voice/clone_espeech.py \
        [<эталон.wav> <эталон.txt> <префикс-вывода>]

Без аргументов берётся эталон Jarvis (Вихров), одобренный владельцем 2026-07-29. Аргументы
существуют, чтобы гонять ДРУГИЕ голоса (Joi) тем же кодом: копия скрипта под каждый голос
разъезжается с оригиналом при первой же правке.

⛔ Эталон подаётся ТОЛЬКО через `check_ref_pair` (`bugs/16`). F5 режет эталонный ЗВУК до 12 000 мс
и НЕ трогает ТЕКСТ — рассогласованная пара молча портит КАЖДЫЙ синтез: реплика звучит вдвое
быстрее, а лишний текст эталона модель договаривает вслух. Замер: пара сходится → 5/5 чистых,
не сходится → 10/10 испорченных. Охранник бросает исключение ДО загрузки модели.

Тексты кастинга ЗАФИКСИРОВАНЫ (`homeworks/03`) — менять нельзя: иначе сравниваются тексты,
а не движки.
"""
import os, sys, time, json
import soundfile as sf
import torch

sys.path.insert(0, "/mnt/f/KLAS/tools/voice")
from text_norm import normalize
from ref_pair import check_ref_pair

from ruaccent import RUAccent
from f5_tts.infer.utils_infer import infer_process, load_model, load_vocoder, preprocess_ref_audio_text
from f5_tts.model import DiT

OUT = os.environ.get("CLONE_OUT", "/mnt/f/KLAS/voice/out/clone")
# ESpeech — модель на 4000 ч РУССКОГО, английских фонем в ней нет. Вердикт владельца 2026-07-30:
# «английские слова произносит плохо», «RTX 5070 Ti произносит плохо», «тараторит на коде и
# английских командах». Поэтому режим транслитерации у этого движка — 'full' ПО УМОЛЧАНИЮ:
# латиницы в речи не остаётся ни одной буквы. Решение владельца о способе — канон 2026-07-29
# («транслитерация кириллицей — второй способ самый хороший»).
TRANSLIT = os.environ.get("TRANSLIT", "full")
# Веса сменные: под архитектуру F5 существует НЕСКОЛЬКО русских файнтюнов, и они запускаются одним
# и тем же кодом — меняются только чекпойнт и vocab. Проверяем их «бесплатно», без второго скрипта:
#   ESpeech RL-V2        — /opt/espeech/rl_v2/espeech_tts_rlv2.pt   (4000+ ч, дефолт)
#   F5-TTS_RUSSIAN v4    — /opt/f5ru/F5TTS_v1_Base_v4_winter/model_212000.safetensors
#                          (Misha24-10, 5000+ ч Common Voice/Sova/LibriHeavy + RUAccent)
# ⛔ Оба ОДНОЯЗЫЧНЫЕ: английских фонем в них нет, отсюда TRANSLIT='full'. Мультиязычные кандидаты —
# Qwen3-TTS и CosyVoice 3, у них отдельные скрипты.
MODEL = os.environ.get("F5_MODEL", "/opt/espeech/rl_v2/espeech_tts_rlv2.pt")
VOCAB = os.environ.get("F5_VOCAB", "/opt/espeech/rl_v2/vocab.txt")
MODEL_CFG = dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4)

argv = sys.argv[1:]
REF_WAV = argv[0] if len(argv) > 0 else os.path.join(OUT, "ref_vihrov_12s.wav")
REF_TXT_PATH = argv[1] if len(argv) > 1 else os.path.join(OUT, "ref_vihrov_12s.txt")
PREFIX = argv[2] if len(argv) > 2 else "espeech"

# ТЕМП. F5 не имеет собственного представления о скорости речи — он берёт её из ЭТАЛОНА
# (движок, строка 505 `utils_infer.py`):
#     duration = ref_audio_len + ref_audio_len / ref_text_len * gen_text_len / speed
# То есть «секунд на символ» у эталона переносится на наш текст и делится на `speed`.
# Следствие, которое надо знать: **эмоциональный быстрый эталон даёт тараторящий клон**, и это
# не дефект движка. Владелец услышал это на эталоне Ви (17.2 симв/с против 14.1 у Вихрова) —
# отсюда ручка наружу, а не хардкод. speed < 1 замедляет, speed > 1 ускоряет.
SPEED = float(argv[3]) if len(argv) > 3 else 1.0
REF_TXT = open(REF_TXT_PATH, encoding="utf-8").read().strip()

TEXTS = [
    ("1-подпись", "Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам."),
    ("2-имена",   "Ядро Qwen три и шесть отвечает через llama.cpp, чат Open WebUI поднят, а база знаний Kiwix содержит русскую Википедию."),
    ("3-цифры",   "Видеокарта RTX 5070 Ti заняла 11.4 ГБ из 16, температура 62 °C, скорость 115 КБ/с, до встречи осталось 15 минут."),
    ("4-код",     "Выполните команду git commit -m \"fix voice\", затем npm run build. Функция f(x) = 2x при x от 1 до 5 вернёт 10."),
    ("5-смесь",   "Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель, а результат сохраняется в файл model.onnx."),
]

# Пересчёт только части текстов — см. пояснение в `clone_qwen.py`. Фильтруется НАБОР, не содержимое.
_only = [t.strip() for t in os.environ.get("ONLY_TAGS", "").split(",") if t.strip()]
if _only:
    TEXTS = [t for t in TEXTS if t[0] in _only]

# ГЕЙТ: пара проверяется ДО того, как потрачены минуты на загрузку модели и RUAccent.
pair = check_ref_pair(REF_WAV, REF_TXT, engine="f5")
print(f"=== эталон принят: {pair} · speed={SPEED} · ожидаемый темп "
      f"{pair['cps'] * SPEED:.1f} симв/с ===", flush=True)

os.makedirs(OUT, exist_ok=True)
noop = lambda *a, **k: None

print("=== загружаю ESpeech ===", flush=True)
model = load_model(DiT, MODEL_CFG, MODEL, vocab_file=VOCAB)
vocoder = load_vocoder()
dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model.to(dev); vocoder.to(dev)

acc = RUAccent()
acc.load(omograph_model_size="turbo3.1", use_dictionary=True, tiny_mode=False)
print("=== RUAccent готов ===", flush=True)

# show_info=print намеренно: сообщение «Audio is over 12s, clipping short» — улика,
# и если охранник когда-нибудь пропустит такой эталон, мы это УВИДИМ в логе.
ref_proc, ref_text_proc = preprocess_ref_audio_text(REF_WAV, acc.process_all(REF_TXT), show_info=print)
print(f"=== длительность эталона после препроцессинга: {sf.info(ref_proc).duration:.2f} с ===", flush=True)

report = []
for tag, raw in TEXTS:
    spoken = normalize(raw, translit=TRANSLIT)   # единицы, дроби, код + латиница в кириллицу
    accented = acc.process_all(spoken)      # ударения: то, чего нет ни у Qwen, ни у Silero
    t0 = time.time()
    wave, sr, _ = infer_process(ref_proc, ref_text_proc, accented, model, vocoder,
                                cross_fade_duration=0.15, nfe_step=32, speed=SPEED,
                                show_info=noop, progress=None)
    el = time.time() - t0
    p = os.path.join(OUT, f"{PREFIX}_{tag}.wav")
    sf.write(p, wave, sr)
    dur = len(wave) / sr
    print(f"[{tag}] {el:.2f} с / звук {dur:.2f} с / RTF {el/dur:.3f}", flush=True)
    report.append({"engine": PREFIX, "tag": tag, "spoken": spoken, "file": p,
                   "synth_s": round(el, 3), "audio_s": round(dur, 3), "rtf": round(el / dur, 4)})

with open(os.path.join(OUT, f"report_{PREFIX}.json"), "w", encoding="utf-8") as f:
    json.dump({"ref": pair, "items": report,
               "vram_peak_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 2)},
              f, ensure_ascii=False, indent=2)
print("=== ГОТОВО ===", flush=True)
