const axios = require('axios');
const path = require('path');
const urlLib = require('url');

const { getBotSettings } = require('../../db.js');

const API = 'https://api.manychat.com';

const SILENT = false;
const FORCE_FILE_FALLBACK = true;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function sanitizeToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^"+|"+$/g, '')
    .trim();
}

async function resolveSettings(maybeSettings) {
  if (maybeSettings && typeof maybeSettings === 'object') return maybeSettings;
  try {
    const s = await getBotSettings();
    return s || {};
  } catch {
    return {};
  }
}

function resolveFlowIdSync(settings) {
  return String(settings?.manychat_fallback_flow_id || '').trim();
}

async function resolveTokenAsync(maybeSettings) {
  const s = await resolveSettings(maybeSettings);
  return sanitizeToken(s?.manychat_api_token || '');
}

async function call(pathname, payload, token, label) {
  const url = `${API}${pathname}`;
  const finalToken = sanitizeToken(token);
  const headers = {
    Authorization: `Bearer ${finalToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (!SILENT) {
    console.log(`[ManyChat][${label}] POST ${url}`);
    console.log(`[ManyChat][${label}] Payload: ${JSON.stringify(payload)}`);
    const masked = finalToken
      ? `${finalToken.slice(0, 4)}...${finalToken.slice(-4)} (len=${finalToken.length})`
      : '(vazio)';
  }

  const resp = await axios.post(url, payload, { headers, validateStatus: () => true });
  const brief = typeof resp.data === 'string' ? resp.data.slice(0, 500) : resp.data;

  if (resp.status >= 400 || (brief && brief.status === 'error')) {
    console.warn(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(brief)}`);
  } else if (!SILENT) {
    console.log(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(brief)}`);
  }

  return resp;
}

async function headForInfo(url) {
  try {
    const r = await axios.head(url, { timeout: 10000, validateStatus: () => true });
    const ct = (r.headers['content-type'] || '').toLowerCase();
    const len = Number(r.headers['content-length'] || 0);
    console.log(
      `[HEAD]${r.status}${url}clientIP="axios" responseBytes=${len} ct="${ct}" userAgent="axios/1.11.0"`
    );
    return { ok: r.status >= 200 && r.status < 300, ct, len };
  } catch (e) {
    console.warn(`[HEAD] fail ${url}: ${e.message}`);
    return { ok: false, ct: '', len: 0 };
  }
}

function addCacheBust(u) {
  try {
    const parsed = new urlLib.URL(u);
    parsed.searchParams.set('mc_ts', String(Date.now()));
    return parsed.toString();
  } catch {
    return u + (u.includes('?') ? '&' : '?') + 'mc_ts=' + Date.now();
  }
}

function isLikelyImageUrl(url, ct) {
  return /image\/(jpeg|jpg|png|webp)/i.test(ct || '') ||
    /\.(jpe?g|png|webp)(\?|$)/i.test(String(url || ''));
}

async function sendText({ subscriberId, text }, settings) {
  const token = await resolveTokenAsync(settings);
  if (!token) throw new Error('ManyChat API token ausente (ver bot_settings.manychat_api_token)');

  const payload = {
    subscriber_id: subscriberId,
    data: {
      version: 'v2',
      content: {
        type: 'whatsapp',
        messages: [{ type: 'text', text: String(text || '').slice(0, 4096) }],
      },
    },
  };

  const r = await call('/fb/sending/sendContent', payload, token, 'sendContent:text');
  if (r.status >= 400 || r.data?.status === 'error') {
    throw new Error(`sendContent:text falhou: HTTP ${r.status}`);
  }
  return true;
}

async function sendImage({ subscriberId, imageUrl, caption }, settings, opts = {}) {
  const token = await resolveTokenAsync(settings);
  if (!token) throw new Error('ManyChat API token ausente (ver bot_settings.manychat_api_token)');

  const info = await headForInfo(imageUrl).catch(() => ({ ok: false, ct: '', len: 0 }));
  if (info.len > MAX_IMAGE_BYTES) {
    console.warn(`[ManyChat][sendImage] Arquivo grande (${info.len} bytes). WhatsApp pode recusar.`);
  }

  const looksImage = isLikelyImageUrl(imageUrl, info.ct);
  if (!looksImage) {
    console.warn(`[ManyChat][sendImage] Content-Type inesperado ("${info.ct}"). Tentando mesmo assim.`);
  }

  const finalUrl = addCacheBust(imageUrl);

  let filename = 'imagem.jpg';
  try {
    const u = new urlLib.URL(finalUrl);
    filename = path.basename(u.pathname || '') || 'imagem.jpg';
  } catch {}

  const imgMsg = {
    type: 'image',
    url: finalUrl
  };
  if (caption) imgMsg.caption = String(caption).slice(0, 1024);

  const payloadImg = {
    subscriber_id: subscriberId,
    data: { version: 'v2', content: { type: 'whatsapp', messages: [imgMsg] } },
  };

  const r1 = await call('/fb/sending/sendContent', payloadImg, token, 'sendContent:image');
  if (r1.status >= 400 || r1.data?.status === 'error') {
    throw new Error(`sendImage falhou: ${JSON.stringify(r1.data)}`);
  }

  const shouldAlsoSendAsFile =
    FORCE_FILE_FALLBACK ||
    opts.alsoSendAsFile === true ||
    !looksImage;

  if (shouldAlsoSendAsFile) {
    const fileMsg = {
      type: 'file',
      url: finalUrl,
      filename
    };
    if (caption) fileMsg.caption = String(caption).slice(0, 1024);

    const payloadFile = {
      subscriber_id: subscriberId,
      data: { version: 'v2', content: { type: 'whatsapp', messages: [fileMsg] } },
    };

    const r2 = await call('/fb/sending/sendContent', payloadFile, token, 'sendContent:file-fallback');
    if (r2.status >= 400 || r2.data?.status === 'error') {
      console.warn(`Fallback file falhou: ${JSON.stringify(r2.data)}`);
    }
  }

  return true;
}

async function sendDocument({ subscriberId, fileUrl, filename }, settings) {
  const token = await resolveTokenAsync(settings);
  if (!token) throw new Error('ManyChat API token ausente (ver bot_settings.manychat_api_token)');

  const finalUrl = addCacheBust(fileUrl);
  let name = filename;
  try {
    if (!name) {
      const u = new urlLib.URL(finalUrl);
      name = path.basename(u.pathname || 'arquivo');
    }
  } catch {
    name = name || 'arquivo';
  }

  const payload = {
    subscriber_id: subscriberId,
    data: {
      version: 'v2',
      content: {
        type: 'whatsapp',
        messages: [{ type: 'file', url: finalUrl, filename: name }],
      },
    },
  };

  const r = await call('/whatsapp/sending/sendContent', payload, token, 'sendContent:document');
  if (r.status >= 400 || r.data?.status === 'error') {
    throw new Error(`sendContent:document falhou: HTTP ${r.status}`);
  }
  return true;
}

module.exports = {
  name: 'manychat',
  sendText,
  sendImage,
  sendDocument,
  _helpers: { resolveSettings, resolveFlowIdSync, headForInfo, addCacheBust },
};
