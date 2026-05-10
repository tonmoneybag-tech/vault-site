// ============================================================
// Submit channel for moderation
// POST /api/submit-channel
// ============================================================
// Принимает заявку с формы /authors:
//   - Создаёт запись в БД со статусом 'pending'
//   - Генерирует claim_code
//   - Отправляет уведомление модератору в Telegram
//   - Возвращает claim-код автору
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = process.env.TELEGRAM_STATS_BOT_TOKEN;
const MODERATOR_CHAT_ID = process.env.TELEGRAM_STATS_STORAGE_CHAT; // куда слать на модерацию

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
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function tgCall(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!text) return { ok: false, description: `Empty response (${r.status})` };
    try { return JSON.parse(text); } catch (e) { return { ok: false, description: `Invalid JSON` }; }
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = String(s || '');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Извлекаем username из ссылки t.me/...
function extractUsername(link, platform = 'telegram') {
  if (!link) return null;
  if (platform === 'max') {
    const match = link.match(/(?:max\.ru|oneme\.ru)\/([a-zA-Z0-9_]+)/);
    return match ? match[1] : null;
  }
  if (link.includes('/+') || link.includes('/joinchat/')) return null;
  const match = link.match(/t\.me\/([a-zA-Z0-9_]+)/);
  return match ? match[1] : null;
}

// Slug из имени канала (для URL /channel/xxx)
function slugify(name) {
  const translit = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
    'з':'z','и':'i','й':'i','к':'k','л':'l','м':'m','н':'n','о':'o',
    'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts',
    'ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
  };
  return name
    .toLowerCase()
    .replace(/[а-яё]/g, c => translit[c] || c)
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

