// tools/lib/i18n.mjs — мультиязычие мастера-установщика KLAS (план 05, идея 12).
// Словарь ключ→строка на язык. t(key, vars) подставляет {переменные}. Добавить язык = добавить блок.
// Строки короткие и человечные: мастер должен быть понятен самому неопытному пользователю.

const DICT = {
  ru: {
    lang_pick: 'Выберите язык / Choose language:',
    welcome_title: 'Установщик KLAS — Krinik Local Agent System',
    welcome_body:
      'Это мастер установит на ваш ПК локального ИИ-ассистента: локальную LLM на вашей видеокарте,\n' +
      'веб-пульт, чат и офлайн-Википедию. Я проведу вас по шагам и всё объясню. Прервать можно в любой\n' +
      'момент — при повторном запуске продолжим с места остановки.',
    resume_found: 'Найдена незавершённая установка (шаг: {phase}). Продолжаем с этого места.',
    detect_title: 'Проверяю ваш компьютер…',
    detect_gpu: 'Видеокарта (GPU)',
    detect_vram: 'Видеопамять',
    detect_driver: 'Драйвер',
    detect_cuda: 'CUDA',
    detect_rocm: 'ROCm',
    detect_docker: 'Docker',
    detect_wsl: 'WSL2',
    detect_node: 'Node.js',
    detect_git: 'Git',
    detect_disk: 'Свободно на диске',
    detect_net: 'Интернет',
    yes: 'да',
    no: 'нет',
    not_found: 'не найдено',
    gpu_nvidia: 'Обнаружена NVIDIA — будем использовать сборку движка с CUDA.',
    gpu_amd: 'Обнаружена AMD — потребуется ROCm (или запасной режим).',
    gpu_none: 'Видеокарта для ускорения не найдена. LLM будет работать на процессоре — медленно.',
    gpu_none_confirm: 'Продолжить без ускорения GPU?',
    need_driver: 'Видеокарта {what} есть, но её драйвер не обнаружен — без него ускорение не заработает.',
    driver_open: 'Открываю страницу загрузки драйвера: {url} — установите драйвер и перезагрузитесь.',
    resume_scheduled: 'После перезагрузки установщик продолжит сам. Либо запустите его снова той же командой.',
    q_anonymous: 'Ставить анонимно (без личных идентификаторов владельца в файлах проекта)?',
    q_libs: 'Скачивать дополнительные библиотеки/компоненты (можно позже)?',
    q_zim: 'Скачать офлайн-Википедию (.zim, большой объём)?',
    q_model: 'Какую LLM-модель поставить?',
    model_main: 'Основная — Qwythos-9B (256K контекста, ~6 ГБ) [рекомендую]',
    model_backup: 'Запасная — Gemma-4-12B (мультимодальная, ~7 ГБ)',
    model_both: 'Обе модели (~13 ГБ)',
    estimate: 'Будет скачано ~{gb} ГБ, на диске свободно {disk} ГБ. Продолжить установку?',
    not_enough_disk: 'Мало места на диске: нужно ~{need} ГБ, свободно {free} ГБ. Освободите место и запустите снова.',
    no_internet: 'Нет интернета — а он нужен для скачивания. Проверьте соединение и запустите снова.',
    installing: 'Устанавливаю компоненты (это надолго — качаются гигабайты, можно отойти)…',
    anonymizing: 'Обезличиваю установку…',
    making_shortcuts: 'Создаю ярлыки на Рабочем столе…',
    offer_autostart: 'Запускать KLAS автоматически при входе в Windows?',
    running_health: 'Проверяю, что стек поднялся…',
    open_now: 'Открыть пульт управления сейчас?',
    reboot_needed:
      'Нужна перезагрузка, чтобы {why}. После входа в систему запустите установщик снова той же\n' +
      'командой — я продолжу с этого места. Поставить автозапуск продолжения после перезагрузки?',
    phase_done: '[готово] {phase}',
    all_done_title: 'KLAS установлен и работает!',
    links_panel: 'Пульт управления',
    links_chat: 'Чат',
    links_wiki: 'Википедия',
    where_password: 'Логин и пароль — в файле caddy/PASSWORD.local.txt',
    bye: 'Выход. Прогресс сохранён — запустите снова, чтобы продолжить.',
    choose_hint: '(Enter — рекомендуемый вариант, q — выход)',
  },
  en: {
    lang_pick: 'Выберите язык / Choose language:',
    welcome_title: 'KLAS Installer — Krinik Local Agent System',
    welcome_body:
      'This wizard installs a local AI assistant on your PC: a local LLM on your GPU, a web dashboard,\n' +
      'a chat, and an offline Wikipedia. I will guide you step by step and explain everything. You can\n' +
      'stop anytime — on the next run we continue where we left off.',
    resume_found: 'Found an unfinished install (step: {phase}). Continuing from there.',
    detect_title: 'Checking your computer…',
    detect_gpu: 'Graphics card (GPU)',
    detect_vram: 'Video memory',
    detect_driver: 'Driver',
    detect_cuda: 'CUDA',
    detect_rocm: 'ROCm',
    detect_docker: 'Docker',
    detect_wsl: 'WSL2',
    detect_node: 'Node.js',
    detect_git: 'Git',
    detect_disk: 'Free disk space',
    detect_net: 'Internet',
    yes: 'yes',
    no: 'no',
    not_found: 'not found',
    gpu_nvidia: 'NVIDIA detected — using the CUDA engine build.',
    gpu_amd: 'AMD detected — ROCm (or a fallback) will be needed.',
    gpu_none: 'No accelerator GPU found. The LLM will run on the CPU — slowly.',
    gpu_none_confirm: 'Continue without GPU acceleration?',
    need_driver: 'A {what} GPU is present, but its driver was not found — acceleration needs it.',
    driver_open: 'Opening the driver download page: {url} — install the driver and reboot.',
    resume_scheduled: 'After reboot the installer continues on its own. Or just run it again with the same command.',
    q_anonymous: "Install anonymously (no owner's personal identifiers in project files)?",
    q_libs: 'Download extra libraries/components (can be done later)?',
    q_zim: 'Download the offline Wikipedia (.zim, large)?',
    q_model: 'Which LLM model to install?',
    model_main: 'Main — Qwythos-9B (256K context, ~6 GB) [recommended]',
    model_backup: 'Backup — Gemma-4-12B (multimodal, ~7 GB)',
    model_both: 'Both models (~13 GB)',
    estimate: 'About {gb} GB will be downloaded, {disk} GB free on disk. Continue with the install?',
    not_enough_disk: 'Low disk space: need ~{need} GB, {free} GB free. Free up space and run again.',
    no_internet: 'No internet — it is required for downloads. Check your connection and run again.',
    installing: 'Installing components (this takes a while — gigabytes are downloading, feel free to step away)…',
    anonymizing: 'Anonymizing the install…',
    making_shortcuts: 'Creating desktop shortcuts…',
    offer_autostart: 'Start KLAS automatically when Windows starts?',
    running_health: 'Checking that the stack is up…',
    open_now: 'Open the control panel now?',
    reboot_needed:
      'A reboot is required to {why}. After signing in, run the installer again with the same\n' +
      'command — I will continue from here. Set up auto-resume after reboot?',
    phase_done: '[done] {phase}',
    all_done_title: 'KLAS is installed and running!',
    links_panel: 'Control panel',
    links_chat: 'Chat',
    links_wiki: 'Wikipedia',
    where_password: 'Login and password are in caddy/PASSWORD.local.txt',
    bye: 'Exiting. Progress saved — run again to continue.',
    choose_hint: '(Enter = recommended, q = quit)',
  },
};

export const LANGS = Object.keys(DICT);

export function makeT(lang) {
  const table = DICT[lang] || DICT.en;
  return (key, vars = {}) =>
    (table[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}
