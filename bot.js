'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const estadoContatos = require('./state.js');
const { getActiveTransport } = require('./lib/transport');
const { getContatoByPhone, setManychatSubscriberId } = require('./db');
const {
    promptClassificaAceite,
    promptClassificaAcesso,
    promptClassificaConfirmacao,
    promptClassificaRelevancia,
    promptClassificaOptOut,
    promptClassificaReoptin
} = require('./prompts');

let log = console;

const https = require('https');
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });

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

function loadJsonSafe(p) {
    let raw = fs.readFileSync(p, 'utf8');
    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(raw);
}

// cache loaders
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

    // exceção: mensagem é *apenas* um token ambíguo (do JSON)
    const amb = new Set(
        (data?.exceptions?.ambiguous_single_tokens || [])
            .map(v => normMsg(v, cfg))
            .filter(Boolean)
    );
    if (amb.has(s)) return false;

    // Une todas as listas por idioma (pt/en/es) do JSON
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

    // Carrega listas (apenas do ARQUIVO)
    const phrases = flatten('phrases').map(v => normMsg(v, cfg)).filter(Boolean);     // PT/EN/ES
    const keywords = flatten('keywords').map(v => normMsg(v, cfg)).filter(Boolean);   // PT/EN/ES
    const riskTerms = (data?.risk_terms || []).map(v => normMsg(v, cfg)).filter(Boolean);

    // “block_if_any” vindo do arquivo – SEM usar regex no código
    const rule = Array.isArray(data?.block_if_any) ? data.block_if_any : ['phrases', 'keywords', 'risk_terms'];
    const shouldCheck = new Set(
        rule
            .map(x => String(x || '').toLowerCase())
            .filter(k => k === 'phrases' || k === 'keywords' || k === 'risk_terms')
    );

    const padded = (x) => ` ${x} `;
    const hasAnySafe = (arr, S) => {
        const P = padded(S);
        return arr.some(tok => tok && P.includes(padded(tok)));
    };

    // Aplica as regras declaradas no JSON (sem regex em código)
    if (shouldCheck.has('phrases') && hasAnySafe(phrases, s)) return true;
    if (shouldCheck.has('keywords') && hasAnySafe(keywords, s)) return true;
    if (shouldCheck.has('risk_terms') && hasAnySafe(riskTerms, s)) return true;

    return false;
}

function isOptIn(textRaw) {
    const data = loadOptInData();
    const cfg = data?.config || {};
    const s = normMsg(textRaw, cfg);
    if (!s) return false;

    // 1) Exceções: tokens ambíguos sozinhos NÃO contam
    const amb = new Set(
        (data?.exceptions?.ambiguous_single_tokens || [])
            .map(v => normMsg(v, cfg))
            .filter(Boolean)
    );
    if (amb.has(s)) return false;

    // 2) Achata allowlists por idioma
    const al = data?.allowlists || {};
    const langs = Object.keys(al);
    const flatten = (key) => {
        const out = [];
        for (const L of langs) {
            const arr = al[L]?.[key];
            if (Array.isArray(arr)) out.push(...arr);
        }
        return out;
    };

    const phrases = flatten('phrases').map(v => normMsg(v, cfg)).filter(Boolean);
    const keywords = flatten('keywords').map(v => normMsg(v, cfg)).filter(Boolean);
    const regexList = flatten('regex')
        .map(r => { try { return new RegExp(r, 'i'); } catch { return null; } })
        .filter(Boolean);

    // 3) Regras declarativas do JSON
    const rule = Array.isArray(data?.match_if_any) ? data.match_if_any : ['phrases', 'keywords', 'regex'];
    const shouldCheck = new Set(rule.map(x => String(x || '').toLowerCase()));
    const padded = (x) => ` ${x} `;
    const hasAnySafe = (arr, S) => {
        const P = padded(S);
        return arr.some(tok => tok && P.includes(padded(tok)));
    };

    if (shouldCheck.has('phrases') && hasAnySafe(phrases, s)) return true;
    if (shouldCheck.has('regex') && regexList.some(rx => rx.test(s))) return true;

    if (shouldCheck.has('keywords') && hasAnySafe(keywords, s)) {
        const POS = new RegExp(
            '\\b(' +
            'pode(?:\\s+sim)?\\s*(?:continuar|mandar|seguir|prosseguir|enviar)|' +
            'manda(?:\\s+ver|\\s+a[ií])?|' +
            'envia|continuar|continua|retomar|voltar|' +
            'segue|bora|vamos|quero|to dentro|tô dentro|aceito' +
            ')\\b',
            'i'
        );
        if (POS.test(s)) return true;
    }

    return false;
}

async function preflightOptOut(st) {
    if (!Array.isArray(st.mensagensPendentes) || !st.mensagensPendentes.length) return false;

    const pend = st.mensagensPendentes;
    let hardMatched = false;
    let hardText = '';

    // 1) Verificação hard-coded por mensagem (sempre ligada)
    for (const m of pend) {
        const t = safeStr(m?.texto || '');
        if (!t) continue;
        const res = isOptOut(t);
        console.log(`[${st.contato}] [OPTOUT][HARD] check="${truncate(t, 140)}" -> ${res ? 'MATCH' : 'nope'}`);
        if (res) { hardMatched = true; hardText = t; break; }
    }

    // 2) Se deu match hard-coded, aplica bloqueio/resposta
    if (hardMatched) {
        console.log(`[${st.contato}] [OPTOUT] HARD-MATCH acionado. texto="${truncate(hardText, 140)}"`);
        st.optedOutAtTs = Date.now();
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

function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min));
}

function pickLabelFromResponseData(data, allowed) {
    const S = new Set((allowed || []).map(s => String(s).toLowerCase()));
    let label =
        data?.output?.[0]?.content?.[0]?.json?.label ??
        data?.output?.[0]?.content?.[0]?.text ??
        data?.choices?.[0]?.message?.content ??
        data?.result ??
        data?.output_text ??
        (typeof data === 'string' ? data : '');
    if (typeof label === 'string') {
        const raw = label.trim();
        if (raw.startsWith('{') || raw.startsWith('[')) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed.label === 'string') label = parsed.label;
            } catch { }
        }
    }
    if (typeof label === 'string') {
        const rx = new RegExp(`\\b(${Array.from(S).join('|')})\\b`, 'i');
        const m = rx.exec(label.toLowerCase());
        if (m) label = m[1];
    }
    label = String(label || '').trim().toLowerCase();
    return S.has(label) ? label : null;
}

function truncate(s, n = 600) {
    const str = String(s || '');
    return str.length > n ? str.slice(0, n) + '…[truncated]' : str;
}

function extractTextForLog(data) {
    try {
        // 1) Campo “convenience” se vier preenchido
        if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;

        // 2) Novo Responses: varrer todos os blocos e pegar o 'output_text'
        if (Array.isArray(data?.output)) {
            for (const blk of data.output) {
                if (blk?.type === 'message' && Array.isArray(blk.content)) {
                    // prioriza o chunk de saída
                    const out = blk.content.find(c => c?.type === 'output_text' && typeof c?.text === 'string' && c.text.trim());
                    if (out) return out.text;
                    // fallback: primeiro content com texto não-vazio
                    const any = blk.content.find(c => typeof c?.text === 'string' && c.text.trim());
                    if (any) return any.text;
                }
            }
        }

        // 3) Fallbacks antigos (chat.completions / result)
        const cc = data?.choices?.[0]?.message?.content;
        if (typeof cc === 'string' && cc.trim()) return cc;
        if (typeof data?.result === 'string' && data.result.trim()) return data.result;

        return '';
    } catch {
        return '';
    }
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

            // opcional: log bruto quando der 4xx/5xx
            if (!(r.status >= 200 && r.status < 300)) {
                console.log(`[OPTOUT][IA][RAW] ${truncate(JSON.stringify(r.data), 800)}`);
            }

            // === mesma estratégia de parsing usada nas :wait ===
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

    // Zera buffer SEMPRE ao final da tentativa por etapa
    st.optoutBuffer = [];

    const aiOptOut = (resp.status >= 200 && resp.status < 300 && resp.picked === 'OPTOUT');

    if (!aiOptOut) {
        console.log(`[${st.contato}] [OPTOUT][IA] decisão=CONTINUAR (fim da etapa ${st.etapa})`);
        return false;
    }

    // === Aplicar bloqueio e mensagens (mesmo fluxo do hard-coded) ===
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
    return true; // bloqueou
}

function ensureEstado(contato) {
    const key = normalizeContato(contato) || 'desconhecido';
    if (!estadoContatos[key]) {
        estadoContatos[key] = {
            contato: key,
            etapa: 'abertura:send',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            mensagensPendentes: [],
            mensagensDesdeSolicitacao: [],
            enviandoMensagens: false,
            tid: '',
            click_type: 'Orgânico',
            sentHashes: new Set(),
            classificacaoAceite: null,
            classesSinceSolicitacao: [],
            lastClassifiedIdx: { interesse: 0, acesso: 0, confirmacao: 0, saque: 0, validacao: 0, conversao: 0 },
            saquePediuPrint: false,
            validacaoAwaitFirstMsg: false,
            validacaoTimeoutUntil: 0,
            conversaoBatch: 0,
            conversaoAwaitMsg: false,
            optOutCount: 0,
            permanentlyBlocked: false,
            reoptinActive: false,     // false enquanto "pausado" por opt-out
            reoptinLotsTried: 0,      // lotes IA já usados (máx 3)
            reoptinBuffer: [],        // acumula 1..3 msgs antes de consultar IA
            reoptinCount: 0,          // quantas retomadas já realizadas (máx 2)
            optedOutAtTs: 0,
            _reoptinInitTs: 0,
            stageCursor: {}
        };
    } else {
        const st = estadoContatos[key];
        st.updatedAt = Date.now();
        if (!Array.isArray(st.mensagensPendentes)) st.mensagensPendentes = [];
        if (!Array.isArray(st.mensagensDesdeSolicitacao)) st.mensagensDesdeSolicitacao = [];
        if (!(st.sentHashes instanceof Set)) st.sentHashes = new Set(Array.isArray(st.sentHashes) ? st.sentHashes : []);
        if (!st.lastClassifiedIdx) st.lastClassifiedIdx = { interesse: 0, acesso: 0, confirmacao: 0, saque: 0, validacao: 0, conversao: 0 };
        for (const k of ['interesse', 'acesso', 'confirmacao', 'saque', 'validacao', 'conversao']) {
            if (typeof st.lastClassifiedIdx[k] !== 'number' || st.lastClassifiedIdx[k] < 0) st.lastClassifiedIdx[k] = 0;
        }
        if (typeof st.saquePediuPrint !== 'boolean') st.saquePediuPrint = false;
        if (typeof st.validacaoAwaitFirstMsg !== 'boolean') st.validacaoAwaitFirstMsg = false;
        if (typeof st.validacaoTimeoutUntil !== 'number') st.validacaoTimeoutUntil = 0;
        if (typeof st.conversaoBatch !== 'number') st.conversaoBatch = 0;
        if (typeof st.conversaoAwaitMsg !== 'boolean') st.conversaoAwaitMsg = false;
        if (typeof st.optOutCount !== 'number') st.optOutCount = 0;
        if (typeof st.permanentlyBlocked !== 'boolean') st.permanentlyBlocked = false;
        if (typeof st.reoptinActive !== 'boolean') st.reoptinActive = false;
        if (typeof st.reoptinLotsTried !== 'number') st.reoptinLotsTried = 0;
        if (!Array.isArray(st.reoptinBuffer)) st.reoptinBuffer = [];
        if (typeof st.reoptinCount !== 'number') st.reoptinCount = 0;
        if (!st.stageCursor || typeof st.stageCursor !== 'object') st.stageCursor = {};
        if (typeof st.optoutLotsTried !== 'number') st.optoutLotsTried = 0;
        if (!Array.isArray(st.optoutBuffer)) st.optoutBuffer = [];
        if (!('optoutBatchStage' in st)) st.optoutBatchStage = null;
        if (typeof st._optoutSeenIdx !== 'number') st._optoutSeenIdx = 0;
        if (typeof st.optedOutAtTs !== 'number') st.optedOutAtTs = 0;
        if (typeof st._reoptinInitTs !== 'number') st._reoptinInitTs = 0;
    }
    return estadoContatos[key];
}

