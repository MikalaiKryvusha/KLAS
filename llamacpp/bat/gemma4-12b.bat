@echo on
:: gemma4-12b.bat — профиль запуска LLM-сервера KLAS (llama-server + gemma-4-12b Q4_K_XL).
:: Порт: 8080 (host-порт kiwix перенесён на 8081 — см. docker-compose.yml, баг 01).
:: Ресурсы: ~12.5 GB VRAM (модель ~7.4 GB + KV 128K контекста), запас ~3.8 GB на карте 16 GB.
:: Проверка: powershell -File F:\KLAS\tools\health-check.ps1
cd /d "F:\KLAS\llamacpp"

:: Полный путь к exe ОБЯЗАТЕЛЕН: на этой машине включена защита Windows
:: NoDefaultCurrentDirectoryInExePath — cmd НЕ ищет исполняемые файлы в текущей папке.
"F:\KLAS\llamacpp\llama-server.exe" ^
  -m "F:\KLAS\LLMs\LLAMACPP_MODELS\gemma-4-12b-it-UD-Q4_K_XL.gguf" ^
  -a gemma-4-12b ^
  --port 8080 ^
  -c 131072 ^
  -ngl 99 ^
  --flash-attn on ^
  -b 2048 -ub 1024 ^
  --jinja ^
  -np 1 --slots --cont-batching ^
  --temperature 0.6 ^
  --min-p 0.05 ^
  --repeat-penalty 1.2 ^
  --repeat-last-n 512 ^
  --frequency-penalty 0.15 ^
  --presence-penalty 0.2 ^
  --reasoning off ^
  --cache-ram 0
pause

:: Комментарии к параметрам (зачем такие значения — баг 01 + researches/02):
::   -a gemma-4-12b     — алиас модели в API (поле model)
::   --port 8080        — ЯВНЫЙ порт: раньше не был задан, а host-порт 8080 делил с docker-kiwix,
::                        и Zoo Code мог стучаться в википедию вместо LLM (симптом «переполнения»)
::   -c 131072          — 128K контекст: KV целиком в VRAM (12.5/16.3 GB, запас ~3.8 GB).
::                        Нативный максимум модели 262144 (n_ctx_train); -c 256000 тоже работает
::                        (сборка b9538, авто-fit), но оставляет лишь ~1.6 GB запаса VRAM —
::                        ради СТАБИЛЬНОСТИ выбран 131072
::   --flash-attn on    — +15–20% к скорости обработки промпта (researches/02)
::   --jinja            — ОБЯЗАТЕЛЕН для tool calling агентских фронтендов
::   -ngl 99            — все слои на GPU
:: Замеры 2026-07-03 (сборка b9538): генерация ~63–68 t/s; промпт 25K токенов за 7.8 c (~3400 t/s)
