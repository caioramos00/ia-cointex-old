const axios = require('axios');

module.exports = {
  name: 'twilio',
  async sendText({ to, text, accountSid, authToken, from, messagingServiceSid }, settings = {}) {
    accountSid = accountSid || settings.twilio_account_sid || process.env.TWILIO_ACCOUNT_SID;
    authToken  = authToken  || settings.twilio_auth_token  || process.env.TWILIO_AUTH_TOKEN;
    messagingServiceSid = messagingServiceSid || settings.twilio_messaging_service_sid || process.env.TWILIO_MESSAGING_SERVICE_SID;
    from = from || settings.twilio_from || process.env.TWILIO_FROM;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const e164 = to.startsWith('+') ? to : `+${to}`;

    const body = new URLSearchParams();
    body.append('To', `whatsapp:${e164}`);
    if (messagingServiceSid) body.append('MessagingServiceSid', messagingServiceSid);
    else body.append('From', from);
    body.append('Body', text);

    await axios.post(url, body, {
      auth: { username: accountSid, password: authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  }
};
