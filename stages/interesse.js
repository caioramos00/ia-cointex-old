const path = require('path');
const fs = require('fs');
const {
    delayRange,
    tsNow,
    chooseUnique,
    BETWEEN_MIN_MS,
    BETWEEN_MAX_MS,
    safeStr,
    truncate
} = require('../utils.js');
const {
    preflightOptOut,
    enterStageOptOutResetIfNeeded,
    finalizeOptOutBatchAtEnd
} = require('../optout.js');
const { sendMessage } = require('../senders.js');
const axios = require('axios');
const { promptClassificaAceite } = require('../prompts');

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

    const pick = (arr) =>
        Array.isArray(arr) && arr.length
            ? arr[Math.floor(Math.random() * arr.length)]
            : '';

    // msg1: g1 / g2 / g3
    const composeInteresseMsg1 = () => {
        const c = loadInteresse();
        const g1 = pick(c?.msg1?.g1);
        const g2 = pick(c?.msg1?.g2);
        const g3 = pick(c?.msg1?.g3);
        return [g1, g2, g3].filter(Boolean).join(' ');
    };

    // msg2: g1 (pode ter só esse mesmo)
    const composeInteresseMsg2 = () => {
        const c = loadInteresse();
        const g1 = pick(c?.msg2?.g1);
        return [g1].filter(Boolean).join(' ');
    };

    // msg3: g1 / g2
    const composeInteresseMsg3 = () => {
        const c = loadInteresse();
        const g1 = pick(c?.msg3?.g1);
        const g2 = pick(c?.msg3?.g2);
        return [g1, g2].filter(Boolean).join(' ');
    };

    const m1 = chooseUnique(composeInteresseMsg1, st) || composeInteresseMsg1();
    const m2 = chooseUnique(composeInteresseMsg2, st) || composeInteresseMsg2();
    const m3 = chooseUnique(composeInteresseMsg3, st) || composeInteresseMsg3();

    const msgs = [m1, m2, m3];

    let cur = Number(st.stageCursor?.[st.etapa] || 0);

    for (let i = cur; i < msgs.length; i++) {
        if (await preflightOptOut(st)) {
            return { ok: true, interrupted: 'optout-pre-batch' };
        }

        if (!msgs[i]) {
            st.stageCursor[st.etapa] = i + 1;
            continue;
        }

        // Sempre espera um intervalo antes de cada mensagem nessa etapa
        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

        let r = await sendMessage(st.contato, msgs[i]);
        if (!r?.ok) {
            st.mensagensPendentes = [];
            return { ok: true, paused: r?.reason || 'send-skipped', idx: i };
        }

        st.stageCursor[st.etapa] = i + 1;

        if (await preflightOptOut(st)) {
            return { ok: true, interrupted: 'optout-mid-batch' };
        }
    }

    if ((st.stageCursor[st.etapa] || 0) >= msgs.length) {
        if (await preflightOptOut(st)) {
            return { ok: true, interrupted: 'optout-post-batch' };
        }

        // fim do batch
        st.stageCursor[st.etapa] = 0;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        st.lastClassifiedIdx.interesse = 0;

        const _prev = st.etapa;
        if (await finalizeOptOutBatchAtEnd(st)) {
            return { ok: true, interrupted: 'optout-batch-end' };
        }

        st.etapa = 'interesse:wait';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        return { ok: true };
    }

    return { ok: true, partial: true };
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
    const bot = require('../bot.js');
    const { extractTextForLog, pickLabelFromResponseData } = bot;

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
                    console.log(`[${tsNow()}][${st.contato}] Request to Grok API:`, JSON.stringify({
                        url: 'https://api.x.ai/v1/chat/completions',
                        model: 'grok-4-1-fast-reasoning',
                        messages: structuredPrompt,
                        max_tokens: maxTok
                    }, null, 2));

                    r = await axios.post(
                        'https://api.x.ai/v1/chat/completions',
                        {
                            model: 'grok-4-1-fast-reasoning',
                            messages: [{ role: 'user', content: structuredPrompt }],
                            max_tokens: maxTok,
                        },
                        {
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
                                'Content-Type': 'application/json'
                            },
                            timeout: 15000,
                            validateStatus: () => true
                        }
                    );

                    console.log(`[${tsNow()}][${st.contato}] Response from Grok API: Status ${r.status}`, JSON.stringify(r.data, null, 2), '\nHeaders:', JSON.stringify(r.headers, null, 2));
                } catch (err) {
                    console.error(`[${tsNow()}][${st.contato}] Error in Grok API call:`, err.message, '\nStack:', err.stack);
                    return { status: 0, picked: null };
                }

                const data = r.data;
                let rawText = '';
                if (Array.isArray(data?.output)) {
                    data.output.forEach((item) => {
                        if (
                            item.type === 'message' &&
                            Array.isArray(item.content) &&
                            item.content[0]?.text
                        ) {
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
                        if (parsed && typeof parsed.label === 'string') {
                            picked = parsed.label.toLowerCase().trim();
                        }
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

        console.log(
            `[${st.contato}] Análise: ${msgClass} ("${truncate(msg, 140)}")`
        );
        classes.push(msgClass);
    }

    st.lastClassifiedIdx.interesse = total;

    let classe = 'duvida';
    const nonDuvida = classes.filter((c) => c !== 'duvida');
    classe = nonDuvida.length > 0 ? nonDuvida[nonDuvida.length - 1] : 'duvida';

    st.classificacaoAceite = classe;
    st.mensagensPendentes = [];

    if (classe === 'aceite') {
        st.mensagensDesdeSolicitacao = [];
        st.lastClassifiedIdx.interesse = 0;
        const _prev = st.etapa;
        st.etapa = 'instrucoes:send';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));
        return { ok: true, transitioned: true };
    } else {
        return { ok: true, classe };
    }
}

module.exports = { handleInteresseSend, handleInteresseWait };
