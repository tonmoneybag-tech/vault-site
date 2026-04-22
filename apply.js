// Vercel Serverless Function
// Endpoint: POST /api/apply
// Принимает заявку с формы и отправляет в Telegram

export default async function handler(req, res) {
  // CORS (безопасно, т.к. принимаем только с vaultads.ru)
  res.setHeader('Access-Control-Allow-Origin', 'https://vaultads.ru');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!TOKEN || !CHAT_ID) {
    console.error('Missing env vars');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const data = req.body || {};
    const type = data.type || 'unknown';

    // Простая защита от спама — honeypot field
    if (data.website) {
      // Бот заполнил скрытое поле — игнорируем молча, но возвращаем успех
      return res.status(200).json({ success: true });
    }

    // Валидация
    if (type === 'channel_apply') {
      // Заявка на подключение канала
      if (!data.channelLink || !data.subscribers || !data.topic || !data.telegram) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
    } else if (type === 'advertiser_order') {
      // Заявка на размещение рекламы (из checkout)
      if (!data.name || !data.telegram) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
    } else {
      return res.status(400).json({ error: 'Unknown request type' });
    }

    // Формируем текст для Telegram
    let text = '';

    if (type === 'channel_apply') {
      text =
        '🔔 <b>Новая заявка на подключение канала</b>\n\n' +
        `📢 <b>Канал:</b> ${escapeHtml(data.channelLink)}\n` +
        `👥 <b>Подписчиков:</b> ${escapeHtml(data.subscribers)}\n` +
        `🏷 <b>Тематика:</b> ${escapeHtml(data.topic)}\n`;

      if (data.price) {
        text += `💰 <b>Желаемая цена 1/24:</b> ${escapeHtml(data.price)} ₽\n`;
      }

      text +=
        `\n👤 <b>Контакт владельца:</b> ${escapeHtml(data.telegram)}\n`;

      if (data.comment) {
        text += `💬 <b>Комментарий:</b>\n${escapeHtml(data.comment)}\n`;
      }

      text += `\n🕒 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
    } else if (type === 'advertiser_order') {
      text =
        '💼 <b>Новый заказ на рекламу</b>\n\n' +
        `👤 <b>От:</b> ${escapeHtml(data.name)}\n` +
        `📱 <b>Telegram:</b> ${escapeHtml(data.telegram)}\n`;

      if (data.email) text += `✉️ <b>Email:</b> ${escapeHtml(data.email)}\n`;

      if (data.items && Array.isArray(data.items)) {
        text += `\n<b>Каналы (${data.items.length}):</b>\n`;
        data.items.forEach(item => {
          text += `• ${escapeHtml(item.name)} — ${escapeHtml(item.format || '')} — ${escapeHtml(String(item.price || ''))} ₽\n`;
        });
      }

      if (data.total) text += `\n💰 <b>Сумма:</b> ${escapeHtml(String(data.total))} ₽\n`;
      if (data.payment) text += `💳 <b>Оплата:</b> ${escapeHtml(data.payment)}\n`;

      if (data.adText) {
        const preview = data.adText.substring(0, 200) + (data.adText.length > 200 ? '...' : '');
        text += `\n📝 <b>Креатив:</b>\n<i>${escapeHtml(preview)}</i>\n`;
      }
      if (data.adUrl) text += `🔗 <b>Ссылка:</b> ${escapeHtml(data.adUrl)}\n`;
      if (data.date) text += `📅 <b>Желаемая дата:</b> ${escapeHtml(data.date)}\n`;

      text += `\n🕒 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
    }

    // Отправляем в Telegram
    const tgUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
    const tgResponse = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });

    if (!tgResponse.ok) {
      const errorBody = await tgResponse.text();
      console.error('Telegram error:', errorBody);
      return res.status(500).json({ error: 'Failed to send notification' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
