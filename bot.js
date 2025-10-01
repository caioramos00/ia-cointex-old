'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const estadoContatos = require('./state.js');
const { getActiveTransport } = require('./lib/transport');
const { getContatoByPhone } = require('./db');
const { promptClassificaAceite } = require('./prompts');

let log = console;

function safeStr(v) { return (v === null || v === undefined) ? '' : String(v); }
function normalizeContato(raw) { return safeStr(raw).replace(/\D/g, ''); }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const FIRST_REPLY_DELAY_MS = 15000;
const BETWEEN_MIN_MS = 12000;
const BETWEEN_MAX_MS = 16000;
function delayRange(minMs, maxMs) { const d = Math.floor(minMs + Math.random() * (maxMs - minMs)); return delay(d); }

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
    return (
        (typeof data?.output_text === 'string' && data.output_text) ||
        (typeof data?.output?.[0]?.content?.[0]?.text === 'string' && data.output[0].content[0].text) ||
        (typeof data?.choices?.[0]?.message?.content === 'string' && data.choices[0].message.content) ||
        (typeof data?.result === 'string' && data.result) ||
        (typeof data === 'string' ? data : JSON.stringify(data))
    );
}

function ensureEstado(contato) {
    const key = safeStr(contato) || 'desconhecido';
    if (!estadoContatos[key]) {
        estadoContatos[key] = {
            contato: key,
            etapa: 'none',
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
            // Removido: heurClassesSinceSolicitacao (não usamos mais heurística)
            lastClassifiedIdx: { interesse: 0, acesso: 0, confirmacao: 0, saque: 0 }, // ponteiros por etapa
        };
    } else {
        const st = estadoContatos[key];
        st.updatedAt = Date.now();
        if (!Array.isArray(st.mensagensPendentes)) st.mensagensPendentes = [];
        if (!Array.isArray(st.mensagensDesdeSolicitacao)) st.mensagensDesdeSolicitacao = [];
        if (!(st.sentHashes instanceof Set)) st.sentHashes = new Set(Array.isArray(st.sentHashes) ? st.sentHashes : []);
        if (!st.lastClassifiedIdx) st.lastClassifiedIdx = { interesse: 0, acesso: 0, confirmacao: 0, saque: 0 };
        // garantir todas as chaves do ponteiro
        for (const k of ['interesse', 'acesso', 'confirmacao', 'saque']) {
            if (typeof st.lastClassifiedIdx[k] !== 'number' || st.lastClassifiedIdx[k] < 0) st.lastClassifiedIdx[k] = 0;
        }
    }
    return estadoContatos[key];
}

function inicializarEstado(contato, maybeTid, maybeClickType) {
    const st = ensureEstado(contato);
    if (typeof maybeTid === 'string') st.tid = maybeTid || st.tid || '';
    if (typeof maybeClickType === 'string') st.click_type = maybeClickType || st.click_type || 'Orgânico';
    return st;
}

function decidirOptLabel(texto) {
    const t = safeStr(texto).toLowerCase();
    const out = [
        /\bpar(a|e)\b/, /\bpare\b/, /\bchega\b/, /\bremover\b/, /\bremova\b/,
        /\bnao\s*quero\b/, /\bsem\s*mensagem\b/, /\bstop\b/, /\bcancel(ar)?\b/,
        /\bdesinscrever\b/, /\bunsubscribe\b/, /\bnao\s*me\s*chame\b/, /\bnao\s*mand(a|e)\b/
    ].some(r => r.test(t));
    return out ? 'OPTOUT' : 'NAO_OPTOUT';
}

