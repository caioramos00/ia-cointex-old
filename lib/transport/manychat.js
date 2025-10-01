// lib/transport/manychat.js
const axios = require('axios');
const path = require('path');
const urlLib = require('url');

const API = 'https://api.manychat.com';

// >>> Se quiser hardcodear aqui, preencha estes 2 (ou deixe em branco e use /admin/settings):
const API_TOKEN = '';            // seu token ManyChat SEM "Bearer "
const FALLBACK_FLOW_ID = '';     // opcional: Flow ID p/ testes

const SILENT = process.env.MC_SILENT === '1' ? '1' : '';

function sanitizeToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^"+|"+$/g, '')
    .trim();
}

function resolveToken(settings) {
  const fromSettings = settings?.manychat_api_token;
  const fromConst = API_TOKEN;
  const tok = sanitizeToken(fromSettings || fromConst || '');
  return tok;
}

function resolveFlowId(settings) {
  const fromSettings = settings?.manychat_fallback_flow_id;
  const fromConst = FALLBACK_FLOW_ID;
  return String(fromSettings || fromConst || '').trim();
}

async function call(path, payload, token, label) {
  const url = `${API}${path}`;
  const finalToken = sanitizeToken(token);
  const headers = {
    Authorization: `Bearer ${finalToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (!SILENT) {
    console.log(`[ManyChat][${label}] POST ${url}`);
    console.log(`[ManyChat][${label}] Payload: ${JSON.stringify(payload)}`);
    const masked = finalToken ? `${finalToken.slice(0,4)}...${finalToken.slice(-4)} (len=${finalToken.length})` : '(vazio)';
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

// HEAD pra pegar content-type e tamanho
async function headForInfo(url) {
  try {
    const r = await axios.head(url, { timeout: 10000, validateStatus: () => true });
    const ct = (r.headers['content-type'] || '').toLowerCase();
    const len = Number(r.headers['content-length'] || 0);
    console.log(`[HEAD]${r.status}${url}clientIP="axios" responseBytes=${len} ct="${ct}" userAgent="axios/1.11.0"`);
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
    // se não der parse, tenta concatenar
    return u + (u.includes('?') ? '&' : '?') + 'mc_ts=' + Date.now();
  }
}

async function sendText({ subscriberId, text }, settings) {
  const token = resolveToken(settings);
  if (!token) throw new Error('ManyChat API token ausente');

  const payload = {
    subscriber_id: subscriberId,
    data: {
      version: 'v2',
      content: {
        type: 'whatsapp',
        messages: [{ type: 'text', text: String(text || '').slice(0, 4096) }]
      }
    }
  };

  const r = await call('/fb/sending/sendContent', payload, token, 'sendContent:text');
  if (r.status >= 400 || r.data?.status === 'error') {
    throw new Error(`sendContent:text falhou: HTTP ${r.status}`);
  }
  return true;
}

async function sendImage({ subscriberId, imageUrl, caption }, settings, opts = {}) {
  const token = resolveToken(settings);
  if (!token) throw new Error('ManyChat API token ausente');

  const info = await headForInfo(imageUrl);
  const isImage =
    /image\/(jpeg|jpg|png|webp)/i.test(info.ct || '') ||
    /\.(jpe?g|png|webp)(\?|$)/i.test(imageUrl);

  // estoura antes se não parecer imagem
  if (!isImage) {
    console.warn(`[ManyChat][sendImage] Content-Type inesperado ("${info.ct}").`);
  }

  // cache-busting p/ evitar “mídia repetida”
  const finalUrl = addCacheBust(imageUrl);

  // payload “padrão” ManyChat v2 pra WhatsApp
  const msg = { type: 'image', url: finalUrl };
  if (caption) msg.caption = String(caption).slice(0, 1024);

  const payload = {
    subscriber_id: subscriberId,
    data: {
      version: 'v2',
      content: {
        type: 'whatsapp',
        messages: [msg]
      }
    }
  };

  const r = await call('/fb/sending/sendContent', payload, token, 'sendContent:image');
  if (r.status >= 400 || r.data?.status === 'error') {
    throw new Error(`sendContent:image falhou: HTTP ${r.status}`);
  }

  return true;
}

async function sendDocument({ subscriberId, fileUrl, filename }, settings) {
  const token = resolveToken(settings);
  if (!token) throw new Error('ManyChat API token ausente');

  const finalUrl = addCacheBust(fileUrl);
  const name = filename || path.basename((new urlLib.URL(finalUrl)).pathname || 'arquivo');

  const payload = {
    subscriber_id: subscriberId,
    data: {
      version: 'v2',
      content: {
        type: 'whatsapp',
        messages: [{ type: 'file', url: finalUrl, filename: name }]
      }
    }
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
  _helpers: { resolveToken, resolveFlowId, headForInfo, addCacheBust }
};
