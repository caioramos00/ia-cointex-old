const meta = require('./meta');
const twilio = require('./twilio');
const manychat = require('./manychat');
const { getBotSettings } = require('../../db'); // você já tem funções p/ ler settings

async function getActiveTransport() {
  const s = await getBotSettings();
  const provider = (s?.message_provider || 'meta').toLowerCase();
  if (provider === 'twilio') return twilio;
  if (provider === 'manychat') return manychat;
  return meta; // default
}

module.exports = { getActiveTransport };
