const axios = require('axios');
const API = 'https://api.manychat.com';

const SILENT = '1';

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

  const brief = typeof resp.data === 'string' ? resp.data.slice(0, 300) : resp.data;
  if (!SILENT) console.log(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(brief)}`);

  if (resp.status >= 400 || (resp.data && resp.data.status === 'error')) {
    const err = new Error(`${label} falhou: HTTP ${resp.status}`);
    err.httpStatus = resp.status;
    err.body = resp.data;
    throw err;
  }
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
        {
          type: 'image',
          image: { url: String(url) },
          ...(caption ? { caption: String(caption) } : {})
        }
      ],
    },
  };
}

function contentV2Document(url, filename, caption) {
  return {
    version: 'v2',
    content: {
      type: 'whatsapp',
      messages: [
        {
          type: 'document',
          document: {
            url: String(url),
            ...(filename ? { filename: String(filename) } : {})
          },
          ...(caption ? { caption: String(caption) } : {})
        }
      ],
    },
  };
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
      const flowPayload = { subscriber_id: Number(subscriberId), flow_ns: fallbackFlowId };
      console.log(`[ManyChat] Usando fallback flow: ${fallbackFlowId}`);
      await call('/fb/sending/sendFlow', flowPayload, apiToken, 'sendFlow:text');
    }
  },

  async sendImage({ subscriberId, imageUrl, caption }, settings = {}) {
    const apiToken = settings.manychat_api_token || process.env.MANYCHAT_API_TOKEN;
    const fallbackFlowId = settings.manychat_fallback_flow_id || process.env.MANYCHAT_FALLBACK_FLOW_ID;

    if (!apiToken) throw new Error('ManyChat: MANYCHAT_API_TOKEN ausente');
    if (!subscriberId) throw new Error('ManyChat: subscriberId ausente no contato');
    if (!imageUrl) throw new Error('ManyChat: imageUrl ausente');

    const data = contentV2Image(imageUrl, caption);
    const payload = { subscriber_id: Number(subscriberId), data };

    try {
      await call('/fb/sending/sendContent', payload, apiToken, 'sendContent:image');
      return;
    } catch (e) {
      const code = e?.body?.code;
      const msg = (e?.body?.message || '').toLowerCase();
      const is24h = code === 3011 || /24|window|tag/.test(msg);

      if (is24h) {
        if (!fallbackFlowId) throw new Error('ManyChat: fora da janela e MANYCHAT_FALLBACK_FLOW_ID não está configurado');
        const flowPayload = { subscriber_id: Number(subscriberId), flow_ns: fallbackFlowId };
        console.log(`[ManyChat] Usando fallback flow p/ imagem: ${fallbackFlowId}`);
        await call('/fb/sending/sendFlow', flowPayload, apiToken, 'sendFlow:image');
        return;
      }

      const filenameGuess = String(imageUrl).split('/').pop()?.split('?')[0] || 'image.jpg';
      try {
        const docPayload = { subscriber_id: Number(subscriberId), data: contentV2Document(imageUrl, filenameGuess, caption) };
        await call('/fb/sending/sendContent', docPayload, apiToken, 'sendContent:document-fallback');
        return;
      } catch (e2) {
        e.detail = e?.body || e?.message;
        e.fallbackError = e2?.body || e2?.message;
        throw e;
      }
    }
  },
};