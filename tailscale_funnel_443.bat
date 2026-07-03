:: tailscale_funnel_443.bat — включает публичный HTTPS-доступ к KLAS через Tailscale Funnel.
:: Funnel терминирует TLS на публичном URL (https://<машина>.ts.net) и проксирует на локальный
:: Caddy (http://127.0.0.1:443), который дальше разводит: /llm → LLM-API (Bearer-ключ),
:: /wiki и /homepage → docker-сервисы (basicauth). Проверка: tailscale funnel status.
:: Выключить публичный доступ: tailscale funnel off.
tailscale funnel --bg 443
exit
