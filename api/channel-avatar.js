// ============================================================
// Channel avatar proxy
// GET /api/channel-avatar?id=N
// ============================================================
// Скачивает аватар канала с серверов Telegram и отдаёт клиенту
// Скрывает токен бота от публики
// Кеширует на CDN
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_STATS_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supa(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
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

export default async function handler(req, res) {
  const id = parseInt(req.query.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Misconfigured' });
  }

  try {
    // Берём канал из БД
    const channels = await supa(`channels?id=eq.${id}&select=telegram_chat_id&limit=1`);
    if (!channels.length || !channels[0].telegram_chat_id) {
      return res.status(404).json({ error: 'Channel not found or bot not admin' });
    }

    const chatId = channels[0].telegram_chat_id;

    // Получаем актуальный photo file_id
    const chatInfo = await tgCall('getChat', { chat_id: chatId });
    if (!chatInfo.ok || !chatInfo.result?.photo?.big_file_id) {
      return res.status(404).json({ error: 'No avatar' });
    }

    const fileId = chatInfo.result.photo.big_file_id;

    // Получаем file_path
    const fileInfo = await tgCall('getFile', { file_id: fileId });
    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      return res.status(404).json({ error: 'Cannot get file' });
    }

    // Скачиваем картинку
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
    const imgRes = await fetch(fileUrl);
    if (!imgRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch from Telegram' });
    }

    const buffer = await imgRes.arrayBuffer();

    // Отдаём картинку клиенту
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate'); // кеш на CDN сутки
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('avatar error:', err);
    return res.status(500).json({ error: String(err) });
  }
}
