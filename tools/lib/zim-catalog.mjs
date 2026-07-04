// tools/lib/zim-catalog.mjs — каталог баз знаний Kiwix (план 05, идея 12).
// Тянет официальный OPDS-каталог library.kiwix.org: название, описание, язык, размер, URL .zim.
// Пользователь в мастере отмечает нужные — они скачиваются в kiwixdb/ (kiwix их сам подхватит).

const CATALOG = 'https://library.kiwix.org/catalog/v2/entries';

function decode(s = '') {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// Получить список доступных .zim. opts: { lang, query, count }. Возвращает [{id,title,summary,lang,
// articleCount, sizeBytes, url, file}]. url — прямой .zim (без .meta4).
export async function fetchZimCatalog({ lang, query, count = 50 } = {}) {
  const p = new URLSearchParams();
  if (lang) p.set('lang', lang);            // ISO-639-3: rus/eng
  if (query) p.set('q', query);
  p.set('count', String(count));
  const res = await fetch(`${CATALOG}?${p}`, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`каталог Kiwix HTTP ${res.status}`);
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const link = e.match(/<link[^>]*acquisition\/open-access[^>]*href="([^"]+)"[^>]*length="(\d+)"/);
    if (!link) continue;                    // не-скачиваемая запись — пропуск
    const url = link[1].replace(/\.meta4$/, '');
    const g = (re) => (e.match(re) || [])[1];
    out.push({
      id: g(/<name>([^<]+)<\/name>/),
      title: decode(g(/<title>([^<]+)<\/title>/) || ''),
      summary: decode(g(/<summary>([^<]*)<\/summary>/) || ''),
      lang: g(/<language>([^<]+)<\/language>/) || '',
      articleCount: Number(g(/<articleCount>(\d+)<\/articleCount>/) || 0),
      sizeBytes: Number(link[2]),
      url,
      file: decodeURIComponent(url.split('/').pop()),
    });
  }
  return out;
}
