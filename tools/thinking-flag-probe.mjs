// thinking-flag-probe.mjs -- ЧЕМ У Qwen3.8 ГАСИТСЯ РАЗМЫШЛЕНИЕ: замер, а не чтение карточки.
//
// ЗАЧЕМ. Профиль qwen3.8-27b в llama-swap шлёт `enable_thinking:false` -- ключ, унаследованный от
// Qwen3.6. Карточка 3.8 говорит про `reasoning_effort`. Пока это не проверено, агентский клиент
// рискует получить `reasoning_content` вместо ответа (эстафета STATUS, пункт 0 ③).
//
// ЧТО ДЕЛАЕТ. Гоняет один и тот же вопрос четырьмя способами и печатает для каждого: пришёл ли
// `reasoning_content`, есть ли теги <think> в тексте, сколько токенов потрачено и за сколько секунд.
// Токены -- главная улика: думающая модель тратит их в разы больше на тот же ответ.
//
//   node tools/thinking-flag-probe.mjs
//
// [NOT-TESTED] на момент написания -- прогон и есть проверка.

const BASE = process.env.KLAS_LLM || 'http://127.0.0.1:8080';
const MODEL = 'qwen3.8-27b';
// Вопрос выбран так, чтобы у модели БЫЛ соблазн думать (арифметика в несколько шагов),
// иначе «не думала» ничего не докажет: на тривиальном вопросе не думает никто.
const Q = 'В корзине 3 ящика по 17 яблок и 2 ящика по 24 яблока. Сколько яблок всего? Ответь одним числом.';

// ⚠️ УРОК, ОПЛАЧЕННЫЙ ЗДЕСЬ ЖЕ (2026-08-16, поправка владельца). Первая версия этого файла
// проверяла ТОЛЬКО способы ВЫКЛЮЧИТЬ размышление — и на основании «не думает ни при каком флаге»
// модель ушла на агентный бенч с погашенным рассуждением, набрала 7.2/8.0, и это было записано как
// свойство модели. На самом деле так измерили НАСТРОЙКУ. Рассуждающую модель обязательно мерить
// В ОБЕ СТОРОНЫ: доказательство «выключается» ничего не стоит без доказательства «включается».
const CASES = [
  { name: 'без флагов вовсе', body: {} },
  { name: 'enable_thinking:false (как в конфиге сейчас)', body: { chat_template_kwargs: { enable_thinking: false } } },
  { name: 'reasoning_effort:none (карточка 3.8)', body: { reasoning_effort: 'none' } },
  { name: 'reasoning_effort:low', body: { reasoning_effort: 'low' } },
  // ─── ВКЛЮЧИТЬ. Ради этих строк файл и переписан.
  { name: '⭐ enable_thinking:TRUE', body: { chat_template_kwargs: { enable_thinking: true } } },
  { name: '⭐ reasoning_effort:medium', body: { reasoning_effort: 'medium' } },
  { name: '⭐ reasoning_effort:high', body: { reasoning_effort: 'high' } },
];

async function ask(extra) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: Q }],
      max_tokens: 2048,
      ...extra,
    }),
  });
  const sec = (Date.now() - t0) / 1000;
  if (!res.ok) return { err: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, sec };
  const j = await res.json();
  const m = j.choices?.[0]?.message ?? {};
  return {
    sec,
    text: (m.content ?? '').trim(),
    reasoning: (m.reasoning_content ?? '').trim(),
    // Некоторые сборки не отдают поле, а вклеивают теги прямо в текст -- ловим оба случая.
    hasTags: /<think>/i.test(m.content ?? ''),
    tokens: j.usage?.completion_tokens ?? -1,
  };
}

console.log(`Модель ${MODEL} на ${BASE}. Первый вызов включает холодную загрузку -- это нормально.\n`);
for (const c of CASES) {
  let r;
  try { r = await ask(c.body); } catch (e) { r = { err: String(e.message || e), sec: 0 }; }
  console.log(`── ${c.name}`);
  if (r.err) { console.log(`   ОШИБКА: ${r.err}\n`); continue; }
  console.log(`   время ${r.sec.toFixed(1)} с · токенов ответа ${r.tokens}`);
  console.log(`   reasoning_content: ${r.reasoning ? `ЕСТЬ (${r.reasoning.length} симв)` : 'нет'}` +
              ` · теги <think> в тексте: ${r.hasTags ? 'ЕСТЬ' : 'нет'}`);
  console.log(`   ответ: ${JSON.stringify(r.text.slice(0, 120))}\n`);
}
console.log('Верный ответ: 99. Гашение сработало там, где токенов ответа меньше всего И нет ни поля, ни тегов.');
