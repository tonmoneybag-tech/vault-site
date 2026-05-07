// ============================================================
// Upload channel logo to Supabase Storage
// POST /api/upload-logo
// ============================================================
// Принимает картинку как base64 и сохраняет в Supabase Storage.
// Возвращает публичный URL.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'channel-logos';

// Лимиты безопасности
const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '3mb', // Чуть больше лимита, чтобы запас на base64 overhead
    },
  },
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

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    const { base64, filename, mimeType } = req.body || {};

    if (!base64 || !filename || !mimeType) {
      return res.status(400).json({ error: 'Не хватает данных (base64, filename, mimeType)' });
    }

    if (!ALLOWED_TYPES.includes(mimeType)) {
      return res.status(400).json({ error: 'Допустимые форматы: JPG, PNG, WEBP' });
    }

    // Декодируем base64 (отрезаем data:image/...;base64, если есть)
    const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > MAX_SIZE_BYTES) {
      return res.status(400).json({ error: 'Файл слишком большой (макс. 2MB)' });
    }

    // Генерируем уникальное имя
    const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
    const cleanName = (filename || 'logo')
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .toLowerCase()
      .substring(0, 50);
    const uniqueName = `${Date.now()}-${cleanName}.${ext}`;

    // Загружаем в Supabase Storage
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${uniqueName}`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': mimeType,
        'x-upsert': 'true',
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('Supabase Storage upload error:', errText);
      return res.status(500).json({ error: 'Ошибка загрузки в хранилище' });
    }

    // Возвращаем публичный URL (бакет публичный)
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${uniqueName}`;

    return res.status(200).json({
      ok: true,
      url: publicUrl,
      filename: uniqueName,
    });
  } catch (err) {
    console.error('upload-logo error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
