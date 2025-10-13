const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, chooseUnique, BETWEEN_MIN_MS, BETWEEN_MAX_MS, safeStr, truncate } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage } = require('../senders.js');
const { processarMensagensPendentes } = require('../bot.js'); // Import para chamada recursiva
const axios = require('axios');
const { promptClassificaAceite } = require('../prompts');
const { extractTextForLog, pickLabelFromResponseData } = require('../bot.js'); // Assumindo que essas funções estão em bot.js; ajuste se necessário

async function handleInteresseSend(st) {
    enterStageOptOutResetIfNeeded(st);
    const interessePath = path.join(__dirname, '../content', 'interesse.json');
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

async function handleInteresseWait(st) {
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
        st.mensagensPendentes = [];  // Limpa pendentes para evitar acúmulo
        st.mensagensDesdeSolicitacao = [];  // Limpa para consistência
        return await processarMensagensPendentes(st.contato);  // Chama recursivamente para processar a nova etapa imediatamente
    } else {
        return { ok: true, classe };
    }
}

module.exports = { handleInteresseSend, handleInteresseWait };