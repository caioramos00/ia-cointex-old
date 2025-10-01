const meta = require('./meta');
const manychat = require('./manychat');
const { getBotSettings } = require('../../db');

async function getActiveTransport() {
  const s = await getBotSettings();
  const provider = (s?.message_provider || 'meta').toLowerCase();
  const mod = provider === 'twilio' ? twilio : provider === 'manychat' ? manychat : meta;
  return { mod, settings: s };
}
module.exports = { getActiveTransport };
