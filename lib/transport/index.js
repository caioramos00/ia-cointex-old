const { getBotSettings } = require('../../db');

async function getActiveTransport() {
  const s = await getBotSettings();
  console.log('[getActiveTransport] Settings loaded:', s);
  const provider = (s?.message_provider || 'meta').toLowerCase();
  console.log('[getActiveTransport] Provider:', provider);
  let mod;
  try {
    if (provider === 'manychat') {
      mod = require('./manychat');
    } else {
      mod = require('./meta');
    }
  } catch (err) {
    console.error('[getActiveTransport] Error loading module for provider', provider, err);
    throw err;
  }
  return { mod, settings: s };
}
module.exports = { getActiveTransport };