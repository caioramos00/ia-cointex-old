const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, chooseUnique, BETWEEN_MIN_MS, BETWEEN_MAX_MS, safeStr, truncate } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage } = require('../senders.js');
const axios = require('axios');
const { promptClassificaConfirmacao } = require('../prompts');

// Helpers exportadas cedo por bot.js (quebra de ciclo já tratada naquele arquivo)
const { extractTextForLog, pickLabelFromResponseData } = require('../bot.js');

async function handleConfirmacaoSend(st) {
    enterStageOptOutResetIfNeeded(st);
    const confirmacaoPath = path.join(__dirname, '../content', 'confirmacao.json');
    let confirmacaoData = null;
    const loadConfirmacao = () => {
        if (confirmacaoData) return confirmacaoData;
        let raw = fs.readFileSync(confirmacaoPath, 'utf8');
        raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
        confirmacaoData = JSON.parse(raw);
        return confirmacaoData;
    };
    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
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
    st.lastClassifiedIdx = st.lastClassifiedIdx || {};
    st.lastClassifiedIdx.confirmacao = 0;

    const _prev = st.etapa;
    if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
    st.etapa = 'confirmacao:wait';
    console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
    return { ok: true };
}

async function handleConfirmacaoWait(st) {
    if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
    if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
    if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

    const totalPend = st.mensagensPendentes.length;

    // ==== FIX #1: guard contra "pular a primeira" quando o buffer foi recriado ====
    st.lastClassifiedIdx = st.lastClassifiedIdx || {};
    let startIdx = Math.max(0, Number(st.lastClassifiedIdx.confirmacao || 0));
    if (startIdx >= totalPend) {
        // Se o array foi reconstruído/encurtado, começamos do zero para não perder a 1ª mensagem
        startIdx = 0;
    }
    // ==============================================================================

    const novasMsgs = st.mensagensPendentes.slice(startIdx);
    if (novasMsgs.length === 0) {
        st.mensagensPendentes = [];
        st.lastClassifiedIdx.confirmacao = 0; // manter coerência: array vazio => índice zerado
        return { ok: true, noop: 'no-new-messages' };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const looksLikeMediaUrl = (s) => {
        const n = String(s || '');
        return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
            || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
    };

    let confirmado = false;

    // Heurística atual para mídia (se quiser 100% LLM, remover este bloco)
    for (const m of novasMsgs) {
        const msg = safeStr(m?.texto || '').trim();
        if (m?.temMidia || m?.hasMedia || looksLikeMediaUrl(msg) || /^\[m[ií]dia\]$/i.test(msg)) {
            console.log(`[${st.contato}] Análise: confirmado ("${truncate(msg, 140)}")`);
            confirmado = true;
            break;
        }
    }

    if (!confirmado && apiKey) {
        const allowed = ['confirmado', 'nao_confirmado', 'duvida', 'neutro'];
        const contexto = novasMsgs.map(m => safeStr(m?.texto || '')).join(' | ');
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

            // Tenta extrair texto (compatível com os formatos comuns do endpoint /responses)
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

    // ==== FIX #2: ao esvaziar o buffer, o índice precisa ser ZERADO ====
    st.mensagensPendentes = [];
    st.lastClassifiedIdx.confirmacao = 0;
    // ===================================================================

    if (confirmado) {
        st.mensagensDesdeSolicitacao = [];
        st.lastClassifiedIdx.saque = 0;
        const _prev = st.etapa;
        st.etapa = 'saque:send';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        // garantir índice zerado ao sair confirmado
        st.lastClassifiedIdx.confirmacao = 0;

        const bot = require('../bot.js');
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));
        return { ok: true, transitioned: true };
    } else {
        return { ok: true, classe: 'standby' };
    }
}

module.exports = { handleConfirmacaoSend, handleConfirmacaoWait };
