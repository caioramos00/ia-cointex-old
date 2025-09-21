// lib/transport/manychat.js
const axios = require('axios');
const API = 'https://api.manychat.com';

async function call(path, payload, token, label) {
  const url = `${API}${path}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  console.log(`[ManyChat][${label}] POST ${url}`);
  console.log(`[ManyChat][${label}] Payload: ${JSON.stringify(payload)}`);

  const resp = await axios.post(url, payload, { headers, validateStatus: () => true });

  console.log(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(resp.data)}`);

  if (resp.status >= 400 || resp.data?.status === 'error') {
    const err = new Error(`${label} falhou: HTTP ${resp.status} ${JSON.stringify(resp.data)}`);
    err.httpStatus = resp.status;
    err.body = resp.data;
    throw err;
  }
  return resp.data;
}

function contentV2Text(text) {
  // *** IMPORTANTE: type: 'whatsapp' ***
  return {
    version: 'v2',
    content: {
      type: 'whatsapp',
      messages: [{ type: 'text', text }],
    },
  };
}

module.exports = {
  name: 'manychat',

  async sendText({ subscriberId, text }, settings = {}) {
    const apiToken =
      settings.manychat_api_token || process.env.MANYCHAT_API_TOKEN;
    const fallbackFlowId =
      settings.manychat_fallback_flow_id || process.env.MANYCHAT_FALLBACK_FLOW_ID;

    if (!apiToken) throw new Error('ManyChat: MANYCHAT_API_TOKEN ausente');
    if (!subscriberId) throw new Error('ManyChat: subscriberId ausente no contato');

    const data = contentV2Text(text);
    const payload = { subscriber_id: Number(subscriberId), data };

    // 1) tenta sendContent (WhatsApp) -> depois tenta caminho fb
    try {
      try {
        await call('/whatsapp/sending/sendContent', payload, apiToken, 'sendContent/wa');
        return;
      } catch (e) {
        if (e.httpStatus === 404 || e.httpStatus === 405) {
          await call('/fb/sending/sendContent', payload, apiToken, 'sendContent/fb');
          return;
        }
        throw e;
      }
    } catch (e) {
      const code = e.body?.code;
      const msg = (e.body?.message || '').toLowerCase();
      const is24h = code === 3011 || msg.includes('24') || msg.includes('tag') || msg.includes('window');

      if (!is24h) throw e; // outro erro: propaga

      if (!fallbackFlowId) {
        console.error('[ManyChat] Fora da janela e sem MANYCHAT_FALLBACK_FLOW_ID configurado.');
        throw e;
      }

      // 2) Fallback: dispare um Flow com Template (namespaced id, ex.: "content:123456")
      const flowPayload = { subscriber_id: Number(subscriberId), flow_ns: fallbackFlowId };

      console.log(`[ManyChat] Usando fallback flow: ${fallbackFlowId}`);
      try {
        try {
          await call('/whatsapp/sending/sendFlow', flowPayload, apiToken, 'sendFlow/wa');
        } catch (e2) {
          if (e2.httpStatus === 404 || e2.httpStatus === 405) {
            await call('/fb/sending/sendFlow', flowPayload, apiToken, 'sendFlow/fb');
          } else {
            throw e2;
          }
        }
      } catch (e3) {
        throw e3;
      }
    }
  },
};
