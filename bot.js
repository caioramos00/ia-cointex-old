'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');
const axios = require('axios');

const { ensureEstado } = require('./stateManager.js');
const { loadOptOutMsgs, loadOptInMsgs, isOptOut, isOptIn, preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('./optout.js');
const { setManychatSubscriberId, salvarContato } = require('./db');
const { sendMessage, sendImage } = require('./senders.js');
const { criarUsuarioDjango } = require('./services.js');
const { getActiveTransport } = require('./lib/transport/index.js');
const { chooseUnique, safeStr, normalizeContato, delay, delayRange, tsNow, randomInt, truncate, BETWEEN_MIN_MS, BETWEEN_MAX_MS } = require('./utils.js');
const { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia, promptClassificaReoptin } = require('./prompts');
const { handleAberturaSend, handleAberturaWait } = require('./stages/abertura');
const { handleInteresseSend, handleInteresseWait } = require('./stages/interesse');
const { handleInstrucoesSend, handleInstrucoesWait } = require('./stages/instrucoes');
const { handleAcessoSend, handleAcessoWait } = require('./stages/acesso');

let log = console;
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });

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

function extractTextForLog(data) {
    try {
        if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
        if (Array.isArray(data?.output)) {
            for (const blk of data.output) {
                if (blk?.type === 'message' && Array.isArray(blk.content)) {
                    const out = blk.content.find(c => c?.type === 'output_text' && typeof c?.text === 'string' && c.text.trim());
                    if (out) return out.text;
                    const any = blk.content.find(c => typeof c?.text === 'string' && c.text.trim());
                    if (any) return any.text;
                }
            }
        }
        const cc = data?.choices?.[0]?.message?.content;
        if (typeof cc === 'string' && cc.trim()) return cc;
        if (typeof data?.result === 'string' && data.result.trim()) return data.result;
        return '';
    } catch {
        return '';
    }
}

