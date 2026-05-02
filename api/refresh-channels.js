// ============================================================
// Manual refresh endpoint
// GET /api/refresh-channels?token=CRON_SECRET
// ============================================================
// Обновляет данные всех подключённых каналов:
//   - subscribers (через getChatMemberCount)
//   - аватар (через getChat + getFile)
//   - views последних постов (через forwardMessage trick)
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_STATS_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_STORAGE_CHAT_ID = process.env.TELEGRAM_STATS_STORAGE_CHAT;
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
  // При prefer=return=minimal Supabase возвращает пустое тело — это норма
  const text = await r.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function tgCall(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!text) {
      return { ok: false, description: `Empty response (HTTP ${r.status})` };
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      return { ok: false, description: `Invalid JSON: ${text.substring(0, 100)}` };
    }
  } catch (err) {
    return { ok: false, description: `Network error: ${err.message}` };
  }
}

export default async function handler(req, res) {
  // Проверка авторизации (через query token, чтобы можно было запустить из браузера)
  const token = req.query.token || req.headers['authorization']?.replace('Bearer ', '');
  if (CRON_SECRET && token !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized. Add ?token=YOUR_CRON_SECRET' });
  }

  if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'Missing env vars' });
  }

  const results = {
    bot_check: null,
    channels_processed: 0,
    subscribers_updated: 0,
    views_updated: 0,
    avatars_attempted: 0,
    errors: [],
  };

  try {
    // 0. Проверяем что бот вообще работает
    const me = await tgCall('getMe', {});
    if (!me.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Bot token not working',
        details: me.description,
        bot_token_set: !!BOT_TOKEN,
        bot_token_length: BOT_TOKEN ? BOT_TOKEN.length : 0,
      });
    }
    results.bot_check = { username: me.result.username, id: me.result.id };

    // 1. Берём все подключённые каналы
    const channels = await supa(
      `channels?bot_is_admin=eq.true&telegram_chat_id=not.is.null&select=id,name,telegram_chat_id,subscribers,avatar_url`
    );

    for (const ch of channels) {
      results.channels_processed++;

      // 1a. Обновляем subscribers
      try {
        const r = await tgCall('getChatMemberCount', { chat_id: ch.telegram_chat_id });
        if (r.ok && r.result) {
          if (r.result !== ch.subscribers) {
            await supa(`channels?id=eq.${ch.id}`, {
              method: 'PATCH',
              prefer: 'return=minimal',
              body: JSON.stringify({ subscribers: r.result }),
            });
            results.subscribers_updated++;
          }
        } else if (!r.ok) {
          results.errors.push(`getChatMemberCount(${ch.name}): ${r.description}`);
        }
      } catch (e) {
        results.errors.push(`subscribers(${ch.name}): ${e.message}`);
      }

      // 1b. Обновляем views последних 20 постов через forwardMessage
      // Пропускаем посты помеченные как views_locked=true (недоступные)
      const posts = await supa(
        `posts?channel_id=eq.${ch.id}&views_locked=eq.false&order=published_at.desc&limit=20&select=id,telegram_message_id,views`
      );

      for (const post of posts) {
        if (!BOT_STORAGE_CHAT_ID) break; // нечем форвардить

        try {
          const fwd = await tgCall('forwardMessage', {
            chat_id: BOT_STORAGE_CHAT_ID,
            from_chat_id: ch.telegram_chat_id,
            message_id: post.telegram_message_id,
            disable_notification: true,
          });

          if (fwd.ok && fwd.result) {
            const newViews = fwd.result.views || 0;

            // Удаляем форвард чтобы не засорять чат
            try {
              await tgCall('deleteMessage', {
                chat_id: BOT_STORAGE_CHAT_ID,
                message_id: fwd.result.message_id,
              });
            } catch (e) { /* ignore */ }

            if (newViews !== post.views) {
              await supa(`posts?id=eq.${post.id}`, {
                method: 'PATCH',
                prefer: 'return=minimal',
                body: JSON.stringify({
                  views: newViews,
                  last_views_update: new Date().toISOString(),
                }),
              });

              await supa('post_snapshots', {
                method: 'POST',
                prefer: 'return=minimal',
                body: JSON.stringify({ post_id: post.id, views: newViews }),
              });

              results.views_updated++;
            }
          } else if (!fwd.ok) {
            // Если пост недоступен (удалён, бот потерял права) — помечаем чтобы пропускать в будущем
            const desc = (fwd.description || '').toLowerCase();
            const isPostUnavailable = desc.includes('message to forward not found')
              || desc.includes('message_id_invalid')
              || desc.includes('chat not found');
            if (isPostUnavailable) {
              try {
                await supa(`posts?id=eq.${post.id}`, {
                  method: 'PATCH',
                  prefer: 'return=minimal',
                  body: JSON.stringify({ views_locked: true }),
                });
              } catch (e) { /* ignore */ }
              // Не записываем в errors — это ожидаемая ситуация
            } else {
              results.errors.push(`forwardMessage(${ch.name}, msg ${post.telegram_message_id}): ${fwd.description}`);
            }
          }
        } catch (e) {
          results.errors.push(`fwd(${ch.name}): ${e.message}`);
        }

        // Небольшая пауза, чтоб не упереться в rate limit Telegram
        await new Promise(r => setTimeout(r, 200));
      }

      // 1c. Аватар канала
      results.avatars_attempted++;
      try {
        const chatInfo = await tgCall('getChat', { chat_id: ch.telegram_chat_id });
        if (chatInfo.ok && chatInfo.result?.photo?.big_file_id) {
          // У канала есть фото — ставим прокси-URL
          const proxyUrl = `/api/channel-avatar?id=${ch.id}`;
          if (ch.avatar_url !== proxyUrl) {
            await supa(`channels?id=eq.${ch.id}`, {
              method: 'PATCH',
              prefer: 'return=minimal',
              body: JSON.stringify({ avatar_url: proxyUrl }),
            });
          }
        } else if (chatInfo.ok && !chatInfo.result?.photo) {
          // У канала нет аватара — обнуляем
          if (ch.avatar_url) {
            await supa(`channels?id=eq.${ch.id}`, {
              method: 'PATCH',
              prefer: 'return=minimal',
              body: JSON.stringify({ avatar_url: null }),
            });
          }
        } else if (!chatInfo.ok) {
          results.errors.push(`getChat(${ch.name}): ${chatInfo.description}`);
        }
      } catch (e) {
        results.errors.push(`avatar(${ch.name}): ${e.message}`);
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('refresh-channels error:', err);
    return res.status(500).json({ ok: false, error: String(err), results });
  }
}
