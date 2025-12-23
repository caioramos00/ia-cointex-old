const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, BETWEEN_MIN_MS, BETWEEN_MAX_MS, safeStr, truncate } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage } = require('../senders.js');
const axios = require('axios');
const { promptClassificaAceite } = require('../prompts');

async function handleInstrucoesSend(st) {
    enterStageOptOutResetIfNeeded(st);

    const instrucoesPath = path.join(__dirname, '../content', 'instrucoes.json');
    let instrucoesData = null;

    const loadInstrucoes = () => {
        if (instrucoesData) return instrucoesData;
        let raw = fs.readFileSync(instrucoesPath, 'utf8');
        raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
        instrucoesData = JSON.parse(raw);
        return instrucoesData;
    };

    const pick = (arr) =>
        Array.isArray(arr) && arr.length
            ? arr[Math.floor(Math.random() * arr.length)]
            : '';

    // MSG 1: agora usa msg1.grupo1, msg1.grupo2 e msg2.grupo1
    const composeMsg1 = () => {
        const c = loadInstrucoes();
        const g1 = pick(c?.msg1?.grupo1);
        const g2 = pick(c?.msg1?.grupo2);
        const g3 = pick(c?.msg2?.grupo1); // frase que puxa pros pontos
        return [
            g1 && `${g1}`,
            g2 && `${g2}…`,
            g3 && `${g3}:`
        ].filter(Boolean).join(' ');
    };

    // MSG 2: pontos p1–p4, agora considerando g1..g4
    // AGORA retorna um array de mensagens, um bullet por mensagem
    const composeMsg2 = () => {
        const c = loadInstrucoes();

        const p1 = [
            pick(c?.pontos?.p1?.g1),
            pick(c?.pontos?.p1?.g2),
            pick(c?.pontos?.p1?.g3),
            pick(c?.pontos?.p1?.g4)
        ].filter(Boolean).join(', ');

        const p2 = [
            pick(c?.pontos?.p2?.g1),
            pick(c?.pontos?.p2?.g2),
            pick(c?.pontos?.p2?.g3),
            pick(c?.pontos?.p2?.g4)
        ].filter(Boolean).join(', ');

        const p3 = [
            pick(c?.pontos?.p3?.g1),
            pick(c?.pontos?.p3?.g2),
            pick(c?.pontos?.p3?.g3),
            pick(c?.pontos?.p3?.g4)
        ].filter(Boolean).join(', ');

        const p4 = [
            pick(c?.pontos?.p4?.g1),
            pick(c?.pontos?.p4?.g2),
            pick(c?.pontos?.p4?.g3),
            pick(c?.pontos?.p4?.g4)
        ].filter(Boolean).join(', ');

        const bullets = [];

        if (p1) bullets.push(`• ${p1}`);
        if (p2) bullets.push(`• ${p2}`);
        if (p3) bullets.push(`• ${p3}`);
        if (p4) bullets.push(`• ${p4}`);

        return bullets;
    };

    // MSG 3: continua igual, usando msg3.grupo1 / msg3.grupo2
    const composeMsg3 = () => {
        const c = loadInstrucoes();
        const g1 = pick(c?.msg3?.grupo1);
        const g2 = pick(c?.msg3?.grupo2);
        return [
            g1 && `${g1}…`,
            g2 && `${g2}?`
        ].filter(Boolean).join(' ');
    };

    const m1 = composeMsg1();
    const bullets = composeMsg2(); // array de strings, um bullet por mensagem
    const m3 = composeMsg3();

    // ordem: introdução, cada bullet, fechamento
    const msgs = [m1, ...bullets, m3];

    let cur = Number(st.stageCursor?.[st.etapa] || 0);

    for (let i = cur; i < msgs.length; i++) {
        if (await preflightOptOut(st)) {
            return { ok: true, interrupted: 'optout-pre-batch' };
        }

        if (!msgs[i]) continue;

        // delays entre mensagens
        if (i === 0) {
            // antes da primeira mensagem (intro)
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        } else if (i === 1) {
            // antes do primeiro bullet (mantém o gap maior que você já tinha)
            await delayRange(20000, 30000);
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        } else {
            // demais mensagens (bullets seguintes + fechamento)
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        }

        const r = await sendMessage(st.contato, msgs[i]);
        if (!r?.ok) break;

        if (await preflightOptOut(st)) {
            return { ok: true, interrupted: 'optout-mid-batch' };
        }

        if (!st.stageCursor) st.stageCursor = {};
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
        if (await finalizeOptOutBatchAtEnd(st)) {
            return { ok: true, interrupted: 'optout-batch-end' };
        }

        st.etapa = 'instrucoes:wait';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        return { ok: true };
    }

    return { ok: true, partial: true };
}

async function handleInstrucoesWait(st) {
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
    const bot = require('../bot.js'); // Require dentro da função para evitar ciclo
    const { extractTextForLog, pickLabelFromResponseData } = bot;

    for (const raw of novasMsgs) {
        const msg = safeStr(raw).trim();
        const prompt = promptClassificaAceite(msg);
        let msgClass = 'duvida';

        if (apiKey) {
            const allowed = ['aceite', 'recusa', 'duvida'];
            const structuredPrompt =
                `${prompt}\n\n` +
                'Output only this valid JSON format with double quotes around keys and values, nothing else: ' +
                '{"label": "aceite"} or {"label": "recusa"} or {"label": "duvida"}';

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
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
                                'Content-Type': 'application/json'
                            },
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

        console.log(`[${st.contato}] Análise: ${msgClass} ("${truncate(msg, 140)}")`);
        classes.push(msgClass);
    }

    st.lastClassifiedIdx.acesso = total;

    let classe = 'duvida';
    const nonDuvida = classes.filter((c) => c !== 'duvida');
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
        st.etapa = 'pre-acesso:send';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);

        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));

        return { ok: true, transitioned: true };
    } else {
        st.mensagensPendentes = [];
        return { ok: true, classe };
    }
}

module.exports = { handleInstrucoesSend, handleInstrucoesWait };
