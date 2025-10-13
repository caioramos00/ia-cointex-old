const axios = require('axios');

module.exports = {
  name: 'meta',
  async sendText({ to, text }, settings) {
    const token = settings?.meta_access_token;
    const phoneNumberId = settings?.meta_phone_number_id;
    if (!token || !phoneNumberId) {
      throw new Error('Meta credentials missing');
    }

    const url = `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;
    await axios.post(url, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, { headers: { Authorization: `Bearer ${token}` } });
  },
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
    if (caption) payload.image.caption = caption;

    const apiUrl = `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;
    await axios.post(apiUrl, payload, { headers: { Authorization: `Bearer ${token}` } });
  }
};
