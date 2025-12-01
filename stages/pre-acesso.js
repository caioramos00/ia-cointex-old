const path = require('path');
const fs = require('fs');
const { publish } = require('../stream/events-bus');
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

async function handlePreAcessoSend(st) {
    enterStageOptOutResetIfNeeded(st);

    const preAcessoPath = path.join(__dirname, '../content', 'pre-acesso.json');
    let preAcessoData = null;

    const loadPreAcesso = () => {
        if (preAcessoData) return preAcessoData;
        let raw = fs.readFileSync(preAcessoPath, 'utf8');
        raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
        preAcessoData = JSON.parse(raw);
        return preAcessoData;
    };

    const pick = (arr) =>
        Array.isArray(arr) && arr.length
            ? arr[Math.floor(Math.random() * arr.length)]
            : '';

    // msg1: g1 / g2
    const composePreAcessoMsg1 = () => {
        const c = loadPreAcesso();
        const g1 = pick(c?.msg1?.g1);
        const g2 = pick(c?.msg1?.g2);
        return [g1, g2].filter(Boolean).join(' ');
    };

    // msg2: g1 / g2 / g3
    const composePreAcessoMsg2 = () => {
        const c = loadPreAcesso();
        const g1 = pick(c?.msg2?.g1);
        const g2 = pick(c?.msg2?.g2);
        const g3 = pick(c?.msg2?.g3);
        return [g1, g2, g3].filter(Boolean).join(' ');
    };

    // msg3: g1 / g2
    const composePreAcessoMsg3 = () => {
        const c = loadPreAcesso();
        const g1 = pick(c?.msg3?.g1);
        const g2 = pick(c?.msg3?.g2);
        return [g1, g2].filter(Boolean).join(' ');
    };

    const m1 = chooseUnique(composePreAcessoMsg1, st) || composePreAcessoMsg1();
    const m2 = chooseUnique(composePreAcessoMsg2, st) || composePreAcessoMsg2();
    const m3 = chooseUnique(composePreAcessoMsg3, st) || composePreAcessoMsg3();

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

        // intervalo antes de cada mensagem
        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

        const r = await sendMessage(st.contato, msgs[i]);
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
        st.lastClassifiedIdx.preAcesso = 0;

        const _prev = st.etapa;
        if (await finalizeOptOutBatchAtEnd(st)) {
            return { ok: true, interrupted: 'optout-batch-end' };
        }

        st.etapa = 'pre-acesso:wait';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        return { ok: true };
    }

    return { ok: true, partial: true };
}

async function handlePreAcessoWait(st) {
    if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
    if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
    if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

    const total = st.mensagensDesdeSolicitacao.length;
    const startIdx = Math.max(0, st.lastClassifiedIdx?.preAcesso || 0);
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
            const structuredPrompt =
                `${prompt}\n\n` +
                'Output only this valid JSON format with double quotes around keys and values, nothing else: ' +
                '{"label": "aceite"} or {"label": "recusa"} or {"label": "duvida"}';

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

        console.log(
            `[${st.contato}] Análise: ${msgClass} ("${truncate(msg, 140)}")`
        );
        classes.push(msgClass);
    }

    st.lastClassifiedIdx.preAcesso = total;

    let classe = 'duvida';
    const nonDuvida = classes.filter((c) => c !== 'duvida');
    classe = nonDuvida.length > 0 ? nonDuvida[nonDuvida.length - 1] : 'duvida';

    st.classificacaoAceite = classe;
    st.mensagensPendentes = [];

    if (classe === 'aceite') {
        st.mensagensDesdeSolicitacao = [];
        st.lastClassifiedIdx.preAcesso = 0;
        const _prev = st.etapa;
        st.etapa = 'acesso:send'; // próxima etapa após o pre-acesso

        // Dispara evento "lead" (apenas uma vez por contato)
        if (!st.leadEventSent) {
            try {
                publish({
                    type: 'lead',
                    wa_id: st.contato,
                    tid: st.tid || '',
                    click_type: st.click_type || '',
                    etapa: st.etapa,
                    ts: Date.now(),
                });
                st.leadEventSent = true;
            } catch (e) {
                console.warn(
                    `[${st.contato}] Falha ao publicar evento Lead: ${e?.message || e}`
                );
            }
        }

        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));
        return { ok: true, transitioned: true };
    } else {
        return { ok: true, classe };
    }

}

module.exports = { handlePreAcessoSend, handlePreAcessoWait };