const TOPIC_LABELS = {
  'gaming': 'Игровые',
  'sports': 'Спорт',
  'crypto': 'Крипта',
  'tech': 'Технологии и ИИ',
  'regional': 'Региональные',
  'travel': 'Путешествия',
  'minecraft': 'Minecraft',
  'streamers': 'Стримеры и блогеры',
  'economy': 'Экономика',
  'marketing': 'Маркетинг',
  'business': 'Бизнес',
  'auto': 'Авто',
  'news': 'Новости и СМИ',
  'cinema': 'Кино',
  'blog': 'Блог',
  'betting': 'Беттинг',
  'other': 'Другое',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !BOT_TOKEN) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    const body = req.body;
    if (!body) return res.status(400).json({ error: 'No body' });

    // Валидация
    const channelLink = (body.channel_link || '').trim();
    const channelName = (body.channel_name || '').trim();
    const topic = (body.topic || 'other').trim();
    const platform = (body.platform === 'max' ? 'max' : 'telegram');
    const price124 = parseInt(body.price_1_24) || 0;
    const price248 = parseInt(body.price_2_48) || null;
    const price372 = parseInt(body.price_3_72) || null;
    const subscribers = parseInt(body.subscribers) || 0;
    const description = (body.description || '').trim();
    const submitterTelegram = (body.submitter_telegram || '').trim();
    const customLogoUrl = (body.logo_url || '').trim() || null;

    if (!channelLink || !channelName || !submitterTelegram) {
      return res.status(400).json({ error: 'Заполните все обязательные поля' });
    }

    // Валидация ссылки в зависимости от платформы
    if (platform === 'telegram' && !channelLink.includes('t.me/')) {
      return res.status(400).json({ error: 'Для Telegram ссылка должна быть на t.me' });
    }
    if (platform === 'max' && !channelLink.includes('max.ru') && !channelLink.includes('oneme.ru')) {
      return res.status(400).json({ error: 'Для MAX ссылка должна быть на max.ru или oneme.ru' });
    }

    // Минимум подписчиков: 5000 для Telegram, 500 для MAX
    const minSubs = platform === 'max' ? 500 : 5000;
    if (subscribers < minSubs) {
      return res.status(400).json({
        error: `Минимум ${minSubs.toLocaleString('ru-RU')} подписчиков для публикации в каталоге${platform === 'max' ? ' (MAX)' : ''}`
      });
    }

    if (price124 < 100) {
      return res.status(400).json({ error: 'Цена 1/24 должна быть от 100 ₽' });
    }

    if (!price248 || price248 < 100) {
      return res.status(400).json({ error: 'Цена 2/48 обязательна, минимум 100 ₽' });
    }

    if (!price372 || price372 < 100) {
      return res.status(400).json({ error: 'Цена 3/72 обязательна, минимум 100 ₽' });
    }

    if (description.length > 500) {
      return res.status(400).json({ error: 'Описание слишком длинное (макс. 500 симв.)' });
    }

    const username = extractUsername(channelLink, platform);

    // Проверяем нет ли дубликата (по ссылке или username)
    let existing = null;
    if (username) {
      const dup = await supa(`channels?username=ilike.${encodeURIComponent(username)}&select=id,name,status&limit=1`);
      if (dup && dup.length) existing = dup[0];
    }
    if (!existing) {
      const dupByLink = await supa(`channels?link=eq.${encodeURIComponent(channelLink)}&select=id,name,status&limit=1`);
      if (dupByLink && dupByLink.length) existing = dupByLink[0];
    }

    if (existing) {
      let msg = 'Этот канал уже есть в системе';
      if (existing.status === 'pending') msg = 'Этот канал уже подан на модерацию';
      else if (existing.status === 'approved') msg = 'Этот канал уже опубликован в каталоге';
      else if (existing.status === 'rejected') msg = 'Этот канал был отклонён ранее. Свяжитесь с @maxvane для обсуждения';
      return res.status(409).json({ error: msg });
    }

    // Генерируем slug (с проверкой уникальности)
    let slug = slugify(channelName);
    if (!slug) slug = 'channel-' + Date.now();
    let slugCheck = await supa(`channels?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
    if (slugCheck && slugCheck.length) {
      slug = slug + '-' + Math.floor(Math.random() * 1000);
    }

    // Получаем claim_code через RPC функцию
    const codeResult = await supa(`rpc/generate_claim_code`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const claimCode = codeResult || ('VLT-' + Math.random().toString(36).substring(2, 7).toUpperCase());

    // Создаём запись в БД со статусом pending
    const insertResult = await supa(`channels`, {
      method: 'POST',
      body: JSON.stringify({
        slug: slug,
        name: channelName,
        username: username,
        link: channelLink,
        topic: topic,
        topic_label: TOPIC_LABELS[topic] || 'Другое',
        platform: platform,
        subscribers: subscribers,
        price_1_24: price124,
        price_2_48: price248,
        price_3_72: price372,
        rkn: false,
        verified: false,
        bot_is_admin: false,
        claim_code: claimCode,
        avatar_url: customLogoUrl,
        status: 'pending',
        submitted_at: new Date().toISOString(),
        submitted_by_telegram: submitterTelegram,
        submitted_description: description,
      }),
    });

    if (!insertResult || !insertResult[0]) {
      return res.status(500).json({ error: 'Не удалось создать заявку' });
    }

    const channel = insertResult[0];

    // Отправляем уведомление модератору
    if (MODERATOR_CHAT_ID) {
      const priceText = [
        price124 ? `1/24: ${price124.toLocaleString('ru-RU')}₽` : null,
        price248 ? `2/48: ${price248.toLocaleString('ru-RU')}₽` : null,
        price372 ? `3/72: ${price372.toLocaleString('ru-RU')}₽` : null,
      ].filter(Boolean).join(' · ');

      const platformLabel = platform === 'max' ? '📱 MAX' : '✈️ Telegram';
      const msgText =
        `📥 <b>Новая заявка на канал</b>\n\n` +
        `<b>Платформа:</b> ${platformLabel}\n` +
        `<b>Название:</b> ${escapeHtml(channelName)}\n` +
        `<b>Ссылка:</b> ${escapeHtml(channelLink)}\n` +
        `<b>Тематика:</b> ${escapeHtml(TOPIC_LABELS[topic] || 'Другое')}\n` +
        `<b>Подписчиков:</b> ${subscribers ? subscribers.toLocaleString('ru-RU') : 'не указано'}\n` +
        `<b>Цены:</b> ${priceText || 'не указаны'}\n` +
        `<b>Контакт:</b> ${escapeHtml(submitterTelegram)}\n` +
        (description ? `\n<b>Описание:</b>\n${escapeHtml(description.substring(0, 300))}\n` : '') +
        (platform === 'max' ? `\n⚠️ <i>MAX-канал — модерация без проверки бота. Связь с автором — вручную.</i>\n` : '') +
        `\n<i>Slug: ${slug}\nClaim: ${claimCode}</i>`;

      await tgCall('sendMessage', {
        chat_id: MODERATOR_CHAT_ID,
        text: msgText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Одобрить', callback_data: `mod:approve:${channel.id}` },
              { text: '❌ Отклонить', callback_data: `mod:reject:${channel.id}` },
            ],
            [
              { text: '🔗 Открыть канал', url: channelLink },
            ],
          ],
        },
      });
    }

    return res.status(200).json({
      ok: true,
      claim_code: claimCode,
      channel_id: channel.id,
      slug: slug,
    });
  } catch (err) {
    console.error('submit-channel error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
