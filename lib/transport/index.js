const { getBotSettings } = require('../../db');

async function getActiveTransport() {
  const s = await getBotSettings();
  const provider = (s?.message_provider || 'meta').toLowerCase();
  let mod;
  try {
    if (provider === 'manychat') {
      mod = require('./manychat');
    } else {
      mod = require('./meta');
    }
  } catch (err) {
    throw err;
  }
  return { mod, settings: s };
}
module.exports = { getActiveTransport };