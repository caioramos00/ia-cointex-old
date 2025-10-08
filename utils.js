function safeStr(v) { return (v === null || v === undefined) ? '' : String(v); }
function normalizeContato(raw) { return safeStr(raw).replace(/\D/g, ''); }
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const FIRST_REPLY_DELAY_MS = 15000;
const BETWEEN_MIN_MS = 12000;
const BETWEEN_MAX_MS = 16000;
const EXTRA_GLOBAL_DELAY_MIN_MS = 5000;
const EXTRA_GLOBAL_DELAY_MAX_MS = 10000;
function extraGlobalDelay() {
    const d = Math.floor(EXTRA_GLOBAL_DELAY_MIN_MS + Math.random() * (EXTRA_GLOBAL_DELAY_MAX_MS - EXTRA_GLOBAL_DELAY_MIN_MS));
    return delay(d);
}
function delayRange(minMs, maxMs) { const d = Math.floor(minMs + Math.random() * (maxMs - minMs)); return delay(d); }
function tsNow() {
    const d = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const p3 = n => String(n).padStart(3, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}
function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min));
}
const URL_RX = /https?:\/\/\S+/gi;
const EMOJI_RX = /([\u203C-\u3299]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDFFF])/g;
function stripUrls(s = '') { return String(s || '').replace(URL_RX, ' ').trim(); }
function stripEmojis(s = '') { return String(s || '').replace(EMOJI_RX, ' ').trim(); }
function collapseSpaces(s = '') { return String(s || '').replace(/\s+/g, ' ').trim(); }
function removeDiacritics(s = '') { return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, ''); }
function normMsg(s = '', { case_insensitive = true, accent_insensitive = true, strip_urls = true, strip_emojis = true, collapse_whitespace = true, trim = true } = {}) {
    let out = String(s || '');
    if (strip_urls) out = stripUrls(out);
    if (strip_emojis) out = stripEmojis(out);
    if (accent_insensitive) out = removeDiacritics(out);
    if (case_insensitive) out = out.toLowerCase();
    if (collapse_whitespace) out = collapseSpaces(out);
    if (trim) out = out.trim();
    return out;
}
function truncate(s, n = 600) {
    const str = String(s || '');
    return str.length > n ? str.slice(0, n) + '…[truncated]' : str;
}

module.exports = {
    safeStr,
    normalizeContato,
    delay,
    extraGlobalDelay,
    delayRange,
    tsNow,
    randomInt,
    truncate,
    URL_RX,
    EMOJI_RX,
    stripUrls,
    stripEmojis,
    collapseSpaces,
    removeDiacritics,
    normMsg,
    FIRST_REPLY_DELAY_MS,
    BETWEEN_MIN_MS,
    BETWEEN_MAX_MS,
    EXTRA_GLOBAL_DELAY_MIN_MS,
    EXTRA_GLOBAL_DELAY_MAX_MS
};