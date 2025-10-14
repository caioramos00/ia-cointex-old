const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, BETWEEN_MIN_MS, BETWEEN_MAX_MS, safeStr, truncate } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage } = require('../senders.js');
const axios = require('axios');
const { promptClassificaAcesso } = require('../prompts');
const { criarUsuarioDjango } = require('../services.js');

async function handleAcessoSend(st) {
    enterStageOptOutResetIfNeeded(st);
    const acessoPath = path.join(__dirname, '../content', 'acesso.json');
    let acessoData = null;
    const loadAcesso = () => {
        if (acessoData) return acessoData;
        let raw = fs.readFileSync(acessoPath, 'utf8');
        raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
        acessoData = JSON.parse(raw);
        return acessoData;
    };
    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
    if (!st.credenciais?.email || !st.credenciais?.password || !st.credenciais?.login_url) {
        let attempts = 0;
        while (attempts < 2 && (!st.credenciais?.email || !st.credenciais?.password || !st.credenciais?.login_url)) {
            try {
                await criarUsuarioDjango(st.contato);
            } catch (e) {
                console.warn(`[${st.contato}] criarUsuarioDjango falhou (tentativa ${attempts + 1}): ${e?.message || e}`);
                if (attempts === 1) {
                    st.etapa = 'acesso:wait';
                    return { ok: false, reason: 'no-credentials-after-retries' };
                }
                await delay(2000);
            }
            attempts++;
        }
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

async function handleAcessoWait(st) {
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
    const bot = require('../bot.js'); // Require dentro da função para evitar ciclo
    const { extractTextForLog, pickLabelFromResponseData } = bot;
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
        st.mensagensPendentes = [];  // Limpa pendentes para evitar acúmulo
        st.mensagensDesdeSolicitacao = [];  // Limpa para consistência
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));
        return { ok: true, transitioned: true };
    } else {
        const ultima = classes[classes.length - 1] || 'neutro';
        return { ok: true, classe: ultima };
    }
}

module.exports = { handleAcessoSend, handleAcessoWait };