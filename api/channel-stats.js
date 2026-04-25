// ============================================================
// Channel stats API
// GET /api/channel-stats?slug=<slug>
// ============================================================
// Возвращает для канала свежие данные из БД:
//   - основная инфа (подписчики, охват)
//   - последние 10 постов с views
//   - расчёт avg_reach_24h / 48h / 72h
//   - статус бота (подключен/нет)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
// Используем публичный anon ключ для чтения (RLS разрешает)
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function supa(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const r = await fetch(url, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60'); // кеш 1 минута на CDN

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const slug = req.query.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug' });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    // 1. Канал
    const channels = await supa(
      `channels?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`
    );
    if (!channels.length) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    const channel = channels[0];

    // 2. Последние 10 публичных постов (не рекламные)
    let posts = [];
    if (channel.bot_is_admin) {
      posts = await supa(
        `posts?channel_id=eq.${channel.id}&is_ad=eq.false&order=published_at.desc&limit=10`
      );
    }

    // 3. Вычисление avg_reach_* — берём посты старше 24h/48h/72h и смотрим их views
    //    (это views в момент когда пост был этого возраста — приблизительно)
    const now = Date.now();
    const compute = (hours) => {
      const cutoffOld = now - (hours + 72) * 3600 * 1000; // старее N+72ч — значит пост уже "пожил" больше N часов
      const cutoffNew = now - hours * 3600 * 1000;
      const relevant = posts.filter(p => {
        const t = new Date(p.published_at).getTime();
        return t >= cutoffOld && t <= cutoffNew;
      });
      if (!relevant.length) return null;
      const sum = relevant.reduce((s, p) => s + (p.views || 0), 0);
      return Math.round(sum / relevant.length);
    };

    const avg24 = compute(24);
    const avg48 = compute(48);
    const avg72 = compute(72);

    // Итоговый средний охват (все 10 последних)
    const avgReach = posts.length
      ? Math.round(posts.reduce((s, p) => s + (p.views || 0), 0) / posts.length)
      : channel.avg_reach || null;

    // === CPM ===
    // Считаем только для подключённых каналов с реальными данными
    // Формула: цена / охват × 1000
    // Используем avg_reach_24h если есть (точный), иначе avgReach (приближённый)
    let cpm = null;
    let cpmReachUsed = null; // для отладки — какой охват использовали
    const reachForCpm = channel.avg_reach_24h || avgReach;
    const priceForCpm = channel.price_1_24;
    if (channel.bot_is_admin && priceForCpm && reachForCpm && reachForCpm > 0) {
      cpm = Math.round(priceForCpm / reachForCpm * 1000);
      cpmReachUsed = channel.avg_reach_24h ? '24h' : 'avg';
    }

    return res.status(200).json({
      channel: {
        id: channel.id,
        name: channel.name,
        slug: channel.slug,
        subscribers: channel.subscribers,
        avatar_url: channel.avatar_url,
        verified: channel.verified,
        rkn: channel.rkn,
        bot_is_admin: channel.bot_is_admin,
        live: channel.bot_is_admin && posts.length > 0,
        price_1_24: channel.price_1_24,
      },
      stats: {
        avg_reach: avgReach,
        avg_reach_24h: channel.avg_reach_24h || null,
        avg_reach_48h: channel.avg_reach_48h || null,
        avg_reach_72h: channel.avg_reach_72h || null,
        cpm: cpm,
        cpm_basis: cpmReachUsed,
        posts_tracked: posts.length,
      },
      recent_posts: posts.map(p => ({
        id: p.id,
        message_id: p.telegram_message_id,
        text: (p.text || '').substring(0, 300),
        has_media: p.has_media,
        media_type: p.media_type,
        views: p.views,
        published_at: p.published_at,
      })),
    });
  } catch (err) {
    console.error('channel-stats error:', err);
    return res.status(500).json({ error: String(err) });
  }
}