function inicializarEstado(contato, maybeTid, maybeClickType) {
    const st = ensureEstado(contato);
    if (typeof maybeTid === 'string') st.tid = maybeTid || st.tid || '';
    if (typeof maybeClickType === 'string') st.click_type = maybeClickType || st.click_type || 'Orgânico';
    return st;
}

async function criarUsuarioDjango(contato) {
    const st = ensureEstado(contato);
    if (st.createdUser === 'ok' || st.credenciais) return { ok: true, skipped: true };
    if (st.createdUser === 'pending') return { ok: true, skipped: 'pending' };
    st.createdUser = 'pending';
    const phone = st.contato.startsWith('+') ? st.contato : `+${st.contato}`;
    const payload = { tid: st.tid || '', click_type: st.click_type || 'Orgânico', phone };
    const URL = 'https://www.cointex.cash/api/create-user/';
    const tryOnce = async () =>
        axios.post(URL, payload, { timeout: 15000, validateStatus: () => true });
    try {
        let resp = await tryOnce();
        if (resp.status >= 500 || resp.status === 429) {
            const jitter = 1200 + Math.floor(Math.random() * 400);
            console.warn(`[Contato] Cointex retry agendado em ${jitter}ms: ${st.contato} HTTP ${resp.status}`);
            await delay(jitter);
            resp = await tryOnce();
        }
        const okHttp = resp.status >= 200 && resp.status < 300;
        const okBody = !resp.data?.status || resp.data?.status === 'success';
        if (okHttp && okBody) {
            const user = Array.isArray(resp.data?.users) ? resp.data.users[0] : null;
            if (user?.email && user?.password) {
                st.credenciais = {
                    email: user.email,
                    password: user.password,
                    login_url: user.login_url || ''
                };
            }
            st.createdUser = 'ok';
            console.log(`[Contato] Cointex criado: ${st.contato} ${st.credenciais?.email || ''}`.trim());
            return { ok: true, status: resp.status, data: resp.data };
        }
        const msg = resp.data?.message || `HTTP ${resp.status}`;
        st.createdUser = undefined;
        console.warn(`[Contato] Cointex ERRO: ${st.contato} ${msg}`);
        throw new Error(msg);
    } catch (err) {
        st.createdUser = undefined;
        console.warn(`[Contato] Cointex ERRO: ${st.contato} ${err.message || err}`);
        throw err;
    }
}

async function resolveManychatSubscriberId(contato, modOpt, settingsOpt) {
    const phone = String(contato || '').replace(/\D/g, '');
    const st = ensureEstado(phone);
    let subscriberId = null;
    try {
        const c = await getContatoByPhone(phone);
        if (c?.manychat_subscriber_id) subscriberId = String(c.manychat_subscriber_id);
    } catch { }
    if (!subscriberId && st?.manychat_subscriber_id) subscriberId = String(st.manychat_subscriber_id);
    if (subscriberId) return subscriberId;
    try {
        const { mod, settings } = (modOpt && settingsOpt) ? { mod: modOpt, settings: settingsOpt } : await getActiveTransport();
        const token = (settings && settings.manychat_api_token) || process.env.MANYCHAT_API_TOKEN || '';
        if (!token) return null;
        const phonePlus = phone.startsWith('+') ? phone : `+${phone}`;
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const call = async (method, url, data) => {
            try {
                return await axios({ method, url, data, headers, timeout: 12000, validateStatus: () => true });
            } catch { return { status: 0, data: null }; }
        };
        const tries = [
            { m: 'get', u: `https://api.manychat.com/whatsapp/subscribers/findByPhone?phone=${encodeURIComponent(phonePlus)}` },
            { m: 'post', u: 'https://api.manychat.com/whatsapp/subscribers/findByPhone', p: { phone: phonePlus } },
            { m: 'get', u: `https://api.manychat.com/fb/subscriber/findByPhone?phone=${encodeURIComponent(phonePlus)}` },
            { m: 'post', u: 'https://api.manychat.com/fb/subscriber/findByPhone', p: { phone: phonePlus } },
        ];
        for (const t of tries) {
            const r = await call(t.m, t.u, t.p);
            const d = r?.data || {};
            const id = d?.data?.id || d?.data?.subscriber_id || d?.subscriber?.id || d?.id || null;
            if (r.status >= 200 && r.status < 300 && id) { subscriberId = String(id); break; }
        }
        if (subscriberId) {
            try { await setManychatSubscriberId(phone, subscriberId); } catch { }
            st.manychat_subscriber_id = subscriberId;
            console.log(`[${phone}] manychat subscriber_id resolvido via API: ${subscriberId}`);
            return subscriberId;
        }
    } catch { }
    return null;
}

async function resolveManychatWaSubscriberId(contato, modOpt, settingsOpt) {
    const phone = String(contato || '').replace(/\D/g, '');
    console.log(`Debug resolve: phone=${phone}`);
    const st = ensureEstado(phone);
    let subscriberId = null;
    try {
        const c = await getContatoByPhone(phone);
        if (c?.manychat_subscriber_id) subscriberId = String(c.manychat_subscriber_id);
    } catch { }
    if (!subscriberId && st?.manychat_subscriber_id) subscriberId = String(st.manychat_subscriber_id);
    const { mod, settings } = (modOpt && settingsOpt) ? { mod: modOpt, settings: settingsOpt } : await getActiveTransport();
    const token = (settings && settings.manychat_api_token) || process.env.MANYCHAT_API_TOKEN || '';
    if (!token) return subscriberId || null;
    const phonePlus = phone.startsWith('+') ? phone : `+${phone}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const call = async (method, url, data) => {
        try {
            return await axios({ method, url, data, headers, timeout: 12000, validateStatus: () => true });
        } catch { return { status: 0, data: null }; }
    };
    const tries = [
        { m: 'get', u: `https://api.manychat.com/whatsapp/subscribers/findByPhone?phone=${encodeURIComponent(phonePlus)}` },
        { m: 'post', u: `https://api.manychat.com/whatsapp/subscribers/findByPhone`, p: { phone: phonePlus } },
    ];
    for (const t of tries) {
        const r = await call(t.m, t.u, t.p);
        const d = r?.data || {};
        const id = d?.data?.id || d?.data?.subscriber_id || d?.subscriber?.id || d?.id || null;
        if (r.status >= 200 && r.status < 300 && id) {
            subscriberId = String(id);
            break;
        }
    }
    if (subscriberId) {
        try { await setManychatSubscriberId(phone, subscriberId); } catch { }
        st.manychat_subscriber_id = subscriberId;
        console.log(`[${phone}] manychat WA subscriber_id resolvido: ${subscriberId}`);
        return subscriberId;
    }
    return null;
}

const sentHashesGlobal = new Set();
function hashText(s) { let h = 0, i, chr; const str = String(s); if (str.length === 0) return '0'; for (i = 0; i < str.length; i++) { chr = str.charCodeAt(i); h = ((h << 5) - h) + chr; h |= 0; } return String(h); }
function chooseUnique(generator, st) { const maxTries = 200; for (let i = 0; i < maxTries; i++) { const text = generator(); const h = hashText(text); if (!sentHashesGlobal.has(h) && !st.sentHashes.has(h)) { sentHashesGlobal.add(h); st.sentHashes.add(h); return text; } } return null; }

async function handleIncomingNormalizedMessage(normalized) {
    if (!normalized) return;
    const { contato, texto, temMidia, ts } = normalized;

    const hasText = !!safeStr(texto).trim();
    const hasMedia = !!temMidia;
    if (!hasText && !hasMedia) return;

    const st = ensureEstado(contato);
    const msg = hasText ? safeStr(texto).trim() : '[mídia]';
    log.info(`${tsNow()} [${st.contato}] Mensagem recebida: ${msg}`);
    st.lastIncomingTs = ts || Date.now();

    // >>> ENFILEIRA para que preflightOptOut()/processamento consigam detectar
    if (!Array.isArray(st.mensagensPendentes)) st.mensagensPendentes = [];
    if (!Array.isArray(st.mensagensDesdeSolicitacao)) st.mensagensDesdeSolicitacao = [];

    st.mensagensPendentes.push({ texto: msg, ts: st.lastIncomingTs });
    st.mensagensDesdeSolicitacao.push(msg);
}

function init(options = {}) {
    if (options.logger) {
        const { info, warn, error } = options.logger;
        if (typeof info === 'function' && typeof warn === 'function' && typeof error === 'function') log = options.logger;
    }
    return { ok: true };
}

async function handleManyChatWebhook(body) {
    try {
        const pickPath = (obj, paths) => {
            for (const p of paths) {
                try {
                    const val = p.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
                    if (val !== undefined && val !== null && String(val).trim() !== '') return val;
                } catch { }
            }
            return null;
        };
        const subscriberId = pickPath(body, [
            'subscriber.id',
            'data.subscriber.id',
            'event.data.subscriber.id',
            'event.subscriber.id',
            'user.id',
            'subscriber_id',
            'contact.id'
        ]);
        let phone = pickPath(body, [
            'subscriber.phone',
            'data.subscriber.phone',
            'event.data.subscriber.phone',
            'event.subscriber.phone',
            'user.phone',
            'contact.phone',
            'phone',
            'message.from'
        ]);
        phone = phone ? String(phone).replace(/\D/g, '') : '';
        if (!subscriberId || !phone) {
            console.log(`[ManyChat][webhook] ignorado: subscriberId=${subscriberId || 'null'} phone=${phone || 'null'} payload=${truncate(JSON.stringify(body))}`);
            return { ok: true, ignored: true };
        }
        await setManychatSubscriberId(phone, subscriberId);
        const st = ensureEstado(phone);
        st.manychat_subscriber_id = String(subscriberId);
        console.log(`[ManyChat][webhook] vinculado phone=${phone} subscriber_id=${subscriberId}`);
        return { ok: true, linked: true };
    } catch (e) {
        console.warn(`[ManyChat][webhook] erro: ${e?.message || e}`);
        return { ok: false, error: e?.message || String(e) };
    }
}

