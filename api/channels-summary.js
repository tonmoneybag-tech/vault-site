// ============================================================
// Channels summary API — для каталога
// GET /api/channels-summary
// ============================================================
// Возвращает компактный список всех каналов с live-статусами.
// Используется на странице каталога для одного запроса вместо 99.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function supa(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  const text = await r.text();
  if (!text) return [];
  try { return JSON.parse(text); } catch (e) { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Misconfigured' });
  }

  try {
    const channels = await supa(
      `channels?select=site_id,slug,bot_is_admin,subscribers,avg_reach,avg_reach_24h,avatar_url,price_1_24&site_id=not.is.null`
    );

    // Преобразуем в map по site_id для быстрого доступа
    const byId = {};
    for (const ch of channels) {
      // CPM считаем только если бот подключён
      let cpm = null;
      if (ch.bot_is_admin && ch.price_1_24) {
        const reach = ch.avg_reach_24h || ch.avg_reach;
        if (reach && reach > 0) {
          cpm = Math.round(ch.price_1_24 / reach * 1000);
        }
      }
      byId[ch.site_id] = {
        slug: ch.slug,
        bot: !!ch.bot_is_admin,
        subscribers: ch.subscribers || null,
        avg_reach: ch.avg_reach || null,
        cpm: cpm,
        avatar_url: ch.avatar_url || null,
      };
    }

    return res.status(200).json({ channels: byId });
  } catch (err) {
    console.error('channels-summary error:', err);
    return res.status(500).json({ error: String(err) });
  }
}
