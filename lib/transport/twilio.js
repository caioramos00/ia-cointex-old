// lib/transport/twilio.js
const axios = require('axios');

module.exports = {
  name: 'twilio',
  async sendText({
    to,                // formato E.164 *sem* "whatsapp:" aqui; a gente prefixa abaixo
    text,
    accountSid = process.env.TWILIO_ACCOUNT_SID,
    authToken = process.env.TWILIO_AUTH_TOKEN,
    from = process.env.TWILIO_FROM,                         // "whatsapp:+55..."
    messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID
  }) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    const body = new URLSearchParams();
    body.append('To', `whatsapp:${to}`);
    if (messagingServiceSid) {
      body.append('MessagingServiceSid', messagingServiceSid);
    } else {
      body.append('From', from); // ex: "whatsapp:+5511999999999"
    }
    body.append('Body', text);

    await axios.post(url, body, {
      auth: { username: accountSid, password: authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  }
};