function inicializarEstado(contato, maybeTid, maybeClickType) {
    const st = ensureEstado(contato);
    if (typeof maybeTid === 'string') st.tid = maybeTid || st.tid || '';
    if (typeof maybeClickType === 'string') st.click_type = maybeClickType || st.click_type || 'Orgânico';
    return st;
}

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

    const TID_RX = /(\d+[\u2060-\u206F]*[a-f0-9]+)/gi;
    if (!st.tid && hasText) {
        let detectedTid = '';
        const match = TID_RX.exec(texto);
        if (match) {
            detectedTid = match[1].replace(/[\u2060-\u206F]/g, '');
            log.info(`[${st.contato}] TID detectado na mensagem inicial: ${detectedTid}`);
        }

        st.tid = detectedTid || '';
        st.click_type = detectedTid ? 'Landing Page' : 'Orgânico';

        try {
            await salvarContato(st.contato, null, msg, st.tid, st.click_type);
        } catch (e) {
            log.warn(`[${st.contato}] Erro ao salvar TID inicial: ${e.message}`);
        }
    }

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
                for (const m of st.mensagensPendentes) {
                    const t = m?.texto || '';
                    if (!t) continue;
                    const hard = isOptIn(t);
                    console.log(`[${st.contato}] [REOPTIN][HARD] check="${truncate(t, 140)}" -> ${hard ? 'MATCH' : 'nope'}`);
                    if (hard) { matched = true; matchedText = t; }
                    if (matched) break;
                }
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
                            st.reoptinBuffer = [];
                            if (matched) break;
                            if (st.reoptinLotsTried >= 3) break;
                        }
                    }
                }
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
            return await handleAberturaSend(st);
        }
        if (st.etapa === 'abertura:wait') {
            return await handleAberturaWait(st);
        }
        if (st.etapa === 'interesse:send') {
            return await handleInteresseSend(st);
        }
        if (st.etapa === 'interesse:wait') {
            return await handleInteresseWait(st);
        }
        if (st.etapa === 'instrucoes:send') {
            return await handleInstrucoesSend(st);
        }
        if (st.etapa === 'instrucoes:wait') {
            return await handleInstrucoesWait(st);
        }
        if (st.etapa === 'acesso:send') {
            return await handleAcessoSend(st);
        }
        if (st.etapa === 'acesso:wait') {
            return await handleAcessoWait(st);
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

            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-pre-single' };

            let r = { ok: true };
            if (m) r = await sendMessage(st.contato, m);

            if (!r?.ok) {
                return { ok: true, paused: r?.reason || 'send-skipped' };
            }

            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-single' };

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
            const novasMsgs = st.mensagensPendentes.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;
            const looksLikeMediaUrl = (s) => {
                const n = String(s || '');
                return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
                    || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
            };
            let confirmado = false;
            for (const m of novasMsgs) {
                const msg = safeStr(m.texto).trim();
                if (m.temMidia || m.hasMedia || looksLikeMediaUrl(msg) || /^\[m[ií]dia\]$/i.test(msg)) {
                    console.log(`[${st.contato}] Análise: confirmado ("${truncate(msg, 140)}")`);
                    confirmado = true;
                    break;
                }
            }
            if (!confirmado && apiKey) {
                const allowed = ['confirmado', 'nao_confirmado', 'duvida', 'neutro'];
                const contexto = novasMsgs.map(m => safeStr(m.texto)).join(' | ');
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
            st.lastClassifiedIdx.confirmacao = st.mensagensPendentes.length;
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
            if (!Array.isArray(st.mensagensPendentes) || st.mensagensPendentes.length === 0) {
                return { ok: true, noop: 'waiting-user' };
            }
            const totalPend = st.mensagensPendentes.length;
            const startIdx = Math.min(totalPend, Math.max(0, Number(st.lastClassifiedIdx?.saque || 0)));
            const novasMsgs = st.mensagensPendentes.slice(startIdx);
            if (novasMsgs.length === 0) {
                st.mensagensPendentes = [];
                st.lastClassifiedIdx.saque = 0;
                return { ok: true, noop: 'no-new-messages' };
            }
            const apiKey = process.env.OPENAI_API_KEY;
            const looksLikeMediaUrl = (s) => {
                const n = String(s || '');
                return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
                    || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
            };
            let temImagem = false;
            for (const m of novasMsgs) {
                const msg = safeStr(m?.texto || '').trim();
                if (m?.temMidia || m?.hasMedia || looksLikeMediaUrl(msg) || /^\[m[ií]dia\]$/i.test(msg)) {
                    console.log(`[${st.contato}] Análise: imagem ("${truncate(msg, 140)}")`);
                    temImagem = true;
                    break;
                }
            }
            if (temImagem) {
                st.lastClassifiedIdx.saque = 0;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.saquePediuPrint = false;
                const _prev = st.etapa;
                st.etapa = 'validacao:send';
                console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
                st.enviandoMensagens = false;
                return await processarMensagensPendentes(contato);
            } else {
                let relevante = false;
                if (apiKey) {
                    const contexto = novasMsgs.map(m => safeStr(m?.texto || '')).join(' | ');
                    const structuredPrompt =
                        `${promptClassificaRelevancia(contexto, false)}\n\n` +
                        `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
                        `{"label": "relevante"} or {"label": "irrelevante"}`;
                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
                                'https://api.openai.com/v1/responses',
                                { model: 'gpt-5', input: structuredPrompt, max_output_tokens: maxTok, reasoning: { effort: 'low' } },
                                { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true }
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
                            try { const parsed = JSON.parse(rawText); if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim(); }
                            catch { const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i); if (m && m[1]) picked = m[1].toLowerCase().trim(); }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, ['relevante', 'irrelevante']);
                        return { status: r.status, picked };
                    };
                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) resp = await callOnce(256);
                        relevante = (resp.status >= 200 && resp.status < 300 && resp.picked === 'relevante');
                        console.log(`[${st.contato}] Análise: ${resp.picked || (relevante ? 'relevante' : 'irrelevante')} ("${truncate(contexto, 140)}")`);
                    } catch { }
                }
                st.lastClassifiedIdx.saque = 0;
                st.mensagensPendentes = [];
                if (relevante) {
                    const saquePath = path.join(__dirname, 'content', 'saque.json');
                    let raw = fs.readFileSync(saquePath, 'utf8');
                    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                    const parsed = JSON.parse(raw);
                    const lista = Array.isArray(parsed?.msgprint) ? parsed.msgprint : [];
                    if (!lista.length) return { ok: true, classe: 'aguardando_imagem' };
                    if (!st.saquePediuPrint) {
                        const pickLocal = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                        const m = pickLocal(lista);
                        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                        const r = m ? await sendMessage(st.contato, m) : { ok: true };
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

                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

                // Branching para envio de imagem baseado no provider
                const { mod, settings } = await getActiveTransport();
                const provider = mod?.name || 'unknown';
                let r2;
                if (provider === 'manychat') {
                    const FLOW_NS_IMAGEM = 'content20251005164000_207206';
                    r2 = await sendImage(st.contato, '', {
                        flowNs: FLOW_NS_IMAGEM,
                        caption: 'Comprovante de transferência'
                    });
                } else if (provider === 'meta') {
                    const imgUrl = 'https://images2.imgbox.com/b6/bf/GC6mll55_o.jpg';
                    r2 = await sendImage(st.contato, imgUrl, {
                        caption: 'Comprovante de transferência'
                    });
                } else {
                    console.warn(`[${st.contato}] Provider não suportado para imagem: ${provider}`);
                    r2 = { ok: false, reason: 'unsupported-provider' };
                }

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

module.exports = {
    init,
    handleManyChatWebhook,
    handleIncomingNormalizedMessage,
    processarMensagensPendentes,
    inicializarEstado,
    delay,
    chooseUnique,
    enterStageOptOutResetIfNeeded,
    extractTextForLog,
    pickLabelFromResponseData,
    _utils: { normalizeContato },
};
