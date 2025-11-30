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

// Versão principal (Node moderno, com suporte a Unicode property escapes)
const INVIS_PROP_RX = /[\p{Cf}\p{Cc}\p{M}]/gu;

// Fallback pra ambientes sem suporte a \p{...}
// (cobre zero-widths clássicos, formatting, variation selectors e BOM)
const INVIS_FALLBACK_RX =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DD\u06DF-\u06E4\u06E7-\u06E8\u06EA-\u06ED\u070F\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08D3-\u08E1\u08E3-\u0902\u093A-\u093C\u0941-\u0948\u094D\u0951-\u0957\u0962-\u0963\u0981\u09BC\u09C1-\u09C4\u09CD\u09E2-\u09E3\u0A01-\u0A02\u0A3C\u0A41-\u0A42\u0A47-\u0A48\u0A4B-\u0A4D\u0A51\u0A70-\u0A71\u0A75\u0A81-\u0A82\u0ABC\u0AC1-\u0AC5\u0AC7-\u0AC8\u0ACD\u0AE2-\u0AE3\u0B01\u0B3C\u0B3F\u0B41-\u0B44\u0B4D\u0B56-\u0B57\u0B62-\u0B63\u0B82\u0BC0\u0BCD\u0C00-\u0C01\u0C3E-\u0C40\u0C46-\u0C48\u0C4A-\u0C4D\u0C55-\u0C56\u0C62-\u0C63\u0C81\u0CBC\u0CBF\u0CC2\u0CC6\u0CCC-\u0CCD\u0CE2-\u0CE3\u0D01\u0D41-\u0D44\u0D4D\u0D62-\u0D63\u0DCA\u0DD2-\u0DD4\u0DD6\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EB9\u0EBB-\u0EBC\u0EC8-\u0ECD\u0F18-\u0F19\u0F35\u0F37\u0F39\u0F71-\u0F7E\u0F80-\u0F84\u0F86-\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102D-\u1030\u1032-\u1037\u1039-\u103A\u103D-\u103E\u1058-\u1059\u105E-\u1060\u1071-\u1074\u1082-\u108D\u108F\u109A-\u109D\u135D-\u135F\u1712-\u1714\u1732-\u1734\u1752-\u1753\u1772-\u1773\u17B4-\u17B5\u17B7-\u17BD\u17C6\u17C9-\u17D3\u17DD\u180B-\u180D\u18A9\u1920-\u1922\u1927-\u1928\u1932\u1939-\u193B\u1A17-\u1A1B\u1A56\u1A58-\u1A5E\u1A60\u1A62\u1A65-\u1A6C\u1A73-\u1A7C\u1A7F\u1B00-\u1B03\u1B34\u1B36-\u1B3A\u1B3C\u1B42\u1B6B-\u1B73\u1B80-\u1B81\u1BA2-\u1BA5\u1BA8-\u1BA9\u1BAB-\u1BAD\u1BE6\u1BE8-\u1BE9\u1BED\u1BEF-\u1BF1\u1C2C-\u1C33\u1C36-\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE0\u1CE2-\u1CE8\u1CED\u1CF4\u1CF8-\u1CF9\u1DC0-\u1DF9\u1DFB-\u1DFF\u200B-\u200F\u202A-\u202E\u2060-\u206F\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099-\u309A\uA66F-\uA672\uA674-\uA67D\uA69E-\uA69F\uA6F0-\uA6F1\uA802\uA806\uA80B\uA825-\uA826\uA8C4\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA951\uA980-\uA982\uA9B3\uA9B6-\uA9B9\uA9BC-\uA9BD\uA9E5\uAA29-\uAA2E\uAA31-\uAA32\uAA35-\uAA36\uAA43\uAA4C\uAA7C\uAAB0\uAAB2-\uAAB4\uAAB7-\uAAB8\uAABE-\uAABF\uAAC1\uAAEC-\uAAED\uAAF6\uABE5\uABE8\uABED\uD802\uDEE5\uD802\uDEE6\uD804\uDCB0-\uD804\uDCCA\uD804\uDD00-\uD804\uDD02\uD804\uDD27-\uD804\uDD34\uD804\uDD73\uD804\uDD80-\uD804\uDD82\uD804\uDDB3-\uD804\uDDC0\uD804\uDDFD\uD804\uDE2C-\uD804\uDE2F\uD804\uDE3F\uD804\uDEA0-\uD804\uDEA3\uD804\uDEE0-\uD804\uDEE2\uD804\uDEF0-\uD804\uDEF5\uD804\uDF01-\uD804\uDF03\uD804\uDF3C-\uD804\uDF3E\uD804\uDF41-\uD804\uDF44\uD804\uDF47-\uD804\uDF4D\uD804\uDF57\uD804\uDF62-\uD804\uDF63\uD805\uDCB0-\uD805\uDCC3\uD805\uDCC5\uD805\uDDA3-\uD805\uDDB2\uD805\uDDB4-\uD805\uDDC0\uD805\uDE30-\uD805\uDE3B\uD805\uDE3D\uD805\uDE3E\uD805\uDF00-\uD805\uDF03\uD805\uDF27-\uD805\uDF2F\uD806\uDCA7\uD806\uDCAA-\uD806\uDCD3\uD806\uDD30-\uD806\uDD34\uD806\uDD36\uD806\uDE00-\uD806\uDE03\uD806\uDE47\uD806\uDE4B-\uD806\uDE4F\uD806\uDE51-\uD806\uDE5E\uD806\uDE61-\uD806\uDE7E\uD806\uDE80-\uD806\uDE82\uD806\uDEB0-\uD806\uDEC0\uD806\uDF0C-\uD806\uDF0E\uD807\uDC00-\uD807\uDC08\uD807\uDC0A-\uD807\uDC2E\uD807\uDC30-\uD807\uDC36\uD807\uDC38-\uD807\uDC3F\uD807\uDC92-\uD807\uDCA7\uD81A\uDEF0-\uD81A\uDEF4\uD81A\uDF30-\uD81A\uDF36\uD81A\uDF40-\uD81A\uDF43\uD81A\uDF63\uD81A\uDF77-\uD81A\uDF7C\uD81B\uDF00-\uD81B\uDF02\uD81B\uDF20-\uD81B\uDF2D\uD81B\uDF30-\uD81B\uDF36\uD81B\uDF40-\uD81B\uDF43\uD82F\uDC9D-\uD82F\uDC9E\uD834\uDD00-\uD834\uDD1E\uD834\uDD20-\uD834\uDD27\uD834\uDD30-\uD834\uDD3B\uD834\uDD3D-\uD834\uDD3E\uD834\uDD3F\uD834\uDD41-\uD834\uDD44\uD834\uDD4A-\uD834\uDD4E\uD834\uDD57-\uD834\uDD5E\uD834\uDD65-\uD834\uDD69\uD834\uDD6D-\uD834\uDD72\uD834\uDD7B-\uD834\uDD82\uD834\uDD85-\uD834\uDD8B\uD834\uDD92-\uD834\uDD94\uD834\uDD9F-\uD834\uDDA1\uD834\uDDA3-\uD834\uDDA4\uD834\uDDA7-\uD834\uDDE8\uD834\uDDF0-\uD834\uDDF5\uD834\uDE00-\uD834\uDE03\uD834\uDE20-\uD834\uDE2D\uD834\uDE80-\uD834\uDE86\uD834\uDE90-\uD834\uDE97\uD834\uDEE0-\uD834\uDEF3\uD835\uDCD0-\uD835\uDCD2\uD835\uDCD4-\uD835\uDCDF\uD835\uDCE2-\uD835\uDCE8\uD835\uDCF0-\uD835\uDCF2\uD835\uDCF4-\uD835\uDCF7\uD835\uDCFA-\uD835\uDCFE\uD835\uDD00-\uD835\uDD02\uD835\uDD2D-\uD835\uDD38\uD835\uDD3B-\uD835\uDD3E\uD835\uDD40-\uD835\uDD44\uD835\uDD46\uD835\uDD4A-\uD835\uDD50\uD835\uDD52-\uD835\uDD6B\uD835\uDD6D-\uD835\uDD72\uD835\uDD7C-\uD835\uDD83\uD835\uDD85-\uD835\uDD8A\uD835\uDD8C-\uD835\uDD92\uD835\uDD94-\uD835\uDD96\uD835\uDD98-\uD835\uDD9B\uD835\uDD9E-\uD835\uDDA1\uD835\uDDA3-\uD835\uDDA4\uD835\uDDA7-\uD835\uDDB0\uD835\uDDB2-\uD835\uDDB7\uD835\uDDBA-\uD835\uDDC0\uD835\uDDC2-\uD835\uDDC8\uD83C\uDFFB-\uD83C\uDFFF\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/g;

// helper que tenta usar a regex “completa” e cai no fallback se não puder
function stripInvisibles(str) {
  const s = safeStr(str);
  try {
    return s.replace(INVIS_PROP_RX, '');
  } catch {
    return s.replace(INVIS_FALLBACK_RX, '');
  }
}

// Em vez de depender de \b, vamos varrer manualmente 16 hex seguidos
function extractTidFromCleanText(txt) {
  let buf = '';
  for (const ch of txt) {
    if (/[0-9a-fA-F]/.test(ch)) {
      buf += ch;
      if (buf.length === 16) {
        return buf.toLowerCase();
      } else if (buf.length > 16) {
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

  // 2) depois tenta dentro de URLs presentes no texto
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

  // 3) se o texto inteiro for uma URL
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