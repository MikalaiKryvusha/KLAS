#!/usr/bin/env python3
"""
Сборка импортируемого JSON тула Open WebUI из его .py-исходника (идея 11 / баг 03).

Open WebUI умеет импортировать тулы файлом JSON (то же, что даёт Export Tools). Импорт читает
массив объектов и на каждый берёт поля id/name/meta/content/access_grants; specs сервер строит из
content сам (проверено по коду Open WebUI 0.10.2). Этот скрипт держит JSON в синхроне с .py.

Запуск:  py -3 tools/build-owui-tool-json.py
Вход:    open-webui/tools/kiwix_search.py
Выход:   open-webui/tools/kiwix_search.tool.json
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "open-webui" / "tools" / "kiwix_search.py"
OUT = ROOT / "open-webui" / "tools" / "kiwix_search.tool.json"

content = SRC.read_text(encoding="utf-8")

tool = {
    "id": "kiwix_search",
    "name": "Kiwix — локальная база знаний (Википедия офлайн)",
    "meta": {
        "description": "Поиск по локальному Kiwix (Википедия и др. .zim) из чата: все книги/языки, авто-подхват новых .zim.",
        "manifest": {
            "title": "Kiwix — локальная база знаний (Википедия офлайн)",
            "author": "KLAS",
            "version": "1.0.0",
            "license": "MIT",
            "requirements": "requests",
        },
    },
    "content": content,
    "access_grants": [],  # приватный тул импортирующего пользователя
}

OUT.write_text(json.dumps([tool], ensure_ascii=False, indent=2), encoding="utf-8")
print(f"OK -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes)")
