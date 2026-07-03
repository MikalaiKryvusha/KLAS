:: start-llama-swap.bat — запуск менеджера моделей llama-swap (Фаза 4: «спит, пока не позовут»).
:: Слушает 127.0.0.1:8080, автозагружает/выгружает модели по запросу (см. config.yaml).
:: Используется задачей автозапуска KLAS (tools/install-autostart.ps1) — стартует при входе в систему.
:: Полный путь к exe обязателен (NoDefaultCurrentDirectoryInExePath=1 на этой машине).
@echo off
for /f "delims=" %%i in ('where llama-swap 2^>nul') do set LS=%%i
if "%LS%"=="" set LS=llama-swap
start "" /b "%LS%" -config F:\KLAS\llama-swap\config.yaml -listen 127.0.0.1:8080
