const axios = require('axios');

function briefToken(t) {
  if (!t) return '(ausente)';
  const raw = String(t).replace(/^Bearer\s+/i, '');
  if (raw.length <= 8) return '********';
  return `${raw.slice(0,4)}...${raw.slice(-4)} (len=${raw.length})`;
}

async function postWithLog({ phoneNumberId, token, payload }) {
  const url = `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;
  const headers = { Authorization: `Bearer ${token}` };

  // LOG do envio (payload + phone_number_id). NÃO logamos o token.
  console.log(
    `[META][TX] phone_number_id=${phoneNumberId} ` +
    `to=${payload?.to || '-'} ` +
    `type=${payload?.type || '-'} ` +
    `payload=${JSON.stringify(payload)} token=${briefToken(token)}`
  );

  const resp = await axios.post(url, payload, {
    headers,
    validateStatus: () => true,
    timeout: 20000
  });

  // LOG da resposta da API (status + body)
  const bodyBrief = typeof resp.data === 'string' ? resp.data : resp.data || {};
  console.log(`[META][TX][RESP] http=${resp.status} body=${JSON.stringify(bodyBrief)}`);

  if (resp.status >= 400 || (bodyBrief && bodyBrief.error)) {
    throw new Error(`Meta send failed: http=${resp.status} body=${JSON.stringify(bodyBrief)}`);
  }

  return resp.data;
}

module.exports = {
  name: 'meta',

  // Envio de texto
  async sendText({ to, text }, settings) {
    const token = settings?.meta_access_token;
    const phoneNumberId = settings?.meta_phone_number_id;
    if (!token || !phoneNumberId) {
      throw new Error('Meta credentials missing');
    }

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: String(text || '') }
    };

    return postWithLog({ phoneNumberId, token, payload });
  },

  // Envio de imagem (por link), com caption opcional
  async sendImage({ to, url, caption }, settings) {
    const token = settings?.meta_access_token;
    const phoneNumberId = settings?.meta_phone_number_id;
    if (!token || !phoneNumberId) {
      throw new Error('Meta credentials missing');
    }

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: url }
    };
    if (caption) payload.image.caption = String(caption);

    return postWithLog({ phoneNumberId, token, payload });
  }
};
