const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, chooseUnique, BETWEEN_MIN_MS, BETWEEN_MAX_MS, safeStr, truncate } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage, sendImage } = require('../senders.js');
const axios = require('axios');
const { promptClassificaPronto } = require('../prompts');

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

    const composeAndSend = async (key) => {
        const msgObj = c[key];
        if (!msgObj) return { ok: true, skipped: true };

        if (msgObj.type === 'image') {
            const imgUrl = pick(msgObj.images);
            const caption = pick(msgObj.caption || []);
            if (!imgUrl) return { ok: false, reason: 'no-image-url' };

            const r = await sendImage(st.contato, imgUrl, { caption });
            return r;
        } else {
            const blocos = [];
            let j = 1;
            while (true) {
                const bkey = `bloco${j}`;
                if (!msgObj[bkey]) break;
                blocos.push(pick(msgObj[bkey]));
                j++;
            }

            let m = '';
            const filteredBlocos = blocos.filter(Boolean);
            if (filteredBlocos.length > 0) {
                switch (key) {
                    case 'msg1':
                        m = `${filteredBlocos[0]}, ${filteredBlocos[1]} ${filteredBlocos[2]}`;
                        break;
                    case 'msg8':
                        m = '\n' + filteredBlocos.join('\n') + '\n';
                        break;
                    case 'msg11':
                        m = filteredBlocos.join(', ');
                        break;
                    default:
                        m = filteredBlocos.join(', ');
                        break;
                }
            }
            if (!m) return { ok: true, skipped: true };
            return await sendMessage(st.contato, m);
        }
    };

    const c = loadConfirmacao();

    for (let i = 1; i <= 11; i++) {
        const key = `msg${i}`;

        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

        if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-pre-multi' };

        const r = await composeAndSend(key);

        if (!r?.ok) {
            return { ok: true, paused: r?.reason || 'send-skipped' };
        }

        if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-multi' };
    }

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

    st.lastClassifiedIdx = st.lastClassifiedIdx || {};
    let startIdx = Math.max(0, Number(st.lastClassifiedIdx.confirmacao || 0));
    if (startIdx >= totalPend) {
        startIdx = 0;
    }

    const novasMsgs = st.mensagensPendentes.slice(startIdx);
    if (novasMsgs.length === 0) {
        st.mensagensPendentes = [];
        st.lastClassifiedIdx.confirmacao = 0;
        return { ok: true, noop: 'no-new-messages' };
    }

    const apiKey = process.env.OPENAI_API_KEY;

    let pronto = false;

    // Heurística para "PRONTO"
    for (const m of novasMsgs) {
        const msg = safeStr(m?.texto || '').trim();
        if (/pronto/i.test(msg)) {
            console.log(`[${st.contato}] Análise: pronto ("${truncate(msg, 140)}")`);
            pronto = true;
            break;
        }
    }

    if (!pronto && apiKey) {
        const allowed = ['pronto', 'nao_pronto', 'duvida', 'neutro'];
        const contexto = novasMsgs.map(m => safeStr(m?.texto || '')).join(' | ');
        const structuredPrompt =
            `${promptClassificaPronto(contexto)}\n\n` +
            `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
            `{"label": "pronto"} or {"label": "nao_pronto"} or {"label": "duvida"} or {"label": "neutro"}`;
        const callOnce = async (maxTok) => {
            let r;
            try {
                r = await axios.post(
                    'https://api.x.ai/v1/chat/completions',
                    {
                        model: 'grok-4-1-fast-reasoning',
                        messages: structuredPrompt,
                        max_tokens: maxTok,
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
            pronto = (resp.status >= 200 && resp.status < 300 && resp.picked === 'pronto');
            console.log(`[${st.contato}] Análise: ${resp.picked || 'neutro'} ("${truncate(contexto, 140)}")`);
        } catch { }
    }

    st.mensagensPendentes = [];
    st.lastClassifiedIdx.confirmacao = 0;

    if (pronto) {
        st.mensagensDesdeSolicitacao = [];
        st.lastClassifiedIdx.saque = 0;
        const _prev = st.etapa;
        st.etapa = 'saque:send';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        st.lastClassifiedIdx.confirmacao = 0;

        const bot = require('../bot.js');
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));
        return { ok: true, transitioned: true };
    } else {
        return { ok: true, classe: 'standby' };
    }
}

module.exports = { handleConfirmacaoSend, handleConfirmacaoWait };