// ============================================================
// Cron: обновление views постов
// Endpoint: GET /api/cron-update-views
// Запускается Vercel Cron раз в час
// ============================================================
// Логика:
//   - Берёт все посты канала возрастом < 7 дней
//   - Для каждого делает forwardMessage себе в чат BOT_ADMIN_CHAT_ID
//   - В ответе forwarded есть свежие views
//   - Обновляет views в БД + сохраняет snapshot
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_STATS_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
// Чат куда бот форвардит себе сообщения (обычно это чат @maxvane с ботом)
const BOT_STORAGE_CHAT_ID = process.env.TELEGRAM_STATS_STORAGE_CHAT;
// Защита cron endpoint — чтобы не кто угодно его дёргал
const CRON_SECRET = process.env.CRON_SECRET;

async function supa(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const r = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...options.headers,
    },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Supabase ${r.status}: ${t}`);
  }
  return r.json();
}

async function tgCall(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function forwardAndGetViews(channelTgId, messageId) {
  // Форвардим сообщение в storage-чат. В ответе есть forward_from_message_id + views оригинала
  const result = await tgCall('forwardMessage', {
    chat_id: BOT_STORAGE_CHAT_ID,
    from_chat_id: channelTgId,
    message_id: messageId,
    disable_notification: true,
  });

  if (!result.ok) {
    return { views: null, error: result.description };
  }

  // Чтобы не засорять storage-чат, сразу удаляем
  const forwardedId = result.result.message_id;
  try {
    await tgCall('deleteMessage', {
      chat_id: BOT_STORAGE_CHAT_ID,
      message_id: forwardedId,
    });
  } catch (e) { /* ignore */ }

  // Views при форварде лежат в forward_origin.channel.views или views в самом сообщении
  return { views: result.result.views || null };
}

export default async function handler(req, res) {
  // Авторизация: Vercel Cron шлёт Authorization: Bearer <CRON_SECRET>
  const auth = req.headers['authorization'];
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !BOT_STORAGE_CHAT_ID) {
    return res.status(500).json({ ok: false, error: 'Missing env vars' });
  }

  const results = { updated: 0, errors: 0, skipped: 0 };

  try {
    // Берём посты < 7 дней с последним обновлением > 1 час назад
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const posts = await supa(
      `posts?` +
      `published_at=gte.${sevenDaysAgo}&` +
      `last_views_update=lt.${oneHourAgo}&` +
      `select=id,channel_id,telegram_message_id,views,` +
      `channels!inner(telegram_chat_id)&` +
      `order=last_views_update.asc&` +
      `limit=50`  // не больше 50 за раз, чтобы уложиться в 10сек лимит Vercel
    );

    for (const post of posts) {
      const chatId = post.channels?.telegram_chat_id;
      if (!chatId) {
        results.skipped++;
        continue;
      }

      const { views, error } = await forwardAndGetViews(chatId, post.telegram_message_id);

      if (error || views === null) {
        results.errors++;
        // Пометим что пытались (чтобы не цепляться на этом же посте)
        await supa(`posts?id=eq.${post.id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ last_views_update: new Date().toISOString() }),
        });
        continue;
      }

      // Обновляем views в posts + пишем snapshot
      await supa(`posts?id=eq.${post.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({
          views: views,
          last_views_update: new Date().toISOString(),
        }),
      });

      await supa('post_snapshots', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ post_id: post.id, views }),
      });

      results.updated++;

      // Небольшая пауза между форвардами чтобы не упереться в Telegram rate limit
      await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('Cron error:', err);
    return res.status(500).json({ ok: false, error: String(err), results });
  }
}
