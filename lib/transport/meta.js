// lib/transport/meta.js
const axios = require('axios');

module.exports = {
  name: 'meta',
  async sendText({ to, text, token = process.env.ACCESS_TOKEN, phoneNumberId = process.env.PHONE_NUMBER_ID }) {
    const url = `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;
    // permanece idempotência no seu nível atual (se quiser, adicione X-Idempotency-Key como sugeri)
    await axios.post(url, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, { headers: { Authorization: `Bearer ${token}` } });
  }
  // Você pode depois adicionar sendMedia, sendTemplate etc. aqui
};
