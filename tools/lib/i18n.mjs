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
    need_driver: 'Драйвер {what} не найден или устарел — этот шаг потребует перезагрузки.',
    q_anonymous: 'Ставить анонимно (без ваших личных идентификаторов в файлах проекта)?',
    q_libs: 'Скачивать дополнительные библиотеки/компоненты (можно позже)?',
    q_zim: 'Скачать офлайн-Википедию (.zim, большой объём)?',
    estimate: 'Будет скачано ~{gb} ГБ, потребуется ~{disk} ГБ на диске. Продолжить?',
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
    need_driver: 'The {what} driver is missing or outdated — this step will require a reboot.',
    q_anonymous: 'Install anonymously (no personal identifiers in project files)?',
    q_libs: 'Download extra libraries/components (can be done later)?',
    q_zim: 'Download the offline Wikipedia (.zim, large)?',
    estimate: 'About {gb} GB will be downloaded, ~{disk} GB of disk needed. Continue?',
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
