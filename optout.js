const fs = require('fs');
const path = require('path');
const { normMsg, delayRange, tsNow, truncate, BETWEEN_MIN_MS, BETWEEN_MAX_MS, safeStr } = require('./utils.js');

function loadJsonSafe(p) {
    let raw = fs.readFileSync(p, 'utf8');
    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(raw);
}
let _optOutData = null, _optInData = null, _optOutMsgs = null, _optInMsgs = null;
function loadOptOutData() {
    if (_optOutData) return _optOutData;
    _optOutData = loadJsonSafe(path.join(__dirname, 'content', 'opt-out.json'));
    return _optOutData;
}
function loadOptOutMsgs() {
    if (_optOutMsgs) return _optOutMsgs;
    _optOutMsgs = loadJsonSafe(path.join(__dirname, 'content', 'opt-out-messages.json'));
    return _optOutMsgs;
}
function loadOptInData() {
    if (_optInData) return _optInData;
    _optInData = loadJsonSafe(path.join(__dirname, 'content', 'opt-in.json'));
    return _optInData;
}
function loadOptInMsgs() {
    if (_optInMsgs) return _optInMsgs;
    _optInMsgs = loadJsonSafe(path.join(__dirname, 'content', 'opt-in-messages.json'));
    return _optInMsgs;
}

function _canonicalizeEtapa(etapa) {
    return etapa.toLowerCase().trim();
}
function isOptOut(textRaw) {
    const data = loadOptOutData();
    const cfg = data?.config || {};
    const s = normMsg(textRaw, cfg);
    if (!s) return false;
    const amb = new Set(
        (data?.exceptions?.ambiguous_single_tokens || [])
            .map(v => normMsg(v, cfg))
            .filter(Boolean)
    );
    if (amb.has(s)) return false;
    const bl = data?.blocklists || {};
    const langs = Object.keys(bl);
    const flatten = (key) => {
        const out = [];
        for (const L of langs) {
            const arr = bl[L]?.[key];
            if (Array.isArray(arr)) out.push(...arr);
        }
        return out;
    };
    const phrases = flatten('phrases').map(v => normMsg(v, cfg)).filter(Boolean);
    const keywords = flatten('keywords').map(v => normMsg(v, cfg)).filter(Boolean);
    const riskTerms = (data?.risk_terms || []).map(v => normMsg(v, cfg)).filter(Boolean);
    const rule = Array.isArray(data?.block_if_any) ? data.block_if_any : ['phrases', 'keywords', 'risk_terms'];
    const sWords = s.split(/\s+/);
    const has = (arr) => arr.some(p => s.includes(p));
    const hasWord = (arr) => arr.some(w => sWords.includes(w));
    const hasRisk = riskTerms.some(t => sWords.some(w => w.includes(t)));
    for (const k of rule) {
        if (k === 'phrases' && has(phrases)) return true;
        if (k === 'keywords' && hasWord(keywords)) return true;
        if (k === 'risk_terms' && hasRisk) return true;
    }
    return false;
}

function isOptIn(textRaw) {
    const data = loadOptInData();
    const cfg = data?.config || {};
    const s = normMsg(textRaw, cfg);
    if (!s) return false;
    const amb = new Set(
        (data?.exceptions?.ambiguous_single_tokens || [])
            .map(v => normMsg(v, cfg))
            .filter(Boolean)
    );
    if (amb.has(s)) return false;
    const bl = data?.blocklists || {};
    const langs = Object.keys(bl);
    const flatten = (key) => {
        const out = [];
        for (const L of langs) {
            const arr = bl[L]?.[key];
            if (Array.isArray(arr)) out.push(...arr);
        }
        return out;
    };
    const phrases = flatten('phrases').map(v => normMsg(v, cfg)).filter(Boolean);
    const keywords = flatten('keywords').map(v => normMsg(v, cfg)).filter(Boolean);
    const rule = Array.isArray(data?.block_if_any) ? data.block_if_any : ['phrases', 'keywords'];
    const sWords = s.split(/\s+/);
    const has = (arr) => arr.some(p => s.includes(p));
    const hasWord = (arr) => arr.some(w => sWords.includes(w));
    for (const k of rule) {
        if (k === 'phrases' && has(phrases)) return true;
        if (k === 'keywords' && hasWord(keywords)) return true;
    }
    return false;
}

async function preflightOptOut(st) {
    if (st.permanentlyBlocked === true || st.optOutCount >= 3) return true;
    if (st.optOutCount > 0 && !st.reoptinActive) return true;
    if (st.optoutBuffer.length >= 1) {
        console.log(`[${st.contato}] [OPTOUT][BATCH][START] stage=${st.etapa} size=${st.optoutBuffer.length}`);
        st.optoutLotsTried++;
        let hasOut = false;
        for (const msg of st.optoutBuffer) {
            if (isOptOut(msg)) {
                hasOut = true;
                console.log(`[${st.contato}] [OPTOUT][BATCH][HIT] msg="${truncate(msg, 140)}"`);
            } else {
                console.log(`[${st.contato}] [OPTOUT][BATCH][MISS] msg="${truncate(msg, 140)}"`);
            }
        }
        st.optoutBuffer = [];
        if (hasOut) {
            st.enviandoMensagens = false;
            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.optOutCount = (st.optOutCount || 0) + 1;
            st.reoptinActive = false;
            st.reoptinLotsTried = 0;
            st.reoptinBuffer = [];
            st.optoutBuffer = [];
            st.optoutLotsTried = 0;
            if (st.optOutCount >= 3) {
                st.permanentlyBlocked = true;
                if (st.etapa !== 'encerrado:wait') {
                    const _prev = st.etapa;
                    st.etapa = 'encerrado:wait';
                    console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                }
            }
            const oMsgs = loadOptOutMsgs();
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
            let texto = '';
            if (st.optOutCount === 1) {
                const p = oMsgs?.msg1 || {};
                texto = [pick(p.msg1b1), pick(p.msg1b2)].filter(Boolean).join(', ') + (pick(p.msg1b3) ? `. ${pick(p.msg1b3)}` : '');
            } else if (st.optOutCount === 2) {
                const p = oMsgs?.msg2 || {};
                texto =
                    [pick(p.msg2b1), pick(p.msg2b2)].filter(Boolean).join(', ') +
                    (pick(p.msg2b3) ? ` ${pick(p.msg2b3)}` : '') +
                    (pick(p.msg2b4) ? `. ${pick(p.msg2b4)}` : '') +
                    (pick(p.msg2b5) ? `, ${pick(p.msg2b5)}` : '');
            }
            if (texto) {
                const { sendMessage } = require('./bot.js');  // Ajuste: Use senders.js se sendMessage for movido para lá mais tarde; por agora, assuma que será resolvido.
                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                await sendMessage(st.contato, texto, { force: true });
            }
            return true;
        }
        const start = Math.max(0, st._optoutSeenIdx || 0);
        for (let i = start; i < pend.length; i++) {
            const t = safeStr(pend[i]?.texto || '').trim();
            if (t) {
                st.optoutBuffer.push(t);
                console.log(`[${st.contato}] [OPTOUT][BATCH][PUSH] stage=${st.etapa} size=${st.optoutBuffer.length} msg="${truncate(t, 140)}"`);
            }
        }
        st._optoutSeenIdx = pend.length;
        return false;
    }
    return false;
}

module.exports = {
    loadJsonSafe,
    loadOptOutData,
    loadOptOutMsgs,
    loadOptInData,
    loadOptInMsgs,
    _canonicalizeEtapa,
    isOptOut,
    isOptIn,
    preflightOptOut
};