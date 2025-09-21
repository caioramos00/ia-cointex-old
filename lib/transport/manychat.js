// lib/transport/manychat.js
const axios = require('axios');

const API = 'https://api.manychat.com';

async function post(path, payload, token) {
  await axios.post(`${API}${path}`, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
}

module.exports = {
  name: 'manychat',
  // requer que seu contato tenha manychat_subscriber_id salvo no DB
  async sendText({ subscriberId, text }, settings = {}) {
    const apiToken = settings.manychat_api_token || process.env.MANYCHAT_API_TOKEN;
    const fallbackFlowId = settings.manychat_fallback_flow_id || process.env.MANYCHAT_FALLBACK_FLOW_ID;
    if (!subscriberId) throw new Error('Manychat: subscriberId ausente no contato');

    // Tente sendContent (janela ativa). Se falhar por política, caia para sendFlow (template).
    try {
      await post('/whatsapp/sending/sendContent', {
        subscriber_id: subscriberId,
        data: { version: 'v2', type: 'text', text }
      }, apiToken);
    } catch (e) {
      if (!fallbackFlowId) throw e; // sem flow designado
      await post('/whatsapp/sending/sendFlow', {
        subscriber_id: subscriberId,
        flow_ns: fallbackFlowId, // ex.: "content:123456" (ID/namespaced do Flow com Template)
        // opcional: { "blocks": { "variavel": "valor" } }
      }, apiToken);
    }
  }
};
