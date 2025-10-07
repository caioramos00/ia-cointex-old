module.exports = {
  name: 'meta',
  async sendText({ to, text }, settings) {
    console.log('[meta.sendText] Received settings:', settings); // Log completo das settings recebidas
    console.log('[meta.sendText] Extracted token:', settings?.meta_access_token); // Verifique token
    console.log('[meta.sendText] Extracted phoneNumberId:', settings?.meta_phone_number_id); // Verifique phone ID
    const token = settings?.meta_access_token;
    const phoneNumberId = settings?.meta_phone_number_id;
    if (!token || !phoneNumberId) {
      console.log('[meta.sendText] Credentials check failed - token:', !!token, 'phoneNumberId:', !!phoneNumberId);
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
    console.log('[meta.sendImage] Received settings:', settings);
    console.log('[meta.sendImage] Extracted token:', settings?.meta_access_token);
    console.log('[meta.sendImage] Extracted phoneNumberId:', settings?.meta_phone_number_id);
    const token = settings?.meta_access_token;
    const phoneNumberId = settings?.meta_phone_number_id;
    if (!token || !phoneNumberId) {
      console.log('[meta.sendImage] Credentials check failed - token:', !!token, 'phoneNumberId:', !!phoneNumberId);
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
