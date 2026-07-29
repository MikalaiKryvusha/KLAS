# tools/voice/silero_daemon.py — РЕЗИДЕНТНЫЙ ДВУЯЗЫЧНЫЙ сайдкар TTS (plans/13, researches/12).
#
# Зачем резидентный. Разовый сайдкар silero_say.py грузит модель заново на КАЖДЫЙ синтез — замер
# 2026-07-28: 2.2 с загрузки против 1.5 с работы. При нарезке ответа на предложения эта цена
# умножалась бы на число фраз. Резидент грузит модель ОДИН раз, синтез фразы — 0.1 с.
#
# Зачем двуязычный (требование владельца 2026-07-28): «важно, чтобы он в одной реплике умел быстро
# переходить с русского на английский, как живой человек; если ответ LLM — смесь языков, это должно
# звучать корректно». Поэтому текст РЕЖЕТСЯ ПО АЛФАВИТУ на отрезки, каждый отрезок синтезируется
# СВОЕЙ моделью (v5_ru / v3_en), а куски склеиваются в одну звуковую дорожку. Английская модель
# грузится лениво — при первой же латинице, чтобы не удлинять старт русского диалога.
#
# Заодно закрыт `bugs/06`: реплика без букв («56.») больше не молчит — числа разворачиваются в слова.
#
# Протокол — построчный JSON (stdin → stdout), одна строка = один запрос/ответ:
#   ← {"text": "Это cat по-английски.", "out": "F:\\...\\a.wav", "voice": "eugene", "voice_en": "en_0"}
#   → {"ok": true, "out": "...", "audio_sec": 2.1, "t_synth_sec": 0.4, "langs": ["ru", "en", "ru"]}
#   → {"ok": false, "reason": "nothing-to-say"}   ← в тексте нет ни букв, ни цифр (НЕ поломка)
#   → {"ok": false, "error": "..."}               ← настоящая ошибка синтеза
#   ← {"echo": "<канарейка>"} → {"echo": "<она же>"}  ← охранник кодировки (bugs/08), см. ниже
# После загрузки русской модели печатает {"stage": "ready"}; выход — EOF на stdin или строка "quit".
#
# Поиск/скачивание русских весов переиспользуем из silero_say.py (DRY): один источник правды.

import json
import re
import sys
import time
import urllib.request
import wave
from pathlib import Path

# ⚠️ КОДИРОВКА ПОТОКОВ — ПЕРВЫМ ДЕЛОМ, ДО ЛЮБОГО ЧТЕНИЯ (bugs/08).
# Node пишет сюда UTF-8, но Python на Windows открывает stdin-ПАЙП в кодировке ЛОКАЛИ
# (`locale.getpreferredencoding()` = cp1251 на русской системе), если UTF-8-режим не включён.
# Тогда «Привет» приезжает как «РџСЂРёРІРµС‚» — это ВАЛИДНАЯ кириллица, поэтому охранник её
# пропускает, и Silero честно проговаривает «Р-џ-С-Ђ…»: владелец слышит «сррс рсрср срр».
# Лечится не переменной окружения у вызывающего (её может не быть — именно так баг и жил:
# у агента PYTHONIOENCODING была задана, у владельца нет), а здесь, в источнике: сайдкар сам
# объявляет свой контракт — он ВСЕГДА говорит UTF-8, кто бы его ни запустил.
# errors="strict" намеренно: тихая замена символов вернула бы бесшумную порчу, ради которой
# этот блок и написан.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    _stream.reconfigure(encoding="utf-8", errors="strict")

sys.path.insert(0, str(Path(__file__).parent))
from silero_say import MODELS_DIR, SAMPLE_RATE, ensure_model  # noqa: E402

