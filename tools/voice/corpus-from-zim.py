#!/usr/bin/env python3
# tools/voice/corpus-from-zim.py — сбор ТЕКСТОВОГО корпуса для обучения голоса (план 15, этап 1).
#
# Зачем. Чтобы обучить копию голоса, нужен корпус фраз, которые этим голосом озвучат. Текст берём
# из НАШИХ ЖЕ офлайн-баз знаний (F:\KLAS\kiwixdb\*.zim) — это принцип KLAS: приватно, офлайн,
# без единого запроса наружу, и качать ничего не надо.
#
# Смесь двух источников намеренная:
#   * wikisource_ru — литературная проза: живой РИТМ и интонация, чего нет в энциклопедии;
#   * wikipedia_ru  — современная лексика, термины и имена собственные.
# Обучение только на одном даёт перекос: на классике голос не выучит современных слов, на
# энциклопедии — не выучит естественной фразовой мелодии.
#
# ⚠️ Фильтры жёсткие НАМЕРЕННО. В обучающий текст не должно попасть ничего, что синтезатор
# прочитает не так, как записано, — иначе модель учится на РАСХОЖДЕНИИ текста и звука, а это
# худший вид порчи данных: он не виден ни в одном логе и проявится только голосом.
# Первый прогон это доказал: без фильтров в корпус попали дореформенная орфография из Wikisource
# («офицеръ», «можетъ», «Такъ точно-съ») и фразы-химеры из склеенных HTML-блоков
# («Законодательство предусматривает ряд а при увольнении рабочего … выдаётся ему на руки»).
#
# Запуск (в WSL, где стоит libzim):
#   python3 corpus-from-zim.py --out /opt/corpus/sentences.txt --count 3000
# [NOT-TESTED]

import argparse
import html
import random
import re
import sys
from pathlib import Path

from libzim.reader import Archive

ZIM_DIR = Path("/mnt/f/KLAS/kiwixdb")
SOURCES = [
    ("wikisource_ru_all_maxi_2026-01.zim", 0.6),   # проза — ритм и интонация
    ("wikipedia_ru_all_maxi_2025-06.zim", 0.4),    # современная лексика и имена
]

SCRIPT = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)
# Блочные теги обязаны стать ГРАНИЦЕЙ, а не пробелом: иначе текст соседних блоков склеивается в
# одну «фразу»-химеру, грамматически похожую на предложение и лишённую смысла. Такие фразы опаснее
# явного мусора — они проходят любой фильтр по алфавиту и длине.
BLOCK = re.compile(r"</?(p|div|br|li|tr|td|th|h[1-6]|blockquote|section|article|ul|ol|table|dt|dd)[^>]*>", re.I)
TAG = re.compile(r"<[^>]+>")
SPACES = re.compile(r"[ \t\u00a0]+")

# Разрешённый алфавит фразы: только кириллица, пробел и базовая пунктуация. Всё остальное —
# цифры, латиница, формулы, сноски — повод отбросить фразу ЦЕЛИКОМ, а не «почистить»: чистка меняет
# текст, звук будет синтезирован по чистому, и рассинхрон не заметит никто.
ALLOWED = re.compile(r"^[А-Яа-яЁё\s,.!?;:—–\-«»\"']+$")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")

# Дореформенная орфография — Wikisource полон текстов до 1918 года. Современный голос так не
# говорит; учить его на этом значит учить расхождению текста и произношения.
OLD_LETTERS = re.compile(r"[\u0463\u0462\u0456\u0406\u0473\u0472\u0475\u0474]")   # ѣ Ѣ і І ѳ Ѳ ѵ Ѵ
OLD_HARD_SIGN = re.compile(r"[А-Яа-яЁё][ъЪ](?=\s|$|[,.!?;:—«»])")                 # «офицеръ», «Въ»

# Одиночные буквы, которые в русском бывают словами. Всё прочее односимвольное — след срезанной
# разметки: инициал, сноска, ячейка таблицы.
REAL_ONE_LETTER = set("вксуоаияжбль")

# Заголовки разделов, приклеенные к тексту статьи.
HEADER_START = re.compile(r"^(Ссылки|Литература|Примечания|Источники|См\. также|Библиография|Категории|Содержание|Галерея)\b")


def article_text(zim: Archive, idx: int) -> str:
    """Достать текст статьи по индексу; переводы строк = границы блоков. '' если запись не текстовая."""
    try:
        entry = zim._get_entry_by_id(idx)
        if entry.is_redirect:
            return ""
        item = entry.get_item()
        if not item.mimetype.startswith("text/html"):
            return ""
        raw = bytes(item.content).decode("utf-8", errors="ignore")
    except Exception:
        return ""
    raw = SCRIPT.sub(" ", raw)
    raw = BLOCK.sub("\n", raw)        # СНАЧАЛА границы блоков
    raw = TAG.sub(" ", raw)           # потом всё остальное
    raw = html.unescape(raw)
    return "\n".join(SPACES.sub(" ", line).strip() for line in raw.split("\n"))


def sentences(text, min_words, max_words, min_len, max_len):
    """Годные фразы. Граница блока — такой же разделитель, как точка."""
    for block in text.split("\n"):
        for s in SENT_SPLIT.split(block):
            s = s.strip()
            if not (min_len <= len(s) <= max_len):
                continue
            if not ALLOWED.match(s):
                continue                      # цифры/латиница/разметка
            if not s[0].isupper() or s[-1] not in ".!?":
                continue                      # обрывок абзаца: нет начала или конца интонации
            if OLD_LETTERS.search(s) or OLD_HARD_SIGN.search(s):
                continue                      # дореформенная орфография
            if HEADER_START.match(s):
                continue                      # заголовок раздела, приклеенный к тексту
            words = s.split()
            if not (min_words <= len(words) <= max_words):
                continue
            if any(len(w) > 24 for w in words):
                continue                      # склейка без пробела после срезания тегов
            if any(len(w) == 1 and w.lower() not in REAL_ONE_LETTER for w in words):
                continue                      # одиночная буква = след разметки
            yield s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--count", type=int, default=3000)
    ap.add_argument("--min-words", type=int, default=5)
    ap.add_argument("--max-words", type=int, default=18)
    ap.add_argument("--min-len", type=int, default=40)
    ap.add_argument("--max-len", type=int, default=140)
    ap.add_argument("--seed", type=int, default=20260729)   # тот же корпус при повторном прогоне
    a = ap.parse_args()

    rnd = random.Random(a.seed)
    picked = {}                                # нормализованный ключ → фраза (дедупликация)

    for name, share in SOURCES:
        path = ZIM_DIR / name
        if not path.exists():
            print(f"нет файла {path} — пропуск", file=sys.stderr)
            continue
        want = int(a.count * share)
        zim = Archive(str(path))
        total = zim.all_entry_count
        got = 0
        tries = 0
        # Случайные индексы вместо подряд: подряд идут статьи одной темы и одного автора, и корпус
        # вышел бы узким по лексике при том же объёме.
        while got < want and tries < want * 200:
            tries += 1
            text = article_text(zim, rnd.randrange(total))
            if not text:
                continue
            for s in sentences(text, a.min_words, a.max_words, a.min_len, a.max_len):
                key = SPACES.sub(" ", s.lower())
                if key in picked:
                    continue
                picked[key] = s
                got += 1
                if got >= want:
                    break
        print(f"{name}: собрано {got} фраз за {tries} обращений", file=sys.stderr)

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    lines = list(picked.values())
    rnd.shuffle(lines)                         # перемешать источники: обучение не должно идти блоками
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"итого {len(lines)} уникальных фраз → {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
