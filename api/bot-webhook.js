// ============================================================
// Telegram Stats Bot — webhook handler
// Endpoint: POST /api/bot-webhook
// ============================================================
// Принимает события от Telegram Bot API:
//   - /start (личные сообщения) — приветствие
//   - /claim VLT-XXXX — привязка канала к записи на сайте
//   - my_chat_member — бот добавлен/удалён из канала
//   - channel_post — новый пост в подключённом канале
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_STATS_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Секретный токен для проверки что запрос от Telegram (задаётся при setWebhook)
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

// Список ID модераторов (через запятую). Только они могут одобрять/отклонять каналы.
// Берём из MODERATOR_IDS, или если не задано — из STORAGE_CHAT
const MODERATOR_IDS = (process.env.MODERATOR_TELEGRAM_IDS || process.env.TELEGRAM_STATS_STORAGE_CHAT || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => parseInt(s));

// =======================================================
// Supabase REST helpers (без sdk, чтобы не тащить npm)
// =======================================================

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
  const text = await r.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function findChannelByClaimCode(code) {
  const data = await supa(`channels?claim_code=eq.${encodeURIComponent(code)}&select=*`);
  return data[0];
}

async function findChannelByTgId(chatId) {
  const data = await supa(`channels?telegram_chat_id=eq.${chatId}&select=*`);
  return data[0];
}

async function updateChannel(id, fields) {
  return supa(`channels?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

async function insertPost(post) {
  // upsert на случай если пост уже был
  return supa(`posts?on_conflict=channel_id,telegram_message_id`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify(post),
  });
}

// =======================================================
// Telegram API helpers
// =======================================================

async function tgCall(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!text) return { ok: false, description: `Empty response (HTTP ${r.status})` };
    try {
      return JSON.parse(text);
    } catch (e) {
      return { ok: false, description: `Invalid JSON: ${text.substring(0, 100)}` };
    }
  } catch (err) {
    return { ok: false, description: `Network error: ${err.message}` };
  }
}

function sendMessage(chatId, text, extra = {}) {
  return tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

// =======================================================
// Обработчики событий
// =======================================================

async function handleStart(message) {
  const chatId = message.chat.id;
  const name = message.from?.first_name || 'друг';
  const username = message.from?.username;

  // Пытаемся найти pending-заявку этого пользователя по @username и привязать chat_id
  // Это нужно чтобы при одобрении мы могли отправить ему уведомление
  if (username) {
    try {
      // Ищем pending каналы где submitted_by_telegram = "@username" или "username"
      const pending = await supa(
        `channels?status=eq.pending&or=(submitted_by_telegram.ilike.@${username},submitted_by_telegram.ilike.${username})&select=id&author_telegram_chat_id=is.null`
      );
      if (pending && pending.length) {
        for (const ch of pending) {
          await updateChannel(ch.id, { author_telegram_chat_id: chatId });
        }
      }
    } catch (e) {
      console.error('Failed to link author chat_id on /start:', e);
    }
  }

  await sendMessage(chatId,
    `👋 Привет, ${escapeHtml(name)}!\n\n` +
    `Я бот Vault для сбора live-статистики Telegram-каналов.\n\n` +
    `<b>Как подключить канал:</b>\n` +
    `1. Откройте ваш канал → Настройки → Администраторы\n` +
    `2. Добавьте меня (<code>@vault_analytics_bot</code>) как админа\n` +
    `3. Дайте мне право <b>«Чтение истории»</b> (остальные не нужны)\n` +
    `4. Вернитесь сюда и пришлите команду:\n` +
    `<code>/claim ВАШ_КОД</code>\n\n` +
    `Код выдаётся при регистрации канала на <a href="https://vaultads.ru/authors">vaultads.ru/authors</a>\n\n` +
    `❓ Если нужна помощь — напишите @maxvane`
  );
}

async function handleClaim(message, code) {
  const userId = message.from.id;
  const chatId = message.chat.id;

  if (!code || !code.match(/^VLT-[A-Z0-9]{4,6}$/i)) {
    await sendMessage(chatId, '⚠️ Неправильный формат кода. Должно быть: <code>/claim VLT-ABCD</code>');
    return;
  }

  const channel = await findChannelByClaimCode(code.toUpperCase());

  if (!channel) {
    await sendMessage(chatId,
      `❌ Код <code>${escapeHtml(code)}</code> не найден.\n\n` +
      `Проверьте написание или получите новый код на <a href="https://vaultads.ru/authors">vaultads.ru/authors</a>`
    );
    return;
  }

  if (channel.claimed_at) {
    await sendMessage(chatId,
      `⚠️ Этот код уже использован для канала <b>${escapeHtml(channel.name)}</b>.\n\n` +
      `Если это был не вы — свяжитесь с @maxvane`
    );
    return;
  }

  if (!channel.telegram_chat_id) {
    await sendMessage(chatId,
      `⚠️ Сначала добавьте меня админом в ваш канал — <b>${escapeHtml(channel.name)}</b>.\n\n` +
      `Потом повторите команду <code>/claim ${code}</code>`
    );
    return;
  }

  // Проверяем что user действительно админ того канала
  try {
    const admins = await tgCall('getChatAdministrators', { chat_id: channel.telegram_chat_id });
    if (!admins.ok) {
      await sendMessage(chatId, '❌ Не удалось проверить, что вы админ канала. Попробуйте позже.');
      return;
    }
    const isAdmin = admins.result.some(a => a.user?.id === userId);
    if (!isAdmin) {
      await sendMessage(chatId, '❌ Вы не являетесь админом этого канала. Привязку может сделать только админ.');
      return;
    }
  } catch (e) {
    await sendMessage(chatId, '❌ Ошибка проверки прав. Попробуйте позже.');
    return;
  }

  // Всё ок, привязываем
  await updateChannel(channel.id, {
    claimed_at: new Date().toISOString(),
    owner_telegram_id: userId,
    author_telegram_chat_id: chatId, // сохраняем для будущих уведомлений
    verified: true,
  });

  await sendMessage(chatId,
    `✅ <b>Канал успешно привязан!</b>\n\n` +
    `<b>${escapeHtml(channel.name)}</b> теперь имеет статус <b>«⚡ Live Stats»</b> на сайте.\n\n` +
    `Ваши посты автоматически попадают в статистику, а актуальные охваты обновляются каждый час.\n\n` +
    `Посмотреть канал: https://vaultads.ru/channel/${channel.slug}`
  );
}

