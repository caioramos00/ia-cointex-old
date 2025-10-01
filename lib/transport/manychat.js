const axios = require('axios');
const API = 'https://api.manychat.com';

const SILENT = process.env.MC_SILENT === '1' ? '1' : '';

async function call(path, payload, token, label) {
  const url = `${API}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (!SILENT) console.log(`[ManyChat][${label}] POST ${url}`);
  if (!SILENT) console.log(`[ManyChat][${label}] Payload: ${JSON.stringify(payload)}`);

  const resp = await axios.post(url, payload, { headers, validateStatus: () => true });

  const brief = typeof resp.data === 'string' ? resp.data.slice(0, 500) : resp.data;
  if (resp.status >= 400 || (resp.data && resp.data.status === 'error')) {
    console.warn(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(brief)}`);
    const err = new Error(`${label} falhou: HTTP ${resp.status}`);
    err.httpStatus = resp.status;
    err.body = resp.data;
    throw err;
  }
  if (!SILENT) console.log(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(brief)}`);
  return resp.data;
}

function contentV2Text(textOrLines) {
  let text = Array.isArray(textOrLines)
    ? textOrLines.map(v => (v == null ? '' : String(v))).join('\n')
    : String(textOrLines ?? '');

  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  return {
    version: 'v2',
    content: {
      type: 'whatsapp',
      messages: [{ type: 'text', text }],
    },
  };
}

function contentV2Image(url, caption) {
  return {
    version: 'v2',
    content: {
      type: 'whatsapp',
      messages: [
        caption
          ? { type: 'image', url, caption }
          : { type: 'image', url },
      ],
    },
  };
}

async function headForInfo(url) {
  try {
    const r = await axios.head(url, { timeout: 10000, maxRedirects: 3, validateStatus: () => true });
    return {
      ok: r.status >= 200 && r.status < 400,
      status: r.status,
      headers: r.headers || {},
    };
  } catch (e) {
    return { ok: false, status: 0, headers: {} };
  }
}

function looksLikeImage(headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  return /^image\/(jpe?g|png|gif|webp)/.test(ct);
}

function getLength(headers) {
  const raw = headers['content-length'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  name: 'manychat',

  async sendText({ subscriberId, text }, settings = {}) {
    const apiToken = settings.manychat_api_token || process.env.MANYCHAT_API_TOKEN;
    const fallbackFlowId = settings.manychat_fallback_flow_id || process.env.MANYCHAT_FALLBACK_FLOW_ID;

    if (!apiToken) throw new Error('ManyChat: MANYCHAT_API_TOKEN ausente');
    if (!subscriberId) throw new Error('ManyChat: subscriberId ausente no contato');

    const data = contentV2Text(text);
    const payload = { subscriber_id: Number(subscriberId), data };

    try {
      await call('/fb/sending/sendContent', payload, apiToken, 'sendContent:text');
      return;
    } catch (e) {
      const code = e?.body?.code;
      const msg = (e?.body?.message || '').toLowerCase();
      const is24h = code === 3011 || /24|window|tag/.test(msg);

      if (!is24h) throw e;
      if (!fallbackFlowId) {
        throw new Error('ManyChat: fora da janela e MANYCHAT_FALLBACK_FLOW_ID não está configurado');
      }
      console.log(`[ManyChat] Usando fallback flow (text): ${fallbackFlowId}`);
      await call('/fb/sending/sendFlow', { subscriber_id: Number(subscriberId), flow_ns: fallbackFlowId }, apiToken, 'sendFlow:text');
    }
  },

  async sendImage({ subscriberId, imageUrl, caption }, settings = {}) {
    const apiToken = settings.manychat_api_token || process.env.MANYCHAT_API_TOKEN;
    const fallbackFlowId = settings.manychat_fallback_flow_id || process.env.MANYCHAT_FALLBACK_FLOW_ID;

    if (!apiToken) throw new Error('ManyChat: MANYCHAT_API_TOKEN ausente');
    if (!subscriberId) throw new Error('ManyChat: subscriberId ausente no contato');

    const url = String(imageUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('ManyChat: imageUrl inválida');

    const h = await headForInfo(url);
    if (!h.ok) {
      console.warn(`[ManyChat][sendImage] HEAD falhou status=${h.status} url=${url}`);
    } else {
      const tooBig = getLength(h.headers) > 4.8 * 1024 * 1024;
      const notImage = !looksLikeImage(h.headers);
      if (tooBig) console.warn(`[ManyChat][sendImage] Conteúdo grande (${getLength(h.headers)} bytes) — ManyChat/WA podem recusar > ~5MB`);
      if (notImage) console.warn(`[ManyChat][sendImage] Content-Type não parece imagem: ${h.headers['content-type']}`);
    }

    const data = contentV2Image(url, caption);
    const payload = { subscriber_id: Number(subscriberId), data };

    try {
      await call('/fb/sending/sendContent', payload, apiToken, 'sendContent:image');
      return;
    } catch (e) {
      const body = e?.body || {};
      const code = body?.code;
      const msg = String(body?.message || '').toLowerCase();
      const is24h = code === 3011 || /24|window|tag/.test(msg);

      if (code === 2301 || /url|media|download|fetch|invalid/i.test(msg)) {
        console.warn(`[ManyChat][sendImage] ManyChat rejeitou a URL da imagem. Verifique: HTTPS público, sem HTML, CT=image/*, tamanho <= ~5MB, extensão .jpg/.png/.webp`);
      }

      if (!is24h) throw e;

      if (!fallbackFlowId) {
        throw new Error('ManyChat: fora da janela e MANYCHAT_FALLBACK_FLOW_ID não está configurado (imagem)');
      }
      console.log(`[ManyChat] Usando fallback flow (image): ${fallbackFlowId}`);
      await call('/fb/sending/sendFlow', { subscriber_id: Number(subscriberId), flow_ns: fallbackFlowId }, apiToken, 'sendFlow:image');
    }
  },
};