async function processarMensagensPendentes(contato) {
    const st = ensureEstado(contato);
    if (st.enviandoMensagens) {
        await preflightOptOut(st);
        const pend = Array.isArray(st.mensagensPendentes) ? st.mensagensPendentes : [];
        const hadOptOut = pend.some(m => isOptOut(m?.texto || ''));

        if (hadOptOut) {
            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.enviandoMensagens = false;

            st.optOutCount = (st.optOutCount || 0) + 1;
            st.reoptinActive = false;
            st.reoptinLotsTried = 0;
            st.reoptinBuffer = [];

            if (st.optOutCount >= 3) {
                st.permanentlyBlocked = true;
                if (st.etapa !== 'encerrado:wait') {
                    const _prev = st.etapa;
                    st.etapa = 'encerrado:wait';
                    console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                }
            }

            // Confirmação de opt-out (1ª e 2ª vezes)
            const oMsgs = loadOptOutMsgs();
            const pick = arr => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
            let texto = '';
            if (st.optOutCount === 1) {
                const p = oMsgs?.msg1 || {};
                const b1 = pick(p.msg1b1);
                const b2 = pick(p.msg1b2);
                const b3 = pick(p.msg1b3);
                texto = [b1, b2].filter(Boolean).join(', ') + (b3 ? `. ${b3}` : '');
            } else if (st.optOutCount === 2) {
                const p = oMsgs?.msg2 || {};
                const b1 = pick(p.msg2b1);
                const b2 = pick(p.msg2b2);
                const b3 = pick(p.msg2b3);
                const b4 = pick(p.msg2b4);
                const b5 = pick(p.msg2b5);
                texto =
                    [b1, b2].filter(Boolean).join(', ') +
                    (b3 ? ` ${b3}` : '') +
                    (b4 ? `. ${b4}` : '') +
                    (b5 ? `, ${b5}` : '');
            }
            if (texto) {
                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                await sendMessage(st.contato, texto, { force: true });
            }
            return { ok: true, optout: st.optOutCount, interrupted: true };
        }

        return { ok: true, skipped: 'busy' };
    }

    st.enviandoMensagens = true;
    try {
        console.log(`${tsNow()} [${st.contato}] etapa=${st.etapa} pendentes=${st.mensagensPendentes.length}`);
        enterStageOptOutResetIfNeeded(st);

        if (st.permanentlyBlocked || st.optOutCount >= 3) {
            st.permanentlyBlocked = true;
            if (st.etapa !== 'encerrado:wait') {
                const _prev = st.etapa;
                st.etapa = 'encerrado:wait';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
            }
            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            return { ok: true, noop: 'permanently-blocked' };
        }

        if (Array.isArray(st.mensagensPendentes) && st.mensagensPendentes.length) {
            const hadOptOut = st.mensagensPendentes.some(m => isOptOut(m?.texto || ''));
            if (hadOptOut) {
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.enviandoMensagens = false;

                st.optOutCount = (st.optOutCount || 0) + 1;
                st.reoptinActive = false;
                st.reoptinLotsTried = 0;
                st.reoptinBuffer = [];

                if (st.optOutCount >= 3) {
                    st.permanentlyBlocked = true;
                    const _prev = st.etapa;
                    st.etapa = 'encerrado:wait';
                    console.log(`[${st.contato}] opt-out #${st.optOutCount} => bloqueio permanente | ${_prev} -> ${st.etapa}`);
                    return { ok: true, status: 'blocked-forever' };
                }

                // enviar confirmação de opt-out (1ª e 2ª vezes)
                const oMsgs = loadOptOutMsgs();
                const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                let texto = '';
                if (st.optOutCount === 1) {
                    const p = oMsgs?.msg1 || {};
                    const b1 = pick(p.msg1b1);
                    const b2 = pick(p.msg1b2);
                    const b3 = pick(p.msg1b3);
                    texto = [b1, b2].filter(Boolean).join(', ') + (b3 ? `. ${b3}` : '');
                } else if (st.optOutCount === 2) {
                    const p = oMsgs?.msg2 || {};
                    const b1 = pick(p.msg2b1);
                    const b2 = pick(p.msg2b2);
                    const b3 = pick(p.msg2b3);
                    const b4 = pick(p.msg2b4);
                    const b5 = pick(p.msg2b5);
                    texto =
                        [b1, b2].filter(Boolean).join(', ') +
                        (b3 ? ` ${b3}` : '') +
                        (b4 ? `. ${b4}` : '') +
                        (b5 ? `, ${b5}` : '');
                }
                if (texto) {
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    await sendMessage(st.contato, texto, { force: true });
                }
                return { ok: true, optout: st.optOutCount };
            }
        }

        if (st.optOutCount > 0 && !st.reoptinActive) {
            // Inicializa UMA vez por janela de re-opt-in (logo após o último opt-out)
            const isNewWindow = !st._reoptinInitTs || st._reoptinInitTs < (st.optedOutAtTs || 0);
            if (isNewWindow) {
                st._reoptinInitTs = Date.now();
                st.reoptinBuffer = [];
                st.reoptinLotsTried = 0;
                console.log(`[${st.contato}] [REOPTIN][INIT] nova janela pós opt-out @${st._reoptinInitTs}`);
            }
            const cutoffTs = Number(st.optedOutAtTs || 0);
            if (Array.isArray(st.mensagensPendentes) && st.mensagensPendentes.length) {
                console.log(`[${st.contato}] [REOPTIN] pend=${st.mensagensPendentes.length} lotsTried=${st.reoptinLotsTried} buf=${st.reoptinBuffer.length}`);

                let matched = false;
                let matchedText = '';

                // 1) Hard-coded (imediato)
                for (const m of st.mensagensPendentes) {
                    const t = m?.texto || '';
                    if (!t) continue;
                    const hard = isOptIn(t);
                    console.log(`[${st.contato}] [REOPTIN][HARD] check="${truncate(t, 140)}" -> ${hard ? 'MATCH' : 'nope'}`);
                    if (hard) { matched = true; matchedText = t; }
                    if (matched) break;
                }

                // 2) Se não houve hard, acumula e dispare IA de 3 em 3 mensagens, até 3 lotes
                if (!matched) {
                    const apiKey = process.env.OPENAI_API_KEY;
                    const canIa = apiKey && typeof promptClassificaReoptin === 'function';

                    for (const m of st.mensagensPendentes) {
                        const t = safeStr(m?.texto || '').trim();
                        const mts = Number(m?.ts || 0);
                        if (!t) continue;
                        if (cutoffTs && mts && mts <= cutoffTs) continue;
                        st.reoptinBuffer.push(t);
                        console.log(`[${st.contato}] [REOPTIN][BATCH][PUSH] size=${st.reoptinBuffer.length} msg="${truncate(t, 140)}"`);

                        if (st.reoptinBuffer.length === 3 && st.reoptinLotsTried < 3 && canIa) {
                            const joined = st.reoptinBuffer.join(' | ');
                            const structuredPrompt =
                                `${promptClassificaReoptin(joined)}\n\n` +
                                `Output only valid JSON as {"label": "optin"} or {"label": "nao_optin"}`;

                            const ask = async (maxTok) => {
                                try {
                                    const r = await axios.post('https://api.openai.com/v1/responses', {
                                        model: 'gpt-5',
                                        input: structuredPrompt,
                                        max_output_tokens: maxTok,
                                        reasoning: { effort: 'low' }
                                    }, {
                                        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                                        timeout: 15000,
                                        validateStatus: () => true
                                    });
                                    console.log(
                                        `${tsNow()} [${st.contato}] [REOPTIN][IA][RAW] http=${r.status} ` +
                                        `req=${r.headers?.['x-request-id'] || ''} ` +
                                        `body=${truncate(JSON.stringify(r.data), 20000)}`
                                    );
                                    let rawText = extractTextForLog(r.data) || '';
                                    rawText = String(rawText).trim();
                                    let picked = null;
                                    try { const parsed = JSON.parse(rawText); picked = String(parsed?.label || '').toLowerCase(); }
                                    catch {
                                        const mm = /"label"\s*:\s*"([^"]+)"/i.exec(rawText);
                                        if (mm && mm[1]) picked = mm[1].toLowerCase();
                                    }
                                    if (!picked) picked = pickLabelFromResponseData(r.data, ['optin', 'nao_optin']);
                                    console.log(`[${st.contato}] [REOPTIN][BATCH->IA] try #${st.reoptinLotsTried + 1} size=3 picked=${picked || 'null'} sample="${truncate(joined, 200)}"`);
                                    return picked || null;
                                } catch (e) {
                                    console.log(`[${st.contato}] [REOPTIN][IA] erro="${e?.message || e}"`);
                                    return null;
                                }
                            };

                            let out = await ask(48);
                            if (!out) out = await ask(128);

                            st.reoptinLotsTried += 1;
                            matched = (out === 'optin');
                            matchedText = matched ? (st.reoptinBuffer[st.reoptinBuffer.length - 1] || '') : '';
                            st.reoptinBuffer = []; // limpa o lote SEMPRE entre tentativas

                            if (matched) break;
                            if (st.reoptinLotsTried >= 3) break; // atingiu o limite
                        }
                    }
                }

                // 3) Decisão
                st.mensagensPendentes = [];

                if (matched) {
                    console.log(`[${st.contato}] re-opt-in DETECTADO: "${truncate(matchedText, 140)}"`);
                    st.reoptinActive = true;
                    st.reoptinLotsTried = 0;
                    st.reoptinBuffer = [];
                    st.reoptinCount = (st.reoptinCount || 0) + 1;
                    st.mensagensDesdeSolicitacao = [];
                    st._reoptinInitTs = 0;

                    const iMsgs = loadOptInMsgs();
                    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                    let texto = '';
                    if (st.reoptinCount === 1) {
                        const p = iMsgs?.msg1 || {};
                        texto = [pick(p.msg1b1), pick(p.msg1b2)].filter(Boolean).join(', ');
                    } else {
                        const p = iMsgs?.msg2 || {};
                        texto = [pick(p.msg2b1), pick(p.msg2b2), pick(p.msg2b3)].filter(Boolean).join('. ');
                    }
                    if (texto) {
                        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                        await sendMessage(st.contato, texto, { force: true });
                    }
                } else {
                    // Se chegou a 3 tentativas e não detectou -> encerrar e parar análises
                    if (st.reoptinLotsTried >= 3) {
                        console.log(`[${st.contato}] [REOPTIN][STOP] 3 lotes sem opt-in -> encerrado:wait`);
                        st.etapa = 'encerrado:wait';
                        st.reoptinBuffer = [];
                        st.reoptinActive = false;
                        st._reoptinInitTs = 0;
                        return { ok: true, paused: true, ended: true };
                    }
                    return { ok: true, paused: true };
                }
            }
        }

        if (st.etapa === 'abertura:send') {
            enterStageOptOutResetIfNeeded(st);
            const aberturaPath = path.join(__dirname, 'content', 'abertura.json');
            let aberturaData = null;
            const loadAbertura = () => {
                if (aberturaData) return aberturaData;
                let raw = fs.readFileSync(aberturaPath, 'utf8');
                raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                aberturaData = JSON.parse(raw);
                return aberturaData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
            const composeAberturaMsg1 = () => {
                const c = loadAbertura();
                const g1 = pick(c?.msg1?.grupo1);
                const g2 = pick(c?.msg1?.grupo2);
                const g3 = pick(c?.msg1?.grupo3);
                return [g1, g2, g3].filter(Boolean).join(', ');
            };
            const composeAberturaMsg2 = () => {
                const c = loadAbertura();
                const g1 = pick(c?.msg2?.grupo1);
                const g2 = pick(c?.msg2?.grupo2);
                const g3 = pick(c?.msg2?.grupo3);
                const head = [g1, g2].filter(Boolean).join(' ');
                return [head, g3].filter(Boolean).join(', ');
            };

            // gere as duas mensagens (mantém "unique" quando possível)
            const m1 = chooseUnique(composeAberturaMsg1, st) || composeAberturaMsg1();
            const m2 = chooseUnique(composeAberturaMsg2, st) || composeAberturaMsg2();
            const msgs = [m1, m2];

            // retoma exatamente de onde parou
            let cur = Number(st.stageCursor?.[st.etapa] || 0);

            for (let i = cur; i < msgs.length; i++) {
                // se entrou um opt-out agora, não avança etapa nem cursor
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-pre-batch' };
                }

                if (!msgs[i]) {
                    // msg vazia: considere como enviada para fins de cursor
                    st.stageCursor[st.etapa] = i + 1;
                    continue;
                }

                // delays do fluxo original
                if (i === 0) {
                    await delay(FIRST_REPLY_DELAY_MS);
                } else {
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                }

                // tentativa de envio (NÃO avançar cursor/etapa se skip)
                const r = await sendMessage(st.contato, msgs[i]);

                if (!r?.ok) {
                    // aqui pega "paused-by-optout" e similares — não muda etapa
                    return { ok: true, paused: r?.reason || 'send-skipped', idx: i };
                }

                // enviado com sucesso -> atualiza cursor
                st.stageCursor[st.etapa] = i + 1;

                // se rolou opt-out depois do envio, ainda assim não avançamos etapa
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-mid-batch' };
                }
            }

            // só chega aqui se as DUAS mensagens saíram com ok:true
            if ((st.stageCursor[st.etapa] || 0) >= msgs.length) {
                if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
                st.stageCursor[st.etapa] = 0;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.interesse = 0;

                const _prev = st.etapa;
                if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
                st.etapa = 'abertura:wait';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                return { ok: true };
            }

            // envio parcial (ficou travado entre m1 e m2 por opt-out)
            return { ok: true, partial: true };
        }

        if (st.etapa === 'abertura:wait') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            const _prev = st.etapa;
            st.etapa = 'interesse:send';
            console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        }

        if (st.etapa === 'interesse:send') {
            enterStageOptOutResetIfNeeded(st);
            const interessePath = path.join(__dirname, 'content', 'interesse.json');
            let interesseData = null;
            const loadInteresse = () => {
                if (interesseData) return interesseData;
                const raw = fs.readFileSync(interessePath, 'utf8');
                interesseData = JSON.parse(raw);
                return interesseData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
            const composeInteresseMsg = () => {
                const c = loadInteresse();
                const g1 = pick(c?.msg?.g1);
                const g2 = pick(c?.msg?.g2);
                const g3 = pick(c?.msg?.g3);
                const g4 = pick(c?.msg?.g4);
                const g5 = pick(c?.msg?.g5);
                return `${[g1, g2].filter(Boolean).join(', ')}... ${[g3, g4, g5].filter(Boolean).join(', ')}`.replace(/\s+,/g, ',');
            };

            const mi = chooseUnique(composeInteresseMsg, st) || composeInteresseMsg();

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-pre-single' };

            let r = { ok: true };
            if (mi) r = await sendMessage(st.contato, mi);

            if (!r?.ok) {
                st.mensagensPendentes = [];
                return { ok: true, paused: r?.reason || 'send-skipped' };
            }

            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-single' };

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.interesse = 0;

            const _prev = st.etapa;
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
            st.etapa = 'interesse:wait';
            console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'interesse:wait') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };
            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.interesse || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }
            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;
            let classes = [];
            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                const prompt = promptClassificaAceite(msg);
                let msgClass = 'duvida';
                if (apiKey) {
                    const allowed = ['aceite', 'recusa', 'duvida'];
                    const structuredPrompt = `${prompt}\n\nOutput only this valid JSON format with double quotes around keys and values, nothing else: {"label": "aceite"} or {"label": "recusa"} or {"label": "duvida"}`;
                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
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
                        } catch {
                            return { status: 0, picked: null };
                        }
                        const data = r.data;
                        let rawText = '';
                        if (Array.isArray(data?.output)) {
                            data.output.forEach(item => {
                                if (item.type === 'message' && Array.isArray(item.content) && item.content[0]?.text) {
                                    rawText = item.content[0].text;
                                }
                            });
                        }
                        if (!rawText) rawText = extractTextForLog(data);
                        rawText = String(rawText || '').trim();
                        let picked = null;
                        if (rawText) {
                            try {
                                const parsed = JSON.parse(rawText);
                                if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                            } catch {
                                const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                                if (m && m[1]) picked = m[1].toLowerCase().trim();
                            }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, allowed);
                        return { status: r.status, picked };
                    };
                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) {
                            resp = await callOnce(256);
                        }
                        if (resp.status >= 200 && resp.status < 300 && resp.picked) {
                            msgClass = resp.picked;
                        }
                    } catch { }
                }
                console.log(`[${st.contato}] Análise: ${msgClass} ("${truncate(msg, 140)}")`);
                classes.push(msgClass);
            }
            st.lastClassifiedIdx.interesse = total;
            let classe = 'duvida';
            const nonDuvida = classes.filter(c => c !== 'duvida');
            classe = nonDuvida.length > 0 ? nonDuvida[nonDuvida.length - 1] : 'duvida';
            st.classificacaoAceite = classe;
            st.mensagensPendentes = [];
            if (classe === 'aceite') {
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.interesse = 0;
                const _prev = st.etapa;
                st.etapa = 'instrucoes:send';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
            } else {
                return { ok: true, classe };
            }
        }

        if (st.etapa === 'instrucoes:send') {
            enterStageOptOutResetIfNeeded(st);
            const instrucoesPath = path.join(__dirname, 'content', 'instrucoes.json');
            let instrucoesData = null;
            const loadInstrucoes = () => {
                if (instrucoesData) return instrucoesData;
                let raw = fs.readFileSync(instrucoesPath, 'utf8');
                raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                instrucoesData = JSON.parse(raw);
                return instrucoesData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
            const composeMsg1 = () => {
                const c = loadInstrucoes();
                const g1 = pick(c?.msg1?.grupo1);
                const g2 = pick(c?.msg1?.grupo2);
                const g3 = pick(c?.msg1?.grupo3);
                return [g1 && `${g1}?`, g2 && `${g2}…`, g3 && `${g3}:`].filter(Boolean).join(' ');
            };
            const composeMsg2 = () => {
                const c = loadInstrucoes();
                const p1 = [pick(c?.pontos?.p1?.g1), pick(c?.pontos?.p1?.g2), pick(c?.pontos?.p1?.g3)].filter(Boolean).join(', ');
                const p2 = [pick(c?.pontos?.p2?.g1), pick(c?.pontos?.p2?.g2), pick(c?.pontos?.p2?.g3)].filter(Boolean).join(', ');
                const p3 = [pick(c?.pontos?.p3?.g1), pick(c?.pontos?.p3?.g2), pick(c?.pontos?.p3?.g3)].filter(Boolean).join(', ');
                const p4 = [pick(c?.pontos?.p4?.g1), pick(c?.pontos?.p4?.g2), pick(c?.pontos?.p4?.g3)].filter(Boolean).join(', ');
                let out = [`• ${p1}`, '', `• ${p2}`, '', `• ${p3}`, '', `• ${p4}`].join('\n');
                out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                return out;
            };
            const composeMsg3 = () => {
                const c = loadInstrucoes();
                const g1 = pick(c?.msg3?.grupo1);
                const g2 = pick(c?.msg3?.grupo2);
                return [g1 && `${g1}…`, g2 && `${g2}?`].filter(Boolean).join(' ');
            };

            const m1 = composeMsg1();
            const m2 = composeMsg2();
            const m3 = composeMsg3();
            const msgs = [m1, m2, m3];

            let cur = Number(st.stageCursor?.[st.etapa] || 0);
            for (let i = cur; i < msgs.length; i++) {
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-pre-batch' };
                }
                if (!msgs[i]) continue;
                // delays específicos do fluxo original
                if (i === 0) await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                if (i === 1) { await delayRange(20000, 30000); await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS); }
                if (i === 2) await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

                const r = await sendMessage(st.contato, msgs[i]);
                if (!r?.ok) break; // se bloqueado por opt-out no meio

                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-mid-batch' };
                }

                st.stageCursor[st.etapa] = i + 1;
            }

            if ((st.stageCursor[st.etapa] || 0) >= msgs.length) {
                if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
                st.stageCursor[st.etapa] = 0;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.acesso = 0;
                st.lastClassifiedIdx.confirmacao = 0;
                st.lastClassifiedIdx.saque = 0;
                const _prev = st.etapa;
                if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
                st.etapa = 'instrucoes:wait';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                return { ok: true };
            }
            return { ok: true, partial: true };
        }

        if (st.etapa === 'instrucoes:wait') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };
            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.acesso || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }
            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;
            let classes = [];
            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                const prompt = promptClassificaAceite(msg);
                let msgClass = 'duvida';
                if (apiKey) {
                    const allowed = ['aceite', 'recusa', 'duvida'];
                    const structuredPrompt = `${prompt}\n\nOutput only this valid JSON format with double quotes around keys and values, nothing else: {"label": "aceite"} or {"label": "recusa"} or {"label": "duvida"}`;
                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
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
                        } catch {
                            return { status: 0, picked: null };
                        }
                        const data = r.data;
                        let rawText = '';
                        if (Array.isArray(data?.output)) {
                            data.output.forEach(item => {
                                if (item.type === 'message' && Array.isArray(item.content) && item.content[0]?.text) {
                                    rawText = item.content[0].text;
                                }
                            });
                        }
                        if (!rawText) rawText = extractTextForLog(data);
                        rawText = String(rawText || '').trim();
                        let picked = null;
                        if (rawText) {
                            try {
                                const parsed = JSON.parse(rawText);
                                if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                            } catch {
                                const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                                if (m && m[1]) picked = m[1].toLowerCase().trim();
                            }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, allowed);
                        return { status: r.status, picked };
                    };
                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) {
                            resp = await callOnce(256);
                        }
                        if (resp.status >= 200 && resp.status < 300 && resp.picked) {
                            msgClass = resp.picked;
                        }
                    } catch { }
                }
                console.log(`[${st.contato}] Análise: ${msgClass} ("${truncate(msg, 140)}")`);
                classes.push(msgClass);
            }
            st.lastClassifiedIdx.acesso = total;
            let classe = 'duvida';
            const nonDuvida = classes.filter(c => c !== 'duvida');
            classe = nonDuvida.length > 0 ? nonDuvida[nonDuvida.length - 1] : 'duvida';
            st.classificacaoAceite = classe;
            if (classe === 'aceite') {
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.interesse = 0;
                st.lastClassifiedIdx.acesso = 0;
                st.lastClassifiedIdx.confirmacao = 0;
                st.lastClassifiedIdx.saque = 0;
                const _prev = st.etapa;
                st.etapa = 'acesso:send';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
            } else {
                st.mensagensPendentes = [];
                return { ok: true, classe };
            }
        }

        if (st.etapa === 'acesso:send') {
            enterStageOptOutResetIfNeeded(st);
            const acessoPath = path.join(__dirname, 'content', 'acesso.json');
            let acessoData = null;
            const loadAcesso = () => {
                if (acessoData) return acessoData;
                let raw = fs.readFileSync(acessoPath, 'utf8');
                raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                acessoData = JSON.parse(raw);
                return acessoData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length
                ? arr[Math.floor(Math.random() * arr.length)]
                : '';
            if (!st.credenciais?.email || !st.credenciais?.password || !st.credenciais?.login_url) {
                try { await criarUsuarioDjango(st.contato); } catch (e) { console.warn(`[${st.contato}] criarUsuarioDjango falhou: ${e?.message || e}`); }
            }
            const cred = (st.credenciais && typeof st.credenciais === 'object') ? st.credenciais : {};
            const email = safeStr(cred.email).trim();
            const senha = safeStr(cred.password).trim();
            const link = safeStr(cred.login_url).trim();
            if (!email || !senha || !link) {
                console.warn(`[${st.contato}] Credenciais incompletas; abortando acesso:send. email=${!!email} senha=${!!senha} link=${!!link}`);
                st.mensagensPendentes = [];
                return { ok: false, reason: 'missing-credentials' };
            }
            const c = loadAcesso();
            const msg1 = [
                `${pick(c?.msg1?.bloco1A) || ''} ${pick(c?.msg1?.bloco2A) ? ', ' + pick(c?.msg1?.bloco2A) : ''}:`.trim(),
                '',
                `${pick(c?.msg1?.bloco3A) || 'E-mail'}:`,
                email,
                '',
                'Senha:'
            ].join('\n');
            const msg2 = String(senha);
            const msg3 = [
                `${pick(c?.msg3?.bloco1C) || 'entra nesse link'}:`,
                '',
                link,
                '',
                `${[pick(c?.msg3?.bloco2C), pick(c?.msg3?.bloco3C)].filter(Boolean).join(', ')}`
            ].join('\n');

            const msgs = [msg1, msg2, msg3];
            let cur = Number(st.stageCursor?.[st.etapa] || 0);
            for (let i = cur; i < msgs.length; i++) {
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-pre-batch' };
                }
                if (!msgs[i]) continue;
                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                const r = await sendMessage(st.contato, msgs[i]);
                if (!r?.ok) break;
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-mid-batch' };
                }
                st.stageCursor[st.etapa] = i + 1;
            }
            if ((st.stageCursor[st.etapa] || 0) >= msgs.length) {
                if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
                st.stageCursor[st.etapa] = 0;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.acesso = 0;
                const _prev = st.etapa;
                if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
                st.etapa = 'acesso:wait';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                return { ok: true };
            }
            return { ok: true, partial: true };
        }

        if (st.etapa === 'acesso:wait') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };
            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.acesso || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }
            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;
            const allowed = ['confirmado', 'nao_confirmado', 'duvida', 'neutro'];
            let classes = [];
            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                let msgClass = 'neutro';
                if (apiKey) {
                    const structuredPrompt =
                        `${promptClassificaAcesso(msg)}\n\n` +
                        `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
                        `{"label": "confirmado"} or {"label": "nao_confirmado"} or {"label": "duvida"} or {"label": "neutro"}`;
                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
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
                        } catch {
                            return { status: 0, picked: null };
                        }
                        const data = r.data;
                        let rawText = '';
                        if (Array.isArray(data?.output)) {
                            data.output.forEach(item => {
                                if (item.type === 'message' && Array.isArray(item.content) && item.content[0]?.text) {
                                    rawText = item.content[0].text;
                                }
                            });
                        }
                        if (!rawText) rawText = extractTextForLog(data);
                        rawText = String(rawText || '').trim();
                        let picked = null;
                        if (rawText) {
                            try {
                                const parsed = JSON.parse(rawText);
                                if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                            } catch {
                                const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                                if (m && m[1]) picked = m[1].toLowerCase().trim();
                            }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, allowed);
                        return { status: r.status, picked };
                    };
                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) {
                            resp = await callOnce(256);
                        }
                        if (resp.status >= 200 && resp.status < 300 && resp.picked) {
                            msgClass = resp.picked;
                        }
                    } catch { }
                }
                console.log(`[${st.contato}] Análise: ${msgClass} ("${truncate(msg, 140)}")`);
                classes.push(msgClass);
            }
            st.lastClassifiedIdx.acesso = total;
            st.mensagensPendentes = [];
            if (classes.includes('confirmado')) {
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.acesso = 0;
                const _prev = st.etapa;
                st.etapa = 'confirmacao:send';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
            } else {
                const ultima = classes[classes.length - 1] || 'neutro';
                return { ok: true, classe: ultima };
            }
        }

        if (st.etapa === 'confirmacao:send') {
            enterStageOptOutResetIfNeeded(st);
            const confirmacaoPath = path.join(__dirname, 'content', 'confirmacao.json');
            let confirmacaoData = null;
            const loadConfirmacao = () => {
                if (confirmacaoData) return confirmacaoData;
                let raw = fs.readFileSync(confirmacaoPath, 'utf8');
                raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                confirmacaoData = JSON.parse(raw);
                return confirmacaoData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length
                ? arr[Math.floor(Math.random() * arr.length)]
                : '';
            const composeConfirmacaoMsg = () => {
                const c = loadConfirmacao();
                const b1 = pick(c?.msg1?.bloco1);
                const b2 = pick(c?.msg1?.bloco2);
                const b3 = pick(c?.msg1?.bloco3);
                return [b1, b2, b3].filter(Boolean).join(', ');
            };

            const m = chooseUnique(composeConfirmacaoMsg, st) || composeConfirmacaoMsg();

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

            // se houver opt-out agora, não envia e não avança
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-pre-single' };

            let r = { ok: true };
            if (m) r = await sendMessage(st.contato, m);

            // ENVIO FALHOU/FOI SKIPPED -> NÃO AVANÇA ETAPA
            if (!r?.ok) {
                return { ok: true, paused: r?.reason || 'send-skipped' };
            }

            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-single' };

            // só avança se enviou com sucesso
            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.confirmacao = 0;
            const _prev = st.etapa;
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
            st.etapa = 'confirmacao:wait';
            console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'confirmacao:wait') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };
            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.confirmacao || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }
            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;
            const looksLikeMediaUrl = (s) => {
                const n = String(s || '');
                return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
                    || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
            };
            let confirmado = false;
            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                if (looksLikeMediaUrl(msg) || /^\[m[ií]dia\]$/i.test(msg)) {
                    console.log(`[${st.contato}] Análise: confirmado ("${truncate(msg, 140)}")`);
                    confirmado = true;
                    break;
                }
            }
            if (!confirmado && apiKey) {
                const allowed = ['confirmado', 'nao_confirmado', 'duvida', 'neutro'];
                const contexto = novasMsgs.map(s => safeStr(s)).join(' | ');
                const structuredPrompt =
                    `${promptClassificaConfirmacao(contexto)}\n\n` +
                    `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
                    `{"label": "confirmado"} or {"label": "nao_confirmado"} or {"label": "duvida"} or {"label": "neutro"}`;
                const callOnce = async (maxTok) => {
                    let r;
                    try {
                        r = await axios.post(
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
                    } catch {
                        return { status: 0, picked: null };
                    }
                    const data = r.data;
                    let rawText = '';
                    if (Array.isArray(data?.output)) {
                        data.output.forEach(item => {
                            if (item.type === 'message' && Array.isArray(item.content) && item.content[0]?.text) {
                                rawText = item.content[0].text;
                            }
                        });
                    }
                    if (!rawText) rawText = extractTextForLog(data);
                    rawText = String(rawText || '').trim();
                    let picked = null;
                    if (rawText) {
                        try {
                            const parsed = JSON.parse(rawText);
                            if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                        } catch {
                            const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                            if (m && m[1]) picked = m[1].toLowerCase().trim();
                        }
                    }
                    if (!picked) picked = pickLabelFromResponseData(data, allowed);
                    return { status: r.status, picked };
                };
                try {
                    let resp = await callOnce(64);
                    if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) {
                        resp = await callOnce(256);
                    }
                    confirmado = (resp.status >= 200 && resp.status < 300 && resp.picked === 'confirmado');
                    console.log(`[${st.contato}] Análise: ${resp.picked || 'neutro'} ("${truncate(contexto, 140)}")`);
                } catch { }
            }
            st.lastClassifiedIdx.confirmacao = total;
            st.mensagensPendentes = [];
            if (confirmado) {
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.saque = 0;
                const _prev = st.etapa;
                st.etapa = 'saque:send';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
            } else {
                return { ok: true, classe: 'standby' };
            }
        }

        if (st.etapa === 'saque:send') {
            enterStageOptOutResetIfNeeded(st);
            const saquePath = path.join(__dirname, 'content', 'saque.json');
            let saqueData = null;
            function gerarSenhaAleatoria() { return String(Math.floor(1000 + Math.random() * 9000)); }
            const loadSaque = () => {
                if (saqueData) return saqueData;
                let raw = fs.readFileSync(saquePath, 'utf8');
                raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                saqueData = JSON.parse(raw);
                return saqueData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
            const composeMsg1 = () => {
                const c = loadSaque();
                const m = c?.msg1 || {};
                return `${[pick(m.m1b1), pick(m.m1b2)].filter(Boolean).join(' ')}: ${[pick(m.m1b3), pick(m.m1b4)].filter(Boolean).join(', ')}${pick(m.m1b5) ? '… ' + pick(m.m1b5) : ''}${pick(m.m1b6) ? ', ' + pick(m.m1b6) : ''}`.trim();
            };
            const composeMsg2 = () => {
                const c = loadSaque();
                const m = c?.msg2 || {};
                const s1 = gerarSenhaAleatoria();
                const s2 = '8293';
                const s3 = gerarSenhaAleatoria();
                const header = [pick(m.m2b1), pick(m.m2b2)].filter(Boolean).join(', ');
                const headLine = header ? `${header}:` : '';
                return `${headLine}\n\n${s1}\n${s2}\n${s3}`.trim();
            };
            const composeMsg3 = () => {
                const c = loadSaque();
                const m = c?.msg3 || {};
                const left = [pick(m.m3b1), pick(m.m3b2)].filter(Boolean).join(', ');
                const right = [pick(m.m3b3)].filter(Boolean).join('');
                const tail = [pick(m.m3b4), pick(m.m3b5), pick(m.m3b6)].filter(Boolean).join(', ');
                return `${[left, right && `${right}!`].filter(Boolean).join(' ')}${tail ? ` ${tail}` : ''}`.trim();
            };

            const m1 = chooseUnique(composeMsg1, st) || composeMsg1();
            const m2 = chooseUnique(composeMsg2, st) || composeMsg2();
            const m3 = chooseUnique(composeMsg3, st) || composeMsg3();
            const msgs = [m1, m2, m3];

            let cur = Number(st.stageCursor?.[st.etapa] || 0);
            for (let i = cur; i < msgs.length; i++) {
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-pre-batch' };
                }
                if (!msgs[i]) continue;
                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                const r = await sendMessage(st.contato, msgs[i]);
                if (!r?.ok) break;
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-mid-batch' };
                }
                st.stageCursor[st.etapa] = i + 1;
            }

            if ((st.stageCursor[st.etapa] || 0) >= msgs.length) {
                if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
                st.stageCursor[st.etapa] = 0;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.saque = 0;
                st.saquePediuPrint = false;
                const _prev = st.etapa;
                if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
                st.etapa = 'saque:wait';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                return { ok: true };
            }
            return { ok: true, partial: true };
        }

        if (st.etapa === 'saque:wait') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };
            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.saque || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }
            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;
            const looksLikeMediaUrl = (s) => {
                const n = String(s || '');
                return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
                    || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
            };
            let temImagem = false;
            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                if (looksLikeMediaUrl(msg) || /^\[m[ií]dia\]$/i.test(msg)) {
                    console.log(`[${st.contato}] Análise: imagem ("${truncate(msg, 140)}")`);
                    temImagem = true;
                    break;
                }
            }
            if (temImagem) {
                st.lastClassifiedIdx.saque = total;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.saquePediuPrint = false;
                const _prev = st.etapa;
                st.etapa = 'validacao:send';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
            } else {
                let relevante = false;
                if (apiKey) {
                    const allowed = ['relevante', 'irrelevante'];
                    const contexto = novasMsgs.map(s => safeStr(s)).join(' | ');
                    const structuredPrompt =
                        `${promptClassificaRelevancia(contexto, false)}\n\n` +
                        `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
                        `{"label": "relevante"} or {"label": "irrelevante"}`;
                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
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
                        } catch {
                            return { status: 0, picked: null };
                        }
                        const data = r.data;
                        let rawText = '';
                        if (Array.isArray(data?.output)) {
                            data.output.forEach(item => {
                                if (item.type === 'message' && Array.isArray(item.content) && item.content[0]?.text) {
                                    rawText = item.content[0].text;
                                }
                            });
                        }
                        if (!rawText) rawText = extractTextForLog(data);
                        rawText = String(rawText || '').trim();
                        let picked = null;
                        if (rawText) {
                            try {
                                const parsed = JSON.parse(rawText);
                                if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                            } catch {
                                const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                                if (m && m[1]) picked = m[1].toLowerCase().trim();
                            }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, allowed);
                        return { status: r.status, picked };
                    };
                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) resp = await callOnce(256);
                        relevante = (resp.status >= 200 && resp.status < 300 && resp.picked === 'relevante');
                        console.log(`[${st.contato}] Análise: ${resp.picked || (relevante ? 'relevante' : 'irrelevante')} ("${truncate(contexto, 140)}")`);
                    } catch { }
                }
                st.lastClassifiedIdx.saque = total;
                st.mensagensPendentes = [];
                if (relevante) {
                    const saquePath = path.join(__dirname, 'content', 'saque.json');
                    let saqueMsgPrint = null;
                    let raw = fs.readFileSync(saquePath, 'utf8');
                    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed?.msgprint) && parsed.msgprint.length > 0) {
                        saqueMsgPrint = parsed.msgprint;
                    }
                    if (!Array.isArray(saqueMsgPrint) || saqueMsgPrint.length === 0) {
                        return { ok: true, classe: 'aguardando_imagem' };
                    }
                    // helpers locais
                    const pickLocal = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                    const composeMsgPrint = () => pickLocal(saqueMsgPrint);
                    if (!st.saquePediuPrint) {
                        const m = chooseUnique(composeMsgPrint, st) || composeMsgPrint();
                        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                        let r = { ok: true };
                        if (m) r = await sendMessage(st.contato, m);
                        if (!r?.ok) return { ok: true, paused: r?.reason || 'send-skipped' };
                        st.saquePediuPrint = true;
                        return { ok: true, classe: 'relevante' };
                    }
                    return { ok: true, classe: 'aguardando_imagem' };
                }
                return { ok: true, classe: 'irrelevante' };
            }
        }

        if (st.etapa === 'validacao:send') {
            enterStageOptOutResetIfNeeded(st);
            const validacaoPath = path.join(__dirname, 'content', 'validacao.json');
            let validacaoData = null;
            const loadValidacao = () => {
                if (validacaoData) return validacaoData;
                let raw = fs.readFileSync(validacaoPath, 'utf8');
                raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                validacaoData = JSON.parse(raw);
                return validacaoData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length
                ? arr[Math.floor(Math.random() * arr.length)]
                : '';
            const composeMsg1 = () => {
                const c = loadValidacao();
                return [pick(c?.msg1?.msg1b1), pick(c?.msg1?.msg1b2)].filter(Boolean).join(', ') + (pick(c?.msg1?.msg1b3) ? `. ${pick(c?.msg1?.msg1b3)}` : '');
            };
            const composeMsg2 = () => {
                const c = loadValidacao();
                const part1 = [pick(c?.msg2?.msg2b1), pick(c?.msg2?.msg2b2)].filter(Boolean).join(', ');
                const part2 = [pick(c?.msg2?.msg2b3), pick(c?.msg2?.msg2b4)].filter(Boolean).join(', ');
                return [part1 && `${part1}.`, part2 && `${part2}?`].filter(Boolean).join(' ');
            };

            const m1 = chooseUnique(composeMsg1, st) || composeMsg1();
            const m2 = chooseUnique(composeMsg2, st) || composeMsg2();
            const msgs = [m1, m2];

            let cur = Number(st.stageCursor?.[st.etapa] || 0);
            for (let i = cur; i < msgs.length; i++) {
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-pre-batch' };
                }
                if (!msgs[i]) continue;
                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                const r = await sendMessage(st.contato, msgs[i]);
                if (!r?.ok) break;
                if (await preflightOptOut(st)) {
                    return { ok: true, interrupted: 'optout-mid-batch' };
                }
                st.stageCursor[st.etapa] = i + 1;
            }

            if ((st.stageCursor[st.etapa] || 0) >= msgs.length) {
                if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
                st.stageCursor[st.etapa] = 0;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.validacao = 0;
                st.validacaoAwaitFirstMsg = true;
                st.validacaoTimeoutUntil = 0;
                const _prev = st.etapa;
                if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
                st.etapa = 'validacao:wait';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                return { ok: true };
            }
            return { ok: true, partial: true };
        }

        if (st.etapa === 'validacao:wait') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };
            if (st.validacaoAwaitFirstMsg && st.validacaoTimeoutUntil === 0) {
                const FOUR = 4 * 60 * 1000;
                const SIX = 6 * 60 * 1000;
                const rnd = randomInt(FOUR, SIX + 1);
                st.validacaoTimeoutUntil = Date.now() + rnd;
                st.validacaoAwaitFirstMsg = false;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                if (st.validacaoTimer) { try { clearTimeout(st.validacaoTimer); } catch { } }
                st.validacaoTimer = setTimeout(async () => {
                    try {
                        await processarMensagensPendentes(contato);
                    } catch (e) {
                        console.warn(`[${st.contato}] validacaoTimer erro: ${e?.message || e}`);
                    }
                }, rnd + 100);
                const _prev = st.etapa;
                st.etapa = 'validacao:cooldown';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                return { ok: true, started: rnd };
            }
            st.mensagensPendentes = [];
            return { ok: true, noop: 'await-first-message' };
        }

        if (st.etapa === 'validacao:cooldown') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-cooldown' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-cooldown' };

            const now = Date.now();
            if (st.validacaoTimeoutUntil > 0 && now < st.validacaoTimeoutUntil) {
                if (st.mensagensPendentes.length > 0) {
                    st.mensagensPendentes = [];
                    st.mensagensDesdeSolicitacao = [];
                }
                return { ok: true, noop: 'cooldown' };
            }
            st.validacaoTimeoutUntil = 0;
            st.validacaoAwaitFirstMsg = false;
            if (st.validacaoTimer) { try { clearTimeout(st.validacaoTimer); } catch { } st.validacaoTimer = null; }
            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.validacao = 0;
            st.conversaoBatch = 0;
            st.conversaoAwaitMsg = false;
            if (!st.lastClassifiedIdx) st.lastClassifiedIdx = {};
            st.lastClassifiedIdx.conversao = 0;
            const _prev = st.etapa;
            st.etapa = 'conversao:send';
            console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        }

        if (st.etapa === 'conversao:send') {
            enterStageOptOutResetIfNeeded(st);
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-pre-batch' };

            let conversao = null;
            let raw = fs.readFileSync(path.join(__dirname, 'content', 'conversao.json'), 'utf8');
            raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
            conversao = JSON.parse(raw);
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

            if (st.conversaoBatch === 0) {
                const m1 = [pick(conversao?.msg1?.msg1b1), pick(conversao?.msg1?.msg1b2)].filter(Boolean).join(', ');
                const m3 = [pick(conversao?.msg3?.msg3b1), pick(conversao?.msg3?.msg3b2), pick(conversao?.msg3?.msg3b3)].filter(Boolean).join(', ');

                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                if (m1) {
                    const r1 = await sendMessage(st.contato, m1);
                    if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' };
                    if (!r1?.ok) return { ok: false, reason: 'send-aborted' };
                }

                // dentro de conversao:send (primeiro batch)
                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

                // ManyChat -> usa o mesmo mecanismo do /admin/test-image (fields + flow), sem precisar de imagem no conversao.json
                const FLOW_NS_IMAGEM = 'content20251005164000_207206';
                const r2 = await sendImage(st.contato, /* url opcional */ '', {
                    flowNs: FLOW_NS_IMAGEM,
                    // se quiser, já manda legenda para o flow ler via custom field
                    caption: 'Comprovante de transferência'
                });

                if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' };
                if (!r2?.ok) return { ok: false, reason: r2?.reason || 'image-send-failed' };


                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                if (m3) {
                    const r3 = await sendMessage(st.contato, m3);
                    if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
                    if (!r3?.ok) return { ok: false, reason: 'send-aborted' };
                }

                st.conversaoBatch = 1;
                st.conversaoAwaitMsg = true;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                return { ok: true, batch: 1 };
            }

            if (st.conversaoAwaitMsg) {
                const temMsg =
                    (Array.isArray(st.mensagensPendentes) && st.mensagensPendentes.length > 0) ||
                    (Array.isArray(st.mensagensDesdeSolicitacao) && st.mensagensDesdeSolicitacao.length > (st.lastClassifiedIdx?.conversao || 0));
                if (!temMsg) {
                    st.mensagensPendentes = [];
                    return { ok: true, noop: 'await-user-message' };
                }
                st.lastClassifiedIdx.conversao = st.mensagensDesdeSolicitacao.length;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];

                if (st.conversaoBatch === 1) {
                    const m4 = [pick(conversao?.msg4?.msg4b1), pick(conversao?.msg4?.msg4b2), pick(conversao?.msg4?.msg4b3), pick(conversao?.msg4?.msg4b4), pick(conversao?.msg4?.msg4b5), pick(conversao?.msg4?.msg4b6), pick(conversao?.msg4?.msg4b7)].filter(Boolean).join('. ');
                    const m5 = [pick(conversao?.msg5?.msg5b1), pick(conversao?.msg5?.msg5b2)].filter(Boolean).join(', ');
                    const m6 = [pick(conversao?.msg6?.msg6b1), pick(conversao?.msg6?.msg6b2), pick(conversao?.msg6?.msg6b3)].filter(Boolean).join(', ');

                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m4) { const r = await sendMessage(st.contato, m4); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m5) { const r = await sendMessage(st.contato, m5 ? `${m5}?` : m5); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m6) { const r = await sendMessage(st.contato, m6); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }

                    st.conversaoBatch = 2;
                    st.conversaoAwaitMsg = true;
                    return { ok: true, batch: 2 };
                }

                if (st.conversaoBatch === 2) {
                    const m7 = [pick(conversao?.msg7?.msg7b1), pick(conversao?.msg7?.msg7b2), pick(conversao?.msg7?.msg7b3), pick(conversao?.msg7?.msg7b4), pick(conversao?.msg7?.msg7b5)].filter(Boolean).join('. ');
                    const m8 = [pick(conversao?.msg8?.msg8b1), pick(conversao?.msg8?.msg8b2), pick(conversao?.msg8?.msg8b3), pick(conversao?.msg8?.msg8b4)].filter(Boolean).join(', ');
                    const m9 = [pick(conversao?.msg9?.msg9b1), pick(conversao?.msg9?.msg9b2), pick(conversao?.msg9?.msg9b3), pick(conversao?.msg9?.msg9b4), pick(conversao?.msg9?.msg9b5), pick(conversao?.msg9?.msg9b6), pick(conversao?.msg9?.msg9b7)].filter(Boolean).join('. ');

                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m7) { const r = await sendMessage(st.contato, m7); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m8) { const r = await sendMessage(st.contato, m8); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m9) { const r = await sendMessage(st.contato, m9); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }

                    st.conversaoBatch = 3;
                    st.conversaoAwaitMsg = false;
                    st.mensagensPendentes = [];
                    st.mensagensDesdeSolicitacao = [];
                    st.lastClassifiedIdx.conversao = 0;
                    const _prev = st.etapa;
                    if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
                    st.etapa = 'conversao:wait';
                    console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                    return { ok: true, batch: 3, done: true };
                }
            }

            if (st.conversaoBatch >= 3) {
                st.conversaoAwaitMsg = false;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                const _prev = st.etapa;
                st.etapa = 'conversao:wait';
                console.log(`[${st.contato}] ${(_prev)} -> ${st.etapa}`);
                return { ok: true, coerced: 'conversao:wait' };
            }

            return { ok: true };
        }

        if (st.etapa === 'conversao:wait') {
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
            st.mensagensPendentes = [];
            return { ok: true, noop: 'idle' };
        }
    } finally {
        st.enviandoMensagens = false;
    }
}

async function sendManychatWaFlow(contato, flowNs, dataOpt = {}) {
    await extraGlobalDelay();

    const st = ensureEstado(contato);
    if (await preflightOptOut(st)) {
        console.log(`[${contato}] flow=cancelado por opt-out em tempo real`);
        return { ok: false, reason: 'paused-by-optout' };
    }
    const paused = (st.permanentlyBlocked === true) || (st.optOutCount >= 3) || (st.optOutCount > 0 && !st.reoptinActive);
    if (paused) {
        return { ok: false, reason: 'paused-by-optout' };
    }

    const { mod, settings } = await getActiveTransport();
    const provider = mod?.name || 'unknown';
    if (provider !== 'manychat') {
        console.warn(`[${contato}] sendManychatWaFlow: provider=${provider} não suportado (esperado manychat).`);
        return { ok: false, reason: 'unsupported-provider' };
    }

    const token = (settings && settings.manychat_api_token) || process.env.MANYCHAT_API_TOKEN || '';
    if (!token) {
        console.warn(`[${contato}] sendManychatWaFlow: token Manychat ausente`);
        return { ok: false, reason: 'no-token' };
    }

    let subscriberId = await resolveManychatWaSubscriberId(contato, mod, settings);
    if (!subscriberId) {
        console.warn(`[${contato}] sendManychatWaFlow: subscriber_id não encontrado`);
        return { ok: false, reason: 'no-subscriber-id' };
    }

    const url = 'https://api.manychat.com/whatsapp/sending/sendFlow';
    const body = {
        subscriber_id: subscriberId,
        flow_ns: flowNs,
        data: dataOpt || {}
    };

    try {
        const r = await axios.post(url, body, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000,
            validateStatus: () => true
        });

        const ok = r.status >= 200 && r.status < 300 && (r.data?.status || 'success') === 'success';
        if (!ok) {
            console.warn(`[${contato}] sendManychatWaFlow: HTTP ${r.status} body=${JSON.stringify(r.data).slice(0, 400)}`);
            return { ok: false, status: r.status, body: r.data };
        }

        console.log(`[${contato}] sendManychatWaFlow OK flow_ns=${flowNs} subscriber_id=${subscriberId}`);
        return { ok: true };
    } catch (e) {
        console.warn(`[${contato}] sendManychatWaFlow erro: ${e?.message || e}`);
        return { ok: false, error: e?.message || String(e) };
    }
}

async function sendMessage(contato, texto, opts = {}) {
    await extraGlobalDelay();
    const msg = safeStr(texto);
    try {
        const st = ensureEstado(contato);
        if (await preflightOptOut(st)) {
            console.log(`[${contato}] envio=cancelado por opt-out em tempo real`);
            return { ok: false, reason: 'paused-by-optout' };
        }
        const forced = opts && opts.force === true;
        const paused = (st.permanentlyBlocked === true) || (st.optOutCount >= 3) || (st.optOutCount > 0 && !st.reoptinActive);
        if (paused && !forced) {
            console.log(`[${contato}] envio=skip reason=paused-by-optout msg="${safeStr(texto).slice(0, 140)}"`);
            return { ok: false, reason: 'paused-by-optout' };
        }

        const { mod, settings } = await getActiveTransport();
        const provider = mod?.name || 'unknown';

        if (provider === 'meta') {
            const phone = String(contato || '').replace(/\D/g, '');
            let finalText = String(msg ?? '')
                .replace(/\r\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            await mod.sendText({ to: phone, text: finalText });
            console.log(`${tsNow()} [${contato}] Mensagem enviada via Meta: ${finalText}`);
            return { ok: true, provider };
        }

        if (provider === 'manychat') {
            let subscriberId = null;
            try {
                const c = await getContatoByPhone(contato);
                if (c?.manychat_subscriber_id) subscriberId = String(c.manychat_subscriber_id);
                else if (c?.subscriber_id) subscriberId = String(c.subscriber_id);
            } catch (e) {
                console.warn(`[${contato}] DB lookup subscriber_id falhou: ${e.message}`);
            }
            if (!subscriberId) {
                subscriberId = await resolveManychatSubscriberId(contato, mod, settings);
            }
            if (!subscriberId) {
                console.log(`[${contato}] envio=fail provider=manychat reason=no-subscriber-id`);
                return { ok: false, reason: 'no-subscriber-id' };
            }
            let finalText = String(msg ?? '')
                .replace(/\r\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            await mod.sendText({ subscriberId, text: finalText }, settings);
            console.log(`${tsNow()} [${contato}] Mensagem enviada: ${finalText}`);
            return { ok: true, provider };
        }
        console.log(`[${contato}] envio=fail provider=${provider} reason=unsupported msg="${msg}"`);
        return { ok: false, reason: 'unsupported' };
    } catch (e) {
        console.log(`[${contato}] envio=fail provider=unknown reason="${e.message}" msg="${msg}"`);
        return { ok: false, error: e.message };
    }
}

async function updateManyChatCustomFieldByName({ token, subscriberId, fieldName, fieldValue }) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const tries = [
        { url: 'https://api.manychat.com/fb/subscriber/setCustomFieldByName', body: { subscriber_id: subscriberId, field_name: fieldName, field_value: fieldValue } },
    ];

    for (const t of tries) {
        try {
            const r = await axios.post(t.url, t.body, { headers, timeout: 15000, validateStatus: () => true });
            console.log(`[ManyChat][setField:${fieldName}] ${r.status} -> ${JSON.stringify(r.data)}`);
            if (r.status >= 200 && r.status < 300 && (r.data?.status === 'success' || r.data?.code === 200)) {
                return true;
            }
        } catch (e) {
            console.log(`[ManyChat][setField:${fieldName}] erro @ ${t.url}: ${e?.message || e}`);
        }
    }
    return false;
}

async function sendImage(contato, image, captionOrOpts = '', maybeOpts = {}) {
    // ===== 1) Normalização de argumentos =====
    // Usos aceitos:
    //   sendImage(contato, 'https://img...', 'Legenda')
    //   sendImage(contato, 'https://img...', { mechanism:'manychat_fields', caption:'...' })
    //   sendImage(contato, [{ url, caption }, { url, caption }], { delayBetweenMs:[12000,16000] })
    const isArray = Array.isArray(image);
    const items = isArray
        ? image.map(it => ({ url: safeStr(it?.url).trim(), caption: safeStr(it?.caption || '') }))
        : [{ url: safeStr(image).trim(), caption: (typeof captionOrOpts === 'string' ? captionOrOpts : safeStr(captionOrOpts?.caption || '')) }];

    const baseOpts = (typeof captionOrOpts === 'object' && !isArray) ? captionOrOpts : maybeOpts;
    const opts = {
        // mecanismo padrão: o mesmo do /admin/test-image (set custom fields)
        mechanism: (baseOpts.mechanism || 'manychat_fields'),
        // nomes dos campos no ManyChat (pode sobrescrever se quiser)
        fields: { image: (baseOpts.fields?.image || 'image'), caption: (baseOpts.fields?.caption || 'caption') },
        // para quem quiser ainda acionar flow direto:
        flowNs: baseOpts.flowNs || null,        // ex: 'content20251005164000_207206'
        flowVars: baseOpts.flowVars || {},      // vars extras para o flow
        // comportamento geral:
        force: baseOpts.force === true,
        alsoSendAsFile: baseOpts.alsoSendAsFile === true, // reservado p/ outros providers futuramente
        delayBetweenMs: Array.isArray(baseOpts.delayBetweenMs) ? baseOpts.delayBetweenMs : [BETWEEN_MIN_MS, BETWEEN_MAX_MS],
    };

    // ===== 2) Guardas e opt-out =====
    await extraGlobalDelay();
    const allowNoUrl = !!((typeof captionOrOpts === 'object' ? captionOrOpts : maybeOpts)?.flowNs);
    if (!items.length || (!items[0].url && !allowNoUrl)) {
        return { ok: false, reason: 'empty-image-url' };
    }
    try {
        const st = ensureEstado(contato);
        if (await preflightOptOut(st)) return { ok: false, reason: 'paused-by-optout' };

        const paused = (st.permanentlyBlocked === true) || (st.optOutCount >= 3) || (st.optOutCount > 0 && !st.reoptinActive);
        if (paused && !opts.force) return { ok: false, reason: 'paused-by-optout' };

        // ===== 3) Provider ativo =====
        const { mod, settings } = await getActiveTransport();
        const provider = mod?.name || 'unknown';

        if (provider !== 'manychat') {
            // hoje só damos suporte completo a ManyChat p/ imagem
            return { ok: false, reason: 'unsupported' };
        }

        // ===== 4) Credenciais/Subscriber =====
        const token = (settings && settings.manychat_api_token) || process.env.MANYCHAT_API_TOKEN || '';
        if (!token) return { ok: false, reason: 'missing-token' };

        const subscriberId = await resolveManychatWaSubscriberId(contato, mod, settings);
        if (!subscriberId) return { ok: false, reason: 'no-subscriber-id' };

        // ===== 5) Estratégias de envio no ManyChat =====
        const sendOneByFields = async ({ url, caption }) => {
            // (A) mesmo mecanismo do /admin/test-image: 1) set caption 2) set image
            if (typeof caption === 'string') {
                await updateManyChatCustomFieldByName({ token, subscriberId, fieldName: opts.fields.caption, fieldValue: caption || '' });
            }
            const okImg = await updateManyChatCustomFieldByName({ token, subscriberId, fieldName: opts.fields.image, fieldValue: url });
            if (!okImg) return { ok: false, reason: 'set-field-failed' };
            console.log(`[${contato}] ManyChat: ${opts.fields.image} atualizado -> fluxo disparado. url="${url}" caption_len=${(caption || '').length}`);
            return { ok: true, provider: 'manychat', mechanism: 'manychat_fields' };
        };

        const sendOneByFlow = async ({ url, caption }) => {
            // (B) alternativa: acionar diretamente um flow com variáveis
            if (!opts.flowNs) return { ok: false, reason: 'missing-flow-ns' };
            const payload = {
                subscriber_id: subscriberId,
                flow_ns: opts.flowNs,
                variables: {
                    contact_: contato,
                    image_url_: url,
                    caption_: caption || '',
                    ...opts.flowVars,
                }
            };
            const r = await axios.post('https://api.manychat.com/fb/sending/sendFlow', payload, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 60000,
                validateStatus: () => true
            });
            console.log(`[ManyChat][sendFlow] http=${r.status} body=${JSON.stringify(r.data)}`);
            if (r.status >= 200 && r.status < 300 && r.data?.status === 'success') {
                return { ok: true, provider: 'manychat', mechanism: 'flow', flowNs: opts.flowNs };
            }
            return { ok: false, reason: 'flow-send-failed', details: r.data };
        };

        const sender =
            (opts.mechanism === 'flow' || (!!opts.flowNs)) ? sendOneByFlow : sendOneByFields;

        // ===== 6) Suporte a múltiplas imagens (replicável em qualquer etapa) =====
        const results = [];
        for (let i = 0; i < items.length; i++) {
            const { url, caption } = items[i];
            const r = await sender({ url: url || '', caption });
            results.push(r);

            // checagem de opt-out entre envios
            if (await preflightOptOut(st)) {
                results.push({ ok: false, reason: 'paused-by-optout-mid-batch' });
                break;
            }

            // delay humano entre imagens do mesmo lote
            if (i < items.length - 1) {
                const [minMs, maxMs] = opts.delayBetweenMs;
                await delayRange(minMs, maxMs);
            }
        }

        // retorno compacto quando for 1 item, ou detalhado para lote
        if (!isArray) return results[0];
        const okAll = results.every(r => r?.ok);
        return { ok: okAll, results };

    } catch (e) {
        console.log(`[${contato}] Image send fail: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

async function triggerManyChatFlow(contato, flowNs, imageUrl, caption, settings) {
    const token = (settings && settings.manychat_api_token) || process.env.MANYCHAT_API_TOKEN || '';
    if (!token) throw new Error('ManyChat API token ausente');

    const subscriberId = await resolveManychatWaSubscriberId(contato);
    if (!subscriberId) throw new Error('No subscriber ID');

    const payload = {
        subscriber_id: subscriberId,
        flow_ns: 'content20251005164000_207206',  // ex: 'content20251004203041_009700'
        variables: {  // Parâmetros dinâmicos
            contact_: contato,  // Envie o número do celular
            image_url_: imageUrl,
            caption_: caption || ''
        }
    };

    // Log detalhado do payload enviado (EXATAMENTE o que vai para ManyChat)
    console.log(`[ManyChat][sendFlow] Sending payload: ${JSON.stringify(payload, null, 2)}`);

    const r = await axios.post('https://api.manychat.com/fb/sending/sendFlow', payload, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 60000,  // 60s
        validateStatus: () => true
    });

    // Log da resposta completa do ManyChat
    console.log(`[ManyChat][sendFlow] Response: Status=${r.status}, Body=${JSON.stringify(r.data, null, 2)}`);

    if (r.status >= 200 && r.status < 300 && r.data.status === 'success') {
        console.log(`[${contato}] Triggered flow ${flowNs} with image ${imageUrl}`);
        return { ok: true };
    }
    throw new Error(`Trigger flow falhou: ${JSON.stringify(r.data)}`);
}

const KNOWN_ETAPAS = new Set([
    'abertura:send',
    'abertura:wait',
    'interesse:send',
    'interesse:wait',
    'instrucoes:send',
    'instrucoes:wait',
    'acesso:send',
    'acesso:wait',
    'confirmacao:send',
    'confirmacao:wait',
    'saque:send',
    'saque:wait',
    'validacao:send',
    'validacao:wait',
    'validacao:cooldown',
    'conversao:send',
    'conversao:wait',
    'encerrado:wait'
]);

function _resetRuntime(st, opts = {}) {
    st.enviandoMensagens = false;
    st.mensagensPendentes = [];
    st.mensagensDesdeSolicitacao = [];
    st.sentHashes = st.sentHashes instanceof Set ? st.sentHashes : new Set();
    st.lastClassifiedIdx = {
        interesse: 0, acesso: 0, confirmacao: 0, saque: 0, validacao: 0, conversao: 0
    };
    st.saquePediuPrint = false;
    if (st.validacaoTimer) { try { clearTimeout(st.validacaoTimer); } catch { } }
    st.validacaoTimer = null;
    st.validacaoAwaitFirstMsg = false;
    st.validacaoTimeoutUntil = 0;
    st.conversaoBatch = 0;
    st.conversaoAwaitMsg = false;
    st.stageCursor = {};
    st.optoutLotsTried = 0;
    st.optoutBuffer = [];
    st.optoutBatchStage = null;
    if (opts.clearCredenciais) st.credenciais = undefined;
    if (opts.seedCredenciais && typeof opts.seedCredenciais === 'object') {
        st.credenciais = {
            email: String(opts.seedCredenciais.email || ''),
            password: String(opts.seedCredenciais.password || ''),
            login_url: String(opts.seedCredenciais.login_url || ''),
        };
    }
    if (opts.manychat_subscriber_id != null) {
        const v = opts.manychat_subscriber_id;
        st.manychat_subscriber_id = (typeof v === 'string' && v.trim()) ? v.trim() :
            (Number.isFinite(Number(v)) ? String(v) : undefined);
    }
    st.updatedAt = Date.now();
}

async function setEtapa(contato, etapa, opts = {}) {
    const target = _canonicalizeEtapa(String(etapa || '').trim());
    if (!KNOWN_ETAPAS.has(target)) {
        throw new Error(`etapa inválida: "${target}"`);
    }
    const st = ensureEstado(contato);
    _resetRuntime(st, opts);
    st.etapa = target;
    if (opts.autoCreateUser && !st.credenciais &&
        (target.startsWith('acesso:') ||
            target.startsWith('confirmacao:') ||
            target.startsWith('saque:') ||
            target.startsWith('validacao:') ||
            target.startsWith('conversao:'))) {
        try {
            await criarUsuarioDjango(contato);
        } catch (e) {
            console.warn(`[${st.contato}] setEtapa:autoCreateUser falhou: ${e?.message || e}`);
        }
    }
    return { ok: true, contato: st.contato, etapa: st.etapa };
}

module.exports = {
    init,
    handleManyChatWebhook,
    handleIncomingNormalizedMessage,
    processarMensagensPendentes,
    inicializarEstado,
    criarUsuarioDjango,
    delay,
    sendMessage,
    sendImage,
    setEtapa,
    _utils: { ensureEstado, normalizeContato },
};