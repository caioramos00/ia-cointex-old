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
const sentHashesGlobal = new Set();
function hashText(s) { let h = 0, i, chr; const str = String(s); if (str.length === 0) return '0'; for (i = 0; i < str.length; i++) { chr = str.charCodeAt(i); h = ((h << 5) - h) + chr; h |= 0; } return String(h); }
function chooseUnique(generator, st) { const maxTries = 200; for (let i = 0; i < maxTries; i++) { const text = generator(); const h = hashText(text); if (!sentHashesGlobal.has(h) && !st.sentHashes.has(h)) { sentHashesGlobal.add(h); st.sentHashes.add(h); return text; } } return null; }

// === INVIS / FORMATTING NERF TOTAL ===

let INVIS_RX;
try {
  INVIS_RX = new RegExp('[\\p{Cf}\\p{Cc}\\p{M}]', 'gu');
} catch {
  // Fallback compacto para ambientes sem suporte a \p{...}
  // (zero-widths clássicos, controls básicos, variation selectors e BOM + Khmer invisível)
  INVIS_RX = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u17B4\u17B5]/g;
}

function stripInvisibles(str) {
  const s = safeStr(str);
  return s.replace(INVIS_RX, '');
}

// Em vez de depender de \b, varremos manualmente 16 hex seguidos
function extractTidFromCleanText(txt) {
  let buf = '';
  for (const ch of txt) {
    if (/[0-9a-fA-F]/.test(ch)) {
      buf += ch;
      if (buf.length === 16) {
        // achou 16 hex consecutivos -> devolve
        return buf.toLowerCase();
      } else if (buf.length > 16) {
        // se passar de 16, mantém só os últimos 16
        buf = buf.slice(-16);
      }
    } else {
      buf = '';
    }
  }
  return '';
}

function findTidInText(raw) {
  const txt = stripInvisibles(raw);

  // 1) primeiro tenta achar uma sequência "crua" de 16 hex
  const direct = extractTidFromCleanText(txt);
  if (direct) return direct;

  // 2) tenta dentro de URLs presentes no texto
  const urls = txt.match(/https?:\/\/\S+/gi) || [];
  for (const s of urls) {
    try {
      const u = new URL(s);
      let t = u.searchParams.get('tid');
      if (t) {
        t = stripInvisibles(t);
        const fromParam = extractTidFromCleanText(t);
        if (fromParam) return fromParam;
      }
    } catch { }
  }

  // 3) se o texto inteiro for uma URL isolada
  try {
    const u = new URL(txt.trim());
    let t = u.searchParams.get('tid');
    if (t) {
      t = stripInvisibles(t);
      const fromParam = extractTidFromCleanText(t);
      if (fromParam) return fromParam;
    }
  } catch { }

  return '';
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
  hashText,
  chooseUnique,
  findTidInText,
  FIRST_REPLY_DELAY_MS,
  BETWEEN_MIN_MS,
  BETWEEN_MAX_MS,
  EXTRA_GLOBAL_DELAY_MIN_MS,
  EXTRA_GLOBAL_DELAY_MAX_MS
};