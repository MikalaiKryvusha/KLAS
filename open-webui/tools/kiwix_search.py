"""
title: Kiwix — локальная база знаний (Википедия офлайн)
author: KLAS
version: 1.0.0
license: MIT
description: Поиск по локальному Kiwix (Википедия и другие .zim) прямо из чата. Ищет по ВСЕМ книгам всех языков; новые .zim подхватываются автоматически (список языков берётся из каталога Kiwix на каждый запрос). Ничего не заливается в Open WebUI — данные остаются в Kiwix.
requirements: requests
"""

# ── Как это работает (KLAS, баг 03 / идея 11) ─────────────────────────────────
# Open WebUI и Kiwix — в одной docker-сети (docker-compose.yml), поэтому тул ходит
# на Kiwix по внутреннему имени контейнера kiwix_wikipedia:8080 с urlRoot /wiki.
# Kiwix НЕ умеет искать «по всем книгам» одним запросом без указания книг, зато
# умеет фильтр по языку (books.filter.lang). Поэтому: берём все языки из каталога
# (/catalog/v2/entries → <language>…</language>) и ищем по каждому — так в поиск
# попадают ВСЕ книги, а любой новый .zim (его язык уже в каталоге) виден автоматом.

import re
import html
from urllib.parse import quote

import requests
from pydantic import BaseModel, Field


def _get(url: str, timeout: int) -> requests.Response:
    """GET с принудительным UTF-8 (Kiwix отдаёт UTF-8, но без charset в заголовке)."""
    r = requests.get(url, timeout=timeout)
    r.encoding = "utf-8"
    return r


def _strip_html(raw: str) -> str:
    """Грубо, но надёжно: выкинуть script/style, снять теги, декодировать сущности, сжать пробелы."""
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    text = html.unescape(re.sub(r"(?s)<[^>]+>", " ", raw))
    return re.sub(r"\s+", " ", text).strip()


class Tools:
    class Valves(BaseModel):
        # Базовый URL Kiwix изнутри docker-сети open-webui. urlRoot /wiki задан в docker-compose.
        kiwix_base: str = Field(
            default="http://kiwix_wikipedia:8080/wiki",
            description="Базовый URL Kiwix (внутри docker-сети), включая urlRoot /wiki.",
        )
        results_per_lang: int = Field(
            default=5, description="Сколько результатов брать на каждый язык."
        )
        max_articles: int = Field(
            default=3, description="Сколько верхних статей подтянуть целиком."
        )
        chars_per_article: int = Field(
            default=2500, description="Ограничение длины текста одной статьи (символов)."
        )
        timeout: int = Field(default=20, description="Таймаут HTTP-запроса к Kiwix, сек.")

    def __init__(self):
        self.valves = self.Valves()

    def search_local_knowledge(self, query: str) -> str:
        """
        Искать в ЛОКАЛЬНОЙ офлайн-базе знаний Kiwix (Википедия, Викитека, Викиучебник, Викиверситет
        и другие .zim) и вернуть текст найденных статей с указанием источника. Вызывай этот инструмент,
        когда нужны факты, определения, справочные/энциклопедические сведения, биографии, история,
        наука — то есть всё, что может быть в Википедии. Ищет по всем книгам и языкам сразу.
        :param query: Поисковый запрос — тема, имя, термин или вопрос (на любом языке).
        :return: Текст релевантных статей из локальной базы или сообщение, что ничего не найдено.
        """
        base = self.valves.kiwix_base.rstrip("/")

        # 1) Языки из каталога — авто-подхват любых новых .zim.
        try:
            cat = _get(f"{base}/catalog/v2/entries?count=1000", self.valves.timeout).text
            langs = sorted(set(re.findall(r"<language>([^<]+)</language>", cat)))
        except Exception as e:
            return f"Не удалось обратиться к локальной базе Kiwix ({base}): {e}"
        if not langs:
            langs = ["rus", "eng"]  # разумный дефолт, если каталог пуст/недоступен

        # 2) Поиск по каждому языку → уникальные (книга, путь-к-статье).
        hits = []
        seen = set()
        for lang in langs:
            try:
                url = (
                    f"{base}/search?pattern={quote(query)}"
                    f"&books.filter.lang={lang}&pageLength={self.valves.results_per_lang}"
                )
                r = _get(url, self.valves.timeout)
                if r.status_code != 200:
                    continue
                # ссылки результатов имеют вид /wiki/content/<книга>/<статья> (статья уже URL-кодирована)
                for m in re.finditer(r'href="[^"]*?/content/([^"/]+)/([^"]+)"', r.text):
                    key = (m.group(1), m.group(2))
                    if key in seen:
                        continue
                    seen.add(key)
                    hits.append(key)
            except Exception:
                continue

        if not hits:
            return (
                f"В локальной базе Kiwix по запросу «{query}» ничего не найдено. "
                f"Возможно, нужной .zim-книги нет в базе."
            )

        # 3) Подтянуть текст верхних статей.
        blocks = []
        for book, path in hits[: self.valves.max_articles]:
            try:
                cr = _get(f"{base}/content/{book}/{path}", self.valves.timeout)
                if cr.status_code != 200:
                    continue
                title = html.unescape(path.split("/")[-1].replace("_", " "))
                # title приходит URL-кодированным; аккуратно раскодируем для читаемости
                try:
                    from urllib.parse import unquote

                    title = unquote(title)
                except Exception:
                    pass
                text = _strip_html(cr.text)[: self.valves.chars_per_article]
                blocks.append(f"### {title}\nИсточник (Kiwix): {book}\n\n{text}")
            except Exception:
                continue

        if not blocks:
            return f"Нашёл ссылки по запросу «{query}», но не смог получить текст статей из Kiwix."

        header = (
            f"Результаты локального поиска Kiwix по запросу «{query}» "
            f"(книг-языков просмотрено: {len(langs)}). Используй как источник для ответа:\n\n"
        )
        return header + "\n\n---\n\n".join(blocks)
