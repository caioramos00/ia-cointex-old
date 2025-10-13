const fs = require('fs');
const path = require('path');
const { normMsg, delay, delayRange, tsNow, truncate, BETWEEN_MIN_MS, BETWEEN_MAX_MS, safeStr } = require('./utils.js');

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
                const { sendMessage } = require('./senders.js');
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

function enterStageOptOutResetIfNeeded(st) {
    if (st.optoutBatchStage !== st.etapa) {
        st.optoutBatchStage = st.etapa;
        st.optoutBuffer = [];
        st.optoutLotsTried = 0;
        st._optoutSeenIdx = 0;
        console.log(`[${st.contato}] [OPTOUT][BATCH][RESET] stage=${st.etapa}`);
    }
}

async function finalizeOptOutBatchAtEnd(st) {
    await preflightOptOut(st);
    for (let i = 0; i < 2; i++) {
        const seen = st._optoutSeenIdx;
        await delay(50);
        await preflightOptOut(st);
        if (st._optoutSeenIdx === seen) break;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || typeof promptClassificaOptOut !== 'function') {
        st.optoutBuffer = [];
        return false;
    }
    if ((st.optoutLotsTried || 0) >= 1) {
        st.optoutBuffer = [];
        return false;
    }
    const uniq = Array.from(new Set((st.optoutBuffer || []).map(s => safeStr(s))));
    const size = uniq.length;
    if (size === 0) { st.optoutBuffer = []; return false; }
    const joined = uniq.join(' | ');
    const structuredPrompt =
        `${promptClassificaOptOut(joined)}\n\n` +
        `Output only valid JSON as {"label":"OPTOUT"} or {"label":"CONTINUAR"}`;
    const ask = async (maxTok) => {
        try {
            const r = await axios.post(
                'https://api.openai.com/v1/responses',
                {
                    model: 'gpt-5',
                    input: structuredPrompt,
                    max_output_tokens: maxTok,
                    reasoning: { effort: 'low' }
                },
                {
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    timeout: 15000,
                    validateStatus: () => true
                }
            );
            const reqId = (r.headers?.['x-request-id'] || r.headers?.['X-Request-Id'] || '');
            console.log(
                `${tsNow()} [${st.contato}] [OPTOUT][IA][RAW] http=${r.status} ` +
                `req=${reqId} body=${truncate(JSON.stringify(r.data), 20000)}`
            );
            console.log(
                `[${st.contato}] [OPTOUT][IA][DEBUG] http=${r.status} req=${reqId}` +
                ` output_text="${truncate(r.data?.output_text, 300)}"` +
                ` content0="${truncate(JSON.stringify(r.data?.output?.[0]?.content || ''), 300)}"` +
                ` choices0="${truncate(r.data?.choices?.[0]?.message?.content || '', 300)}"` +
                ` result="${truncate(r.data?.result || '', 300)}"`
            );
            if (!(r.status >= 200 && r.status < 300)) {
                console.log(`[OPTOUT][IA][RAW] ${truncate(JSON.stringify(r.data), 800)}`);
            }
            let rawText = extractTextForLog(r.data) || '';
            rawText = String(rawText).trim();
            let picked = null;
            try {
                const parsed = JSON.parse(rawText);
                picked = parsed?.label ? String(parsed.label).toUpperCase() : null;
            } catch {
                const m = /"label"\s*:\s*"([^"]+)"/i.exec(rawText);
                if (m && m[1]) picked = String(m[1]).toUpperCase();
            }
            if (!picked) picked = String(pickLabelFromResponseData(r.data, ['OPTOUT', 'CONTINUAR']) || '').toUpperCase();
            console.log(
                `[${st.contato}] [OPTOUT][BATCH->IA] stage=${st.etapa} size=${size} picked=${picked || 'null'} sample="${truncate(joined, 200)}"`
            );
            return { status: r.status, picked };
        } catch (e) {
            console.log(`[${st.contato}] [OPTOUT][IA] erro="${e?.message || e}"`);
            if (e?.response) {
                const d = e.response.data;
                console.log(`[${st.contato}] [OPTOUT][IA][DEBUG] http=${e.response.status} body="${truncate(typeof d === 'string' ? d : JSON.stringify(d), 400)}"`); console.log(
                    `${tsNow()} [${st.contato}] [OPTOUT][IA][RAW][ERR] http=${e.response.status} ` +
                    `req=${e.response?.headers?.['x-request-id'] || ''} ` +
                    `body=${truncate(typeof d === 'string' ? d : JSON.stringify(d), 20000)}`
                );
            }
            return { status: 0, picked: null };
        }
    };
    st.optoutLotsTried = 1;
    let resp = await ask(64);
    if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) resp = await ask(128);
    st.optoutBuffer = [];
    const aiOptOut = (resp.status >= 200 && resp.status < 300 && resp.picked === 'OPTOUT');
    if (!aiOptOut) {
        console.log(`[${st.contato}] [OPTOUT][IA] decisão=CONTINUAR (fim da etapa ${st.etapa})`);
        return false;
    }
    st.optedOutAtTs = Date.now();
    st.mensagensPendentes = [];
    st.mensagensDesdeSolicitacao = [];
    st.optOutCount = (st.optOutCount || 0) + 1;
    st.reoptinActive = false;
    st.reoptinLotsTried = 0;
    st.reoptinBuffer = [];
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
        texto = [pick(p.msg2b1), pick(p.msg2b2)].filter(Boolean).join(', ')
            + (pick(p.msg2b3) ? ` ${pick(p.msg2b3)}` : '')
            + (pick(p.msg2b4) ? `. ${pick(p.msg2b4)}` : '')
            + (pick(p.msg2b5) ? `, ${pick(p.msg2b5)}` : '');
    }
    if (texto) {
        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        await sendMessage(st.contato, texto, { force: true });
    }
    return true;
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
    preflightOptOut,
    enterStageOptOutResetIfNeeded,
    finalizeOptOutBatchAtEnd
};