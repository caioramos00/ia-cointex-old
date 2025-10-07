const meta = require('./meta');
const manychat = require('./manychat');
const { getBotSettings } = require('../../db');

async function getActiveTransport() {
  const s = await getBotSettings();
  console.log('[getActiveTransport] Settings loaded:', s);
  const provider = (s?.message_provider || 'meta').toLowerCase();
  console.log('[getActiveTransport] Provider:', provider);
  let mod;
  if (provider === 'manychat') {
    mod = require('./manychat');
  } else {
    mod = require('./meta');
  }
  return { mod, settings: s };
}
module.exports = { getActiveTransport };