async function criarUsuarioDjango(contato) {
    const st = ensureEstado(contato);
    if (st.createdUser === 'ok' || st.credenciais) return { ok: true, skipped: true };
    if (st.createdUser === 'pending') return { ok: true, skipped: 'pending' };
    st.createdUser = 'pending';
    const phone = st.contato.startsWith('+') ? st.contato : `+${st.contato}`;
    const payload = { tid: st.tid || '', click_type: st.click_type || 'Orgânico', phone };
    try {
        const resp = await axios.post('https://www.cointex.cash/api/create-user/', payload, { timeout: 15000, validateStatus: () => true });
        if (resp.status >= 200 && resp.status < 300) {
            const user = Array.isArray(resp.data?.users) ? resp.data.users[0] : null;
            if (user?.email && user?.password) st.credenciais = { email: user.email, password: user.password, login_url: user.login_url || '' };
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

const sentHashesGlobal = new Set();
function hashText(s) { let h = 0, i, chr; const str = String(s); if (str.length === 0) return '0'; for (i = 0; i < str.length; i++) { chr = str.charCodeAt(i); h = ((h << 5) - h) + chr; h |= 0; } return String(h); }
function chooseUnique(generator, st) { const maxTries = 200; for (let i = 0; i < maxTries; i++) { const text = generator(); const h = hashText(text); if (!sentHashesGlobal.has(h) && !st.sentHashes.has(h)) { sentHashesGlobal.add(h); st.sentHashes.add(h); return text; } } return null; }

async function handleIncomingNormalizedMessage(normalized) {
    if (!normalized) return;
    const { contato, texto, temMidia, ts } = normalized;
    const hasText = !!safeStr(texto);
    const hasMedia = !!temMidia;
    if (!hasText && !hasMedia) return;
    const estado = ensureEstado(contato);
    const msg = hasText ? safeStr(texto).trim() : '[mídia]';
    log.info(`[${estado.contato}] ${msg}`);
    estado.lastIncomingTs = ts;
}

function init(options = {}) {
    if (options.logger) {
        const { info, warn, error } = options.logger;
        if (typeof info === 'function' && typeof warn === 'function' && typeof error === 'function') log = options.logger;
    }
    return { ok: true };
}

async function handleManyChatWebhook(body) { return { ok: true }; }

async function processarMensagensPendentes(contato) {
    const st = ensureEstado(contato);
    if (st.enviandoMensagens) return { ok: true, skipped: 'busy' };
    st.enviandoMensagens = true;
    try {
        console.log(`[${st.contato}] etapa=${st.etapa} pendentes=${st.mensagensPendentes.length}`);

        if (st.etapa === 'none') {
            const aberturaPath = path.join(__dirname, 'content', 'abertura.json');
            let aberturaData = null;
            const loadAbertura = () => {
                if (aberturaData) return aberturaData;
                try {
                    const raw = fs.readFileSync(aberturaPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (!parsed?.msg1?.grupo1?.length || !parsed?.msg1?.grupo2?.length || !parsed?.msg1?.grupo3?.length) throw new Error('content/abertura.json incompleto: msg1.* ausente');
                    if (!parsed?.msg2?.grupo1?.length || !parsed?.msg2?.grupo2?.length || !parsed?.msg2?.grupo3?.length) throw new Error('content/abertura.json incompleto: msg2.* ausente');
                    aberturaData = parsed;
                } catch {
                    aberturaData = { msg1: { grupo1: ['salve'], grupo2: ['tô precisando de alguém pro trampo agora'], grupo3: ['tá disponível?'] }, msg2: { grupo1: ['nem liga pro nome desse whats,'], grupo2: ['número empresarial q usamos pros trampo'], grupo3: ['pode salvar como "Ryan"'] } };
                }
                return aberturaData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
            const composeAberturaMsg1 = () => { const c = loadAbertura(); const g1 = pick(c.msg1.grupo1); const g2 = pick(c.msg1.grupo2); const g3 = pick(c.msg1.grupo3); return [g1, g2, g3].filter(Boolean).join(', '); };
            const composeAberturaMsg2 = () => { const c = loadAbertura(); const g1 = pick(c.msg2.grupo1); const g2 = pick(c.msg2.grupo2); const g3 = pick(c.msg2.grupo3); const head = [g1, g2].filter(Boolean).join(' '); return [head, g3].filter(Boolean).join(', '); };

            await delay(FIRST_REPLY_DELAY_MS);

            let m1 = chooseUnique(composeAberturaMsg1, st) || composeAberturaMsg1();
            let m2 = chooseUnique(composeAberturaMsg2, st) || composeAberturaMsg2();

            if (m1) await sendMessage(st.contato, m1);
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m2) await sendMessage(st.contato, m2);

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            // reset ponteiro da próxima etapa para não carregar lixo antigo
            st.lastClassifiedIdx.interesse = 0;

            st.etapa = 'abertura:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'abertura:wait') {
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            const interessePath = path.join(__dirname, 'content', 'interesse.json');
            let interesseData = null;
            const loadInteresse = () => {
                if (interesseData) return interesseData;
                try {
                    const raw = fs.readFileSync(interessePath, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (!parsed?.msg?.g1?.length || !parsed?.msg?.g2?.length || !parsed?.msg?.g3?.length || !parsed?.msg?.g4?.length || !parsed?.msg?.g5?.length) throw new Error('content/interesse.json incompleto');
                    interesseData = parsed;
                } catch {
                    interesseData = { msg: { g1: ['tô na correria aqui'], g2: ['fazendo vários ao mesmo tempo'], g3: ['vou te mandando tudo o que você tem que fazer'], g4: ['e você só responde o que eu te perguntar'], g5: ['beleza?'] } };
                }
                return interesseData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
            const composeInteresseMsg = () => { const c = loadInteresse(); const g1 = pick(c.msg.g1); const g2 = pick(c.msg.g2); const g3 = pick(c.msg.g3); const g4 = pick(c.msg.g4); const g5 = pick(c.msg.g5); return `${[g1, g2].filter(Boolean).join(', ')}... ${g3}, ${g4}, ${g5}`.replace(/\s+,/g, ','); };

            const mi = chooseUnique(composeInteresseMsg, st) || composeInteresseMsg();
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (mi) await sendMessage(st.contato, mi);

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.interesse = 0; // novo ciclo de classificação para a etapa
            st.etapa = 'interesse:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'interesse:wait') {
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            // === NOVO: classificar apenas o "lote novo" desde o último índice classificado ===
            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.interesse || 0);
            if (startIdx >= total) {
                // nada novo para classificar
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
                st.etapa = 'instrucoes:send';
            } else {
                return { ok: true, classe };
            }

        }

        if (st.etapa === 'instrucoes:send') {
            const instrucoesPath = path.join(__dirname, 'content', 'instrucoes.json');
            let instrucoesData = null;
            const loadInstrucoes = () => {
                if (instrucoesData) return instrucoesData;
                try {
                    const raw = fs.readFileSync(instrucoesPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (
                        !parsed?.msg1?.grupo1?.length || !parsed?.msg1?.grupo2?.length || !parsed?.msg1?.grupo3?.length ||
                        !parsed?.pontos?.p1?.g1?.length || !parsed?.pontos?.p1?.g2?.length || !parsed?.pontos?.p1?.g3?.length ||
                        !parsed?.pontos?.p2?.g1?.length || !parsed?.pontos?.p2?.g2?.length || !parsed?.pontos?.p2?.g3?.length ||
                        !parsed?.pontos?.p3?.g1?.length || !parsed?.pontos?.p3?.g2?.length || !parsed?.pontos?.p3?.g3?.length ||
                        !parsed?.pontos?.p4?.g1?.length || !parsed?.pontos?.p4?.g2?.length || !parsed?.pontos?.p4?.g3?.length ||
                        !parsed?.msg3?.grupo1?.length || !parsed?.msg3?.grupo2?.length
                    ) throw new Error('content/instrucoes.json incompleto');
                    instrucoesData = parsed;
                } catch {
                    instrucoesData = {
                        msg1: { grupo1: ['salvou o contato'], grupo2: ['salva ai que se aparecer outro trampo mais tarde eu te chamo tambem'], grupo3: ['vou te mandar o passo a passo do que precisa pra fazer certinho'] },
                        pontos: {
                            p1: { g1: ['você precisa de uma conta com pix ativo pra receber'], g2: ['pode ser qualquer banco'], g3: ['só não dá certo se for o SICOOB'] },
                            p2: { g1: ['se tiver dados móveis'], g2: ['desliga o wi-fi'], g3: ['mas se não tiver deixa no wi-fi mesmo'] },
                            p3: { g1: ['vou passar o email e a senha de uma conta pra você acessar'], g2: ['lá vai ter um saldo disponível'], g3: ['é só você transferir pra sua conta, mais nada'] },
                            p4: { g1: ['você vai receber 2000'], g2: ['o restante você manda pra minha conta logo que cair'], g3: ['eu vou te passar a chave pix depois'] }
                        },
                        msg3: { grupo1: ['é tranquilinho'], grupo2: ['a gente vai fazendo parte por parte pra não ter erro blz'] }
                    };
                }
                return instrucoesData;
            };
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

            const composeMsg1 = () => {
                const c = loadInstrucoes();
                const g1 = pick(c.msg1.grupo1);
                const g2 = pick(c.msg1.grupo2);
                const g3 = pick(c.msg1.grupo3);
                return `${g1}? ${g2}… ${g3}:`;
            };
            const composeMsg2 = () => {
                const c = loadInstrucoes();
                const p1 = `• ${pick(c.pontos.p1.g1)}, ${pick(c.pontos.p1.g2)}, ${pick(c.pontos.p1.g3)}`;
                const p2 = `• ${pick(c.pontos.p2.g1)}, ${pick(c.pontos.p2.g2)}, ${pick(c.pontos.p2.g3)}`;
                const p3 = `• ${pick(c.pontos.p3.g1)}, ${pick(c.pontos.p3.g2)}, ${pick(c.pontos.p3.g3)}`;
                const p4 = `• ${pick(c.pontos.p4.g1)}, ${pick(c.pontos.p4.g2)}, ${pick(c.pontos.p4.g3)}`;
                return [p1, p2, p3, p4].join('\n\n');
            };
            const composeMsg3 = () => {
                const c = loadInstrucoes();
                const g1 = pick(c.msg3.grupo1);
                const g2 = pick(c.msg3.grupo2);
                return `${g1}… ${g2}?`;
            };

            const m1 = composeMsg1();
            const m2 = composeMsg2();
            const m3 = composeMsg3();

            if (m1) await sendMessage(st.contato, m1);
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

            if (m2) {
                const extra = Math.floor(10000 + Math.random() * 10000);
                await delay(extra);
                await sendMessage(st.contato, m2);
            }
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

            if (m3) await sendMessage(st.contato, m3);

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.acesso = 0;
            st.lastClassifiedIdx.confirmacao = 0;
            st.lastClassifiedIdx.saque = 0;

            st.etapa = 'instrucoes:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }
    } finally {
        st.enviandoMensagens = false;
    }
}

async function sendMessage(contato, texto) {
    const msg = safeStr(texto);
    try {
        const { mod, settings } = await getActiveTransport();
        const provider = mod?.name || 'unknown';

        if (provider === 'manychat') {
            let subscriberId = null;
            try {
                const c = await getContatoByPhone(contato);
                subscriberId = c?.manychat_subscriber_id || c?.subscriber_id || null;
            } catch { }
            if (!subscriberId) {
                const st = ensureEstado(contato);
                if (st.manychat_subscriber_id) subscriberId = st.manychat_subscriber_id;
            }
            if (!subscriberId) {
                console.log(`[${contato}] envio=fail provider=manychat reason=no-subscriber-id msg="${msg}"`);
                return { ok: false, reason: 'no-subscriber-id' };
            }
            await mod.sendText({ subscriberId, text: msg }, settings);
            console.log(`[${contato}] envio=ok provider=manychat msg="${msg}"`);
            return { ok: true, provider };
        }

        console.log(`[${contato}] envio=fail provider=${provider} reason=unsupported msg="${msg}"`);
        return { ok: false, reason: 'unsupported' };
    } catch (e) {
        console.log(`[${contato}] envio=fail provider=unknown reason="${e.message}" msg="${msg}"`);
        return { ok: false, error: e.message };
    }
}

async function retomarEnvio(contato) { console.log(`[${contato}] retomarEnvio()`); return { ok: true }; }

module.exports = {
    init,
    handleManyChatWebhook,
    handleIncomingNormalizedMessage,
    processarMensagensPendentes,
    inicializarEstado,
    decidirOptLabel,
    criarUsuarioDjango,
    delay,
    sendMessage,
    retomarEnvio,
    _utils: { ensureEstado, normalizeContato },
};