async function handleMyChatMember(update) {
  // Вызывается когда бот добавлен/удалён/изменены права в канале
  const mcm = update.my_chat_member;
  const chat = mcm.chat;
  const newStatus = mcm.new_chat_member?.status;
  const oldStatus = mcm.old_chat_member?.status;

  if (chat.type !== 'channel') return; // только каналы

  const chatId = chat.id;
  const chatTitle = chat.title;
  const username = chat.username || null;

  // Бот добавлен админом
  if (newStatus === 'administrator' && oldStatus !== 'administrator') {
    // Проверяем, есть ли уже этот канал в нашей базе (по telegram_chat_id или username)
    let channel = await findChannelByTgId(chatId);

    if (!channel && username) {
      // Может быть в базе по username (если канал публичный из наших 99)
      const link = `https://t.me/${username}`;
      const byLink = await supa(`channels?link=ilike.${encodeURIComponent('%' + username + '%')}&select=*`);
      if (byLink.length) {
        channel = byLink[0];
        // Привязываем telegram_chat_id
        await updateChannel(channel.id, {
          telegram_chat_id: chatId,
          bot_connected_at: new Date().toISOString(),
          bot_is_admin: true,
        });
      }
    }

    if (!channel) {
      // Новый канал — создаём запись
      const newCh = await supa('channels', {
        method: 'POST',
        body: JSON.stringify({
          name: chatTitle,
          username: username,
          link: username ? `https://t.me/${username}` : null,
          telegram_chat_id: chatId,
          bot_connected_at: new Date().toISOString(),
          bot_is_admin: true,
          topic: 'other',
          topic_label: 'Другое',
        }),
      });
      channel = newCh[0];
    } else {
      await updateChannel(channel.id, {
        bot_is_admin: true,
        telegram_chat_id: chatId,
        bot_connected_at: channel.bot_connected_at || new Date().toISOString(),
      });
    }

    // Отправляем сообщение тому, кто добавил бота
    const addedBy = mcm.from?.id;
    if (addedBy) {
      try {
        if (channel.claim_code && !channel.claimed_at) {
          await sendMessage(addedBy,
            `✅ Спасибо, что добавили меня в канал <b>${escapeHtml(chatTitle)}</b>!\n\n` +
            `Чтобы привязать канал к вашей учётке на Vault, пришлите команду:\n` +
            `<code>/claim ${channel.claim_code}</code>`
          );
        } else {
          await sendMessage(addedBy,
            `✅ Канал <b>${escapeHtml(chatTitle)}</b> подключён.\n\n` +
            `Я буду собирать статистику: подписчики, просмотры постов, динамика охвата.`
          );
        }
      } catch (e) {
        // Пользователь не начинал диалог с ботом — ничего, ок
      }
    }
  }

  // Бот удалён
  if ((newStatus === 'left' || newStatus === 'kicked') && oldStatus === 'administrator') {
    const channel = await findChannelByTgId(chatId);
    if (channel) {
      await updateChannel(channel.id, { bot_is_admin: false });
    }
  }
}

async function handleChannelPost(update) {
  // Новый пост опубликован в канале где бот-админ
  const post = update.channel_post;
  const chat = post.chat;
  const messageId = post.message_id;

  if (chat.type !== 'channel') return;

  const channel = await findChannelByTgId(chat.id);
  if (!channel) return; // не в нашей базе — игнорируем

  const text = post.text || post.caption || '';
  const hasMedia = !!(post.photo || post.video || post.document || post.animation);
  const mediaType = post.photo ? 'photo'
                  : post.video ? 'video'
                  : post.document ? 'document'
                  : post.animation ? 'animation'
                  : null;

  const publishedAt = new Date(post.date * 1000).toISOString();

  await insertPost({
    channel_id: channel.id,
    telegram_message_id: messageId,
    text: text.substring(0, 2000), // ограничим длину
    has_media: hasMedia,
    media_type: mediaType,
    views: post.views || 0,
    published_at: publishedAt,
  });

  // Обновим текущее число подписчиков у канала
  try {
    const r = await tgCall('getChatMemberCount', { chat_id: chat.id });
    if (r.ok) {
      await updateChannel(channel.id, { subscribers: r.result });
    }
  } catch (e) { /* ignore */ }
}

async function handleEditedChannelPost(update) {
  // Когда пост отредактирован — обновим views (они там свежие)
  const post = update.edited_channel_post;
  if (!post || post.chat?.type !== 'channel') return;

  const channel = await findChannelByTgId(post.chat.id);
  if (!channel) return;

  if (post.views) {
    // Обновим views в posts
    await supa(`posts?channel_id=eq.${channel.id}&telegram_message_id=eq.${post.message_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        views: post.views,
        last_views_update: new Date().toISOString(),
      }),
    });
    // И снапшот
    const posts = await supa(`posts?channel_id=eq.${channel.id}&telegram_message_id=eq.${post.message_id}&select=id`);
    if (posts[0]) {
      await supa('post_snapshots', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ post_id: posts[0].id, views: post.views }),
      });
    }
  }
}

// =======================================================
// МОДЕРАЦИЯ КАНАЛОВ
// =======================================================

// Простое хранилище состояний "модератор ожидает ввод причины отклонения"
// На serverless оно не персистится между вызовами, поэтому используем БД.
// Запишем pending state в саму запись канала (поле pending_rejection_by)

async function handleModerationCallback(query) {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data; // mod:approve:123 или mod:reject:123

  // Проверка прав
  if (!MODERATOR_IDS.includes(userId)) {
    await tgCall('answerCallbackQuery', {
      callback_query_id: query.id,
      text: '❌ У вас нет прав на модерацию',
      show_alert: true,
    });
    return;
  }

  const parts = data.split(':');
  const action = parts[1];
  const channelId = parseInt(parts[2]);

  if (!action || !channelId) {
    await tgCall('answerCallbackQuery', { callback_query_id: query.id, text: 'Неверный формат' });
    return;
  }

  // Найдём канал
  const channels = await supa(`channels?id=eq.${channelId}&select=*&limit=1`);
  if (!channels || !channels.length) {
    await tgCall('answerCallbackQuery', {
      callback_query_id: query.id,
      text: '❌ Канал не найден',
      show_alert: true,
    });
    return;
  }
  const channel = channels[0];

  if (channel.status !== 'pending') {
    await tgCall('answerCallbackQuery', {
      callback_query_id: query.id,
      text: `Канал уже обработан (статус: ${channel.status})`,
      show_alert: true,
    });
    return;
  }

  if (action === 'approve') {
    // ⚠️ Проверяем: бот должен быть админом в канале
    if (!channel.bot_is_admin || !channel.telegram_chat_id) {
      await tgCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: '⚠️ Бот не добавлен в канал. Попросите автора добавить @vault_analytics_bot админом, потом одобрите снова',
        show_alert: true,
      });
      return;
    }

    // Одобряем канал
    await updateChannel(channel.id, {
      status: 'approved',
      moderated_at: new Date().toISOString(),
      moderated_by: userId,
    });

    await tgCall('answerCallbackQuery', {
      callback_query_id: query.id,
      text: '✅ Канал одобрен',
    });

    // Обновляем сообщение с новой меткой
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: query.message.text + '\n\n✅ <b>ОДОБРЕНО</b>',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌐 Открыть на сайте', url: `https://vaultads.ru/channel/${channel.slug}` }],
        ],
      },
    });

    // === АВТО-УВЕДОМЛЕНИЕ АВТОРУ ===
    let authorNotified = false;
    const authorChatId = channel.author_telegram_chat_id || channel.owner_telegram_id;
    if (authorChatId) {
      try {
        const notifyResult = await tgCall('sendMessage', {
          chat_id: authorChatId,
          text:
            `🎉 <b>Ваш канал одобрен!</b>\n\n` +
            `Канал <b>${escapeHtml(channel.name)}</b> опубликован в каталоге Vault.\n\n` +
            `🔗 Страница канала на сайте:\n` +
            `https://vaultads.ru/channel/${channel.slug}\n\n` +
            `📊 Бот уже подключён к каналу — live-статистика начнёт появляться после первых публикаций.\n\n` +
            `❓ Вопросы — пишите @maxvane`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        if (notifyResult.ok) {
          authorNotified = true;
        }
      } catch (e) {
        console.error('Failed to notify author:', e);
      }
    }

    // Сообщение модератору о результате
    if (channel.submitted_by_telegram) {
      const userMention = channel.submitted_by_telegram.startsWith('@')
        ? channel.submitted_by_telegram
        : '@' + channel.submitted_by_telegram;

      const modMessage = authorNotified
        ? `✅ Автор <b>${escapeHtml(userMention)}</b> уведомлён в личке об одобрении.`
        : `⚠️ Не удалось автоматически уведомить автора <b>${escapeHtml(userMention)}</b> — он не нажимал /start у бота.\n\n` +
          `Скопируйте и отправьте ему вручную:\n\n` +
          `<i>Канал <b>${escapeHtml(channel.name)}</b> одобрен!\n` +
          `Страница: vaultads.ru/channel/${channel.slug}\n` +
          `Бот уже подключён, live-статистика будет появляться после публикаций.</i>`;

      await tgCall('sendMessage', {
        chat_id: chatId,
        text: modMessage,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    }
  } else if (action === 'reject') {
    // Запрашиваем причину отклонения
    // Помечаем что мы ждём ввод причины от этого модератора
    await updateChannel(channel.id, {
      status: 'awaiting_rejection_reason',
      moderated_by: userId,
    });

    await tgCall('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Пришлите причину следующим сообщением',
    });

    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: query.message.text + '\n\n⏳ <b>Ожидаю причину отклонения...</b>\nПросто пришлите её следующим сообщением',
      parse_mode: 'HTML',
    });
  }
}

async function handleRejectionReason(message) {
  const userId = message.from.id;
  const text = message.text || '';

  // Найдём канал ожидающий причины от этого модератора
  const channels = await supa(
    `channels?status=eq.awaiting_rejection_reason&moderated_by=eq.${userId}&select=*&order=submitted_at.desc&limit=1`
  );

  if (!channels || !channels.length) return false; // не наш случай

  const channel = channels[0];
  const reason = text.substring(0, 500);

  // Сохраняем отклонение
  await updateChannel(channel.id, {
    status: 'rejected',
    moderated_at: new Date().toISOString(),
    rejection_reason: reason,
  });

  // === АВТО-УВЕДОМЛЕНИЕ АВТОРУ ===
  let authorNotified = false;
  const authorChatId = channel.author_telegram_chat_id || channel.owner_telegram_id;
    if (authorChatId) {
    try {
      const notifyResult = await tgCall('sendMessage', {
        chat_id: authorChatId,
        text:
          `❌ <b>Заявка отклонена</b>\n\n` +
          `К сожалению, ваш канал <b>${escapeHtml(channel.name)}</b> не прошёл модерацию.\n\n` +
          `<b>Причина:</b>\n${escapeHtml(reason)}\n\n` +
          `Если хотите обсудить — пишите @maxvane`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      if (notifyResult.ok) {
        authorNotified = true;
      }
    } catch (e) {
      console.error('Failed to notify author about rejection:', e);
    }
  }

  // Сообщение модератору
  const modMessage = authorNotified
    ? `❌ Канал <b>${escapeHtml(channel.name)}</b> отклонён.\n\n` +
      `<b>Причина:</b> ${escapeHtml(reason)}\n\n` +
      `✅ Автор уведомлён в личке.`
    : `❌ Канал <b>${escapeHtml(channel.name)}</b> отклонён.\n\n` +
      `<b>Причина:</b> ${escapeHtml(reason)}\n\n` +
      (channel.submitted_by_telegram
        ? `⚠️ Не забудьте написать автору ${escapeHtml(channel.submitted_by_telegram)} с причиной отказа — он не нажимал /start у бота.`
        : '');

  await sendMessage(message.chat.id, modMessage);

  return true;
}

// =======================================================
// MAIN HANDLER
// =======================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Проверка секрета из заголовка (Telegram шлёт X-Telegram-Bot-Api-Secret-Token)
  if (WEBHOOK_SECRET) {
    const sentSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (sentSecret !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: 'Invalid secret' });
    }
  }

  if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  const update = req.body;

  try {
    // 0. Callback от inline-кнопок (модерация)
    if (update.callback_query && update.callback_query.data?.startsWith('mod:')) {
      await handleModerationCallback(update.callback_query);
      return res.status(200).json({ ok: true });
    }

    // 1. Личные сообщения от юзера
    if (update.message) {
      const msg = update.message;
      const text = msg.text || '';

      if (msg.chat.type === 'private') {
        // Сначала проверяем — может быть это причина отклонения от модератора
        if (MODERATOR_IDS.includes(msg.from.id) && !text.startsWith('/')) {
          const handled = await handleRejectionReason(msg);
          if (handled) return res.status(200).json({ ok: true });
        }

        if (text.startsWith('/start')) {
          await handleStart(msg);
        } else if (text.startsWith('/claim')) {
          const parts = text.trim().split(/\s+/);
          const code = parts[1];
          await handleClaim(msg, code);
        } else if (text.startsWith('/help')) {
          await sendMessage(msg.chat.id,
            `<b>Команды:</b>\n` +
            `/start — начать\n` +
            `/claim VLT-XXXX — привязать канал\n` +
            `/help — эта справка\n\n` +
            `Вопросы: @maxvane`
          );
        } else {
          await sendMessage(msg.chat.id,
            `Не понимаю. Напишите /help чтобы увидеть список команд.`
          );
        }
      }
    }

    // 2. Изменения членства бота (добавили/удалили из канала)
    if (update.my_chat_member) {
      await handleMyChatMember(update);
    }

    // 3. Новый пост в канале
    if (update.channel_post) {
      await handleChannelPost(update);
    }

    // 4. Отредактированный пост (обновление views)
    if (update.edited_channel_post) {
      await handleEditedChannelPost(update);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Bot webhook error:', err);
    // Telegram повторяет webhook, если вернуть не 200 — так что возвращаем 200 всегда
    return res.status(200).json({ ok: false, error: String(err) });
  }
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