EN_MODEL_URL = "https://models.silero.ai/models/tts/en/v3_en.pt"   # v4/v5 английских нет (проверено 2026-07-28)
# Английский диктор подобран ИЗМЕРЕНИЕМ под русский голос владельца `eugene` (bugs/11).
# Silero не сообщает пол дикторов v3_en (есть только имена en_0…en_117), а на слух агент судить не
# вправе, поэтому у всех 118 замерены медианный F0 и спектральный центроид на одной фразе:
#   eugene  F0 = 93.8 Гц  (мужской, низкий)          ← эталон
#   en_23   F0 = 93.8 Гц  ← совпал до десятой доли герца, ближайший из всех
#   en_0    F0 = 202.5 Гц ← прежний дефолт: женский британский, взятый «первым в списке».
#           Его владелец и услышал как смену голоса посреди реплики.
# Замер воспроизводится: `python tools/voice/pitch-check.py --match`.
# ⚠️ Граница: одинаковый F0 = тот же РЕГИСТР, но не тот же человек. Буквально один голос дал бы
# только кросс-язычный клон (вариант C в bugs/11) — это развилка владельца.
DEFAULT_VOICE_EN = "en_23"

# ⛔ РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-07-29 — ПОДБОР ПАРЫ ПО ГЕРЦАМ БОЛЬШЕ НЕ РАЗВИВАЕМ. Дословно:
#   «ты думаешь, что человеческий голос — это герцы? Это не так просто»
#   «голос — это очень уникальный подчерк, герцами его не измерить»
#   «лепить разные голоса на англ и ру домены не получится»
# Здесь была начата таблица «русский голос → подобранный английский диктор» (лечение класса, который
# `bugs/11` закрыл только для `eugene`). Она СНЯТА: владелец отверг не отдельные пары, а сам подход.
# F0 и спектральный центроид описывают РЕГИСТР; личность голоса — это форманты, глоттальный источник,
# манера атаки и ритм, и двумя числами она не ловится. Оговорка про это стояла в `bugs/11` с самого
# начала, и её всё равно переросли в практику — урок записан (EXP-0030).
# `en_23` остаётся дефолтом только потому, что тракт СЕГОДНЯ на нём работает; правильный ответ —
# кросс-язычный клон (вариант C `bugs/11`, план в `researches/15` §5), где голос ОДИН по устройству,
# а не подобран.
CYR = re.compile(r"[а-яёА-ЯЁ]")
LAT = re.compile(r"[A-Za-z]")
DIGIT = re.compile(r"\d")
# Пауза на стыке языков: без неё склейка звучит смазанно, с ней — как естественное переключение
GAP_SEC = 0.06

_models = {}   # {"ru": model, "en": model} — заполняется лениво


def out_line(obj):
    print(json.dumps(obj, ensure_ascii=False), file=sys.stdout, flush=True)


def log(obj):
    print(json.dumps(obj, ensure_ascii=False), file=sys.stderr, flush=True)


# --- Числа словами (bugs/06): нужно только когда в отрезке НЕТ букв, иначе Silero читает цифры сам ---
_ONES = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять",
         "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать",
         "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"]
_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят",
         "восемьдесят", "девяносто"]
_HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот",
             "восемьсот", "девятьсот"]
# (единственное, 2-4, 5+) — русские формы для разрядов
_SCALES = [("", "", ""), ("тысяча", "тысячи", "тысяч"), ("миллион", "миллиона", "миллионов"),
           ("миллиард", "миллиарда", "миллиардов")]


def _plural(n: int, forms) -> str:
    n = abs(n) % 100
    if 11 <= n <= 19:
        return forms[2]
    n %= 10
    if n == 1:
        return forms[0]
    if 2 <= n <= 4:
        return forms[1]
    return forms[2]


