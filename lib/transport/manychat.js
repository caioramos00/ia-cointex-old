// lib/transport/manychat.js
const axios = require('axios');
const path = require('path');
const urlLib = require('url');

// Lê token/flow do DB quando não vier por parâmetro
const { getBotSettings } = require('../../db.js');

const API = 'https://api.manychat.com';

/**
 * ============================
 *  AJUSTES RÁPIDOS
 * ============================
 * - SILENT=false para ver logs.
 * - FORCE_FILE_FALLBACK=true => envia também como "file/document".
 * - MAX_IMAGE_BYTES: só para alerta em log (WhatsApp costuma barrar > ~5–10MB).
 */
const SILENT = false;
const FORCE_FILE_FALLBACK = false;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

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
    console.log(`[ManyChat][token] ${masked}`);
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

// HEAD de diagnóstico (content-type/tamanho) — não bloqueia o envio se der erro.
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

  // 1) diagnóstico do host/CDN (não bloqueante)
  const info = await headForInfo(imageUrl).catch(() => ({ ok: false, ct: '', len: 0 }));
  if (info.len > MAX_IMAGE_BYTES) {
    console.warn(
      `[ManyChat][sendImage] Arquivo possivelmente grande (${info.len} bytes). WhatsApp pode recusar > ~5–10MB.`
    );
  }

  const looksImage = isLikelyImageUrl(imageUrl, info.ct);
  if (!looksImage) {
    console.warn(`[ManyChat][sendImage] Content-Type inesperado ("${info.ct}"). Tentando mesmo assim.`);
  }

  // 2) cache-busting p/ evitar “mídia repetida”
  const finalUrl = addCacheBust(imageUrl);

  // 3) filename ajuda alguns clientes
  let filename = 'imagem.jpg';
  try {
    const u = new urlLib.URL(finalUrl);
    const base = path.basename(u.pathname || '') || 'imagem.jpg';
    filename = base;
  } catch {}

  // 4) tenta como IMAGEM (inline)
  const imgMsg = { type: 'image', url: finalUrl, filename };
  if (caption) imgMsg.caption = String(caption).slice(0, 1024);

  const payloadImg = {
    subscriber_id: subscriberId,
    data: { version: 'v2', content: { type: 'whatsapp', messages: [imgMsg] } },
  };

  const r1 = await call('/fb/sending/sendContent', payloadImg, token, 'sendContent:image');

  // 5) fallback/duplo como ARQUIVO — útil quando preview inline não renderiza
  const shouldAlsoSendAsFile =
    r1.status >= 400 ||
    r1.data?.status === 'error' ||
    FORCE_FILE_FALLBACK ||
    opts.alsoSendAsFile === true ||
    !looksImage;

  if (shouldAlsoSendAsFile) {
    const payloadFile = {
      subscriber_id: subscriberId,
      data: {
        version: 'v2',
        content: {
          type: 'whatsapp',
          messages: [{ type: 'file', url: finalUrl, filename }],
        },
      },
    };
    await call('/fb/sending/sendContent', payloadFile, token, 'sendContent:document-fallback');
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

  const r = await call('/fb/sending/sendContent', payload, token, 'sendContent:document');
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
