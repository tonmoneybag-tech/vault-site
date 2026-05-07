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
    // Берём ВСЕ одобренные каналы — и из миграции (с site_id), и новые (без)
    const channels = await supa(
      `channels?status=eq.approved&select=id,site_id,slug,name,topic,topic_label,platform,bot_is_admin,subscribers,avg_reach,avg_reach_24h,avatar_url,price_1_24,price_2_48,price_3_72,link,rkn,verified`
    );

    // Преобразуем в map по site_id для быстрого доступа в каталоге
    const byId = {};
    // Также собираем список новых каналов (без site_id) — они появились через форму
    const newChannels = [];

    for (const ch of channels) {
      // CPM считаем только если бот подключён
      let cpm = null;
      if (ch.bot_is_admin && ch.price_1_24) {
        const reach = ch.avg_reach_24h || ch.avg_reach;
        if (reach && reach > 0) {
          cpm = Math.round(ch.price_1_24 / reach * 1000);
        }
      }

      const summary = {
        slug: ch.slug,
        platform: ch.platform || 'telegram',
        bot: !!ch.bot_is_admin,
        subscribers: ch.subscribers || null,
        avg_reach: ch.avg_reach || null,
        cpm: cpm,
        avatar_url: ch.avatar_url || null,
        price_1_24: ch.price_1_24 || null,
        price_2_48: ch.price_2_48 || null,
        price_3_72: ch.price_3_72 || null,
      };

      if (ch.site_id) {
        // Старый канал из миграции — индексируем по site_id
        byId[ch.site_id] = summary;
      } else {
        // Новый канал — добавляем в список с полной инфой
        newChannels.push({
          id: ch.id,
          slug: ch.slug,
          name: ch.name,
          topic: ch.topic,
          topic_label: ch.topic_label,
          subs: ch.subscribers || 0,
          reach: ch.avg_reach || 0,
          price: ch.price_1_24 || 0,
          price_2_48: ch.price_2_48,
          price_3_72: ch.price_3_72,
          link: ch.link,
          rkn: ch.rkn,
          verified: ch.verified,
          bot: !!ch.bot_is_admin,
          avatar_url: ch.avatar_url,
          cpm: cpm,
        });
      }
    }

    return res.status(200).json({ channels: byId, new_channels: newChannels });
  } catch (err) {
    console.error('channels-summary error:', err);
    return res.status(500).json({ error: String(err) });
  }
}