def _under_1000(n: int, feminine: bool) -> list:
    words = []
    if n >= 100:
        words.append(_HUNDREDS[n // 100])
        n %= 100
    if n >= 20:
        words.append(_TENS[n // 10])
        n %= 10
    if n:
        if feminine and n in (1, 2):
            words.append("одна" if n == 1 else "две")
        else:
            words.append(_ONES[n])
    return words


def number_to_ru_words(num: int) -> str:
    """Целое число словами. Нужно ТОЛЬКО для текста без букв — Silero на нём падает (bugs/06)."""
    if num == 0:
        return "ноль"
    words = ["минус"] if num < 0 else []
    num = abs(num)
    groups = []
    while num:
        groups.append(num % 1000)
        num //= 1000
    for power in range(len(groups) - 1, -1, -1):
        group = groups[power]
        if not group:
            continue
        words += _under_1000(group, feminine=(power == 1))
        if power:
            words.append(_plural(group, _SCALES[power]))
    return " ".join(words)


def digits_to_words(text: str) -> str:
    return re.sub(r"-?\d+", lambda m: number_to_ru_words(int(m.group())), text)


# --- Числа словами по-английски (bugs/13): v3_en глотает цифры ровно так же, как русская модель ---
# Замер: «It costs 115 dollars.» = 1.19 с, «It costs dollars.» = 1.19 с (то есть числа в звуке нет),
# «It costs one hundred fifteen dollars.» = 2.20 с. Русские числительные в латинском отрезке звучали
# бы дико, поэтому здесь свой, маленький и без зависимостей, разворот.
_EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
            "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
            "eighteen", "nineteen"]
_EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_EN_SCALES = ["", "thousand", "million", "billion", "trillion"]


def _en_under_1000(n: int) -> list:
    words = []
    if n >= 100:
        words += [_EN_ONES[n // 100], "hundred"]
        n %= 100
    if n >= 20:
        words.append(_EN_TENS[n // 10])
        n %= 10
        if n:
            words.append(_EN_ONES[n])
    elif n:
        words.append(_EN_ONES[n])
    return words


def number_to_en_words(num: int) -> str:
    if num == 0:
        return "zero"
    words = ["minus"] if num < 0 else []
    num = abs(num)
    groups = []
    while num:
        groups.append(num % 1000)
        num //= 1000
    for power in range(len(groups) - 1, -1, -1):
        if not groups[power]:
            continue
        words += _en_under_1000(groups[power])
        if power:
            words.append(_EN_SCALES[power])
    return " ".join(words)


def digits_to_en_words(text: str) -> str:
    return re.sub(r"-?\d+", lambda m: number_to_en_words(int(m.group())), text)


# --- Единицы измерения словами (требование владельца 2026-07-29) ---
# Сырой выход LLM вроде «20 C» или «115 кб/c» человеку на слух непонятен, а синтез читает такое
# по буквам. Первый слой лечения — инструкция модели (VOICE_STYLE в pipeline.mjs), но локальная
# модель её иногда забывает, поэтому здесь ДЕТЕРМИНИРОВАННАЯ подстраховка.
# Разворачиваем только то, что стоит ПОСЛЕ ЧИСЛА, — иначе «в» из «м/в» и подобное поедет на обычном
# тексте. Список намеренно короткий и расширяемый: лучше не тронуть, чем произнести неверно.
_UNIT_WORDS = [
    (r"°\s*C|℃|(?<=\d)\s*C\b", " градусов Цельсия"),
    (r"°\s*F|℉", " градусов Фаренгейта"),
    (r"%", " процентов"),
    (r"\bкб/с\b|\bКБ/с\b|\bkb/s\b", " килобайт в секунду"),
    (r"\bмб/с\b|\bМБ/с\b|\bmb/s\b", " мегабайт в секунду"),
    (r"\bгб/с\b|\bГБ/с\b|\bgb/s\b", " гигабайт в секунду"),
    (r"\bкм/ч\b", " километров в час"),
    (r"\bм/с\b", " метров в секунду"),
    (r"\bкб\b|\bКБ\b", " килобайт"),
    (r"\bмб\b|\bМБ\b", " мегабайт"),
    (r"\bгб\b|\bГБ\b", " гигабайт"),
    (r"\bтб\b|\bТБ\b", " терабайт"),
    (r"\bкм\b", " километров"),
    (r"\bсм\b", " сантиметров"),
    (r"\bмм\b", " миллиметров"),
    (r"\bкг\b", " килограммов"),
    (r"\bч\.", " часов"),
    (r"\bмин\b", " минут"),
    (r"\bсек\b", " секунд"),
    (r"\bт\.е\.", "то есть"),
    (r"\bт\.д\.", "так далее"),
    (r"\bт\.п\.", "тому подобное"),
]
_HAS_NUMBER_BEFORE = re.compile(r"\d\s*$")


# Разметка markdown не имеет звучания, но модель её иногда просачивает вопреки инструкции
_MARKDOWN = re.compile(r"[*_`#]+")


def strip_markdown(text: str) -> str:
    return _MARKDOWN.sub("", text)


def expand_units(text: str) -> str:
    """Развернуть сокращённые единицы в слова. Трогаем сокращение только если ему предшествует число."""
    for pattern, word in _UNIT_WORDS:
        def repl(m, word=word):
            return word if _HAS_NUMBER_BEFORE.search(text[:m.start()]) or "." in m.group() or "%" in m.group() else m.group()
        text = re.sub(pattern, repl, text)
    return re.sub(r"\s{2,}", " ", text)


# --- Нарезка по алфавиту: отрезок = связный кусок одного языка ---
def split_by_script(text: str):
    """[(lang, chunk)], lang ∈ {'ru','en',None}. Цифры и пунктуация липнут к текущему языку."""
    segments, buf, cur = [], "", None
    for ch in text:
        lang = "ru" if CYR.match(ch) else ("en" if LAT.match(ch) else None)
        if lang is None or lang == cur:
            buf += ch
            continue
        if cur is None:
            cur, buf = lang, buf + ch
            continue
        # смена языка: хвост из пунктуации/пробелов уходит СЛЕДУЮЩЕМУ отрезку, а не рвёт текущий
        cut = len(buf)
        while cut > 0 and not (CYR.match(buf[cut - 1]) or LAT.match(buf[cut - 1])):
            cut -= 1
        segments.append((cur, buf[:cut]))
        buf, cur = buf[cut:] + ch, lang
    if buf.strip():
        segments.append((cur, buf))
    return [(lang, chunk) for lang, chunk in segments if chunk.strip()]


def ensure_en_model() -> Path:
    local = MODELS_DIR / "v3_en.pt"
    if not local.exists():
        log({"stage": "download", "model": "v3_en", "url": EN_MODEL_URL})
        urllib.request.urlretrieve(EN_MODEL_URL, local)
    return local


def load_model(lang: str, torch):
    """Ленивая загрузка модели языка. Английская нужна не всегда — не платим за неё стартом."""
    if lang in _models:
        return _models[lang]
    t0 = time.perf_counter()
    path = ensure_model() if lang == "ru" else ensure_en_model()
    importer = torch.package.PackageImporter(path)
    model = importer.load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    _models[lang] = model
    log({"stage": "model_loaded", "lang": lang, "sec": round(time.perf_counter() - t0, 2)})
    return model


def synth_segments(text, voice_ru, voice_en, torch):
    """Синтез по отрезкам разных языков → один тензор. Возвращает (audio, [языки], произнесённый текст).

    Произнесённый текст возвращается потому, что он может ОТЛИЧАТЬСЯ от заданного (цифры разворачиваются
    в слова). Проверяющей стороне нужен именно он, иначе она сверяет звук с тем, что никто не говорил, —
    и краснеет на исправном тракте. Один источник правды вместо второй копии нормализации в бенче.
    """
    pieces, langs, spoken = [], [], []
    gap = torch.zeros(int(SAMPLE_RATE * GAP_SEC))
    # Нормализация ДО нарезки: иначе «C» из «20 C» уедет в английский отрезок и прозвучит как буква
    text = expand_units(strip_markdown(text))
    for lang, chunk in split_by_script(text):
        if lang is None:
            # Букв нет вовсе (только цифры/пунктуация): произносим по-русски, если есть что.
            if not DIGIT.search(chunk):
                continue
            lang = "ru"
        # ⚠️ Цифры разворачиваем в слова у ЛЮБОГО русского отрезка, а не только у безбуквенного
        # (bugs/13). Silero v5_ru не читает цифры НИГДЕ — он их молча выбрасывает: «115 килобайт в
        # секунду» звучит ровно столько же, сколько «килобайт в секунду» (1.09 с против 1.09 с),
        # а «сто пятнадцать килобайт в секунду» — 1.74 с. Прежняя версия разворачивала числа только
        # там, где их отсутствие РОНЯЛО синтез (bugs/06), и потому лечила заметный симптом, пропуская
        # тихий: в обычном предложении число просто исчезало из речи.
        chunk = digits_to_words(chunk) if lang == "ru" else digits_to_en_words(chunk)
        speaker = voice_ru if lang == "ru" else voice_en
        model = load_model(lang, torch)
        if pieces:
            pieces.append(gap)
        pieces.append(model.apply_tts(text=chunk.strip(), speaker=speaker, sample_rate=SAMPLE_RATE))
        langs.append(lang)
        spoken.append(chunk.strip())
    if not pieces:
        return None, [], ""
    return torch.cat(pieces), langs, " ".join(spoken)


def write_wav(path: Path, audio, torch) -> None:
    """Сохранить тензор в 16-битный моно-WAV стандартной библиотекой (без зависимостей)."""
    pcm = (audio * 32767).clamp(-32768, 32767).to(torch.int16).numpy().tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)


def main() -> None:
    t0 = time.perf_counter()
    import torch

    torch.set_num_threads(4)  # хватает для realtime, систему не душим
    load_model("ru", torch)   # русская — сразу; английская подгрузится при первой латинице
    log({"stage": "ready", "t_model_load_sec": round(time.perf_counter() - t0, 2)})
    # Кодировки объявляем В ОТВЕТЕ: вызывающему не нужно верить нам на слово — он видит контракт
    out_line({"stage": "ready", "model": "v5_ru+v3_en(lazy)",
              "enc": {"in": sys.stdin.encoding, "out": sys.stdout.encoding}})

    for line in sys.stdin:
        line = line.strip()
        if not line or line == "quit":
            break
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            out_line({"ok": False, "error": f"плохой JSON запроса: {e}"})
            continue

        # Охранник кодировки (bugs/08): строку гоняем туда-обратно БЕЗ обработки. Расхождение
        # означает, что текст портится на пути между Node и питоном, — и тогда голосовая сессия
        # обязана отказаться стартовать, а не бормотать моджибейк в динамики.
        if "echo" in req:
            out_line({"echo": req["echo"]})
            continue

        text = (req.get("text") or "").strip()
        out_path = Path(req.get("out") or "")
        voice_ru = req.get("voice") or "eugene"
        voice_en = req.get("voice_en") or DEFAULT_VOICE_EN
        if not text or not out_path.name:
            out_line({"ok": False, "error": "нужны поля text и out"})
            continue

        try:
            t_start = time.perf_counter()
            audio, langs, spoken = synth_segments(text, voice_ru, voice_en, torch)
            if audio is None:
                # ни букв, ни цифр (например, «—», «...», эмодзи) — произносить нечего, и это НЕ поломка
                out_line({"ok": False, "reason": "nothing-to-say", "text": text})
                continue
            write_wav(out_path, audio, torch)
            synth = time.perf_counter() - t_start
            dur = len(audio) / SAMPLE_RATE
            out_line({
                "ok": True,
                "out": str(out_path),
                "voice": voice_ru,
                "langs": langs,
                "spoken": spoken,          # что РЕАЛЬНО произнесено (цифры → слова) — для проверки звука
                "audio_sec": round(dur, 2),
                "t_synth_sec": round(synth, 2),
                "rtf": round(synth / dur, 3) if dur else None,
            })
        except Exception as e:  # noqa: BLE001 — резидент обязан пережить плохой кусок и ждать следующий
            out_line({"ok": False, "error": str(e), "text": text})


if __name__ == "__main__":
    main()
