const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, chooseUnique, BETWEEN_MIN_MS, BETWEEN_MAX_MS, randomInt } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage } = require('../senders.js');

async function handleValidacaoSend(st) {
    enterStageOptOutResetIfNeeded(st);
    const validacaoPath = path.join(__dirname, '../content', 'validacao.json');
    let validacaoData = null;
    const loadValidacao = () => {
        if (validacaoData) return validacaoData;
        let raw = fs.readFileSync(validacaoPath, 'utf8');
        raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
        validacaoData = JSON.parse(raw);
        return validacaoData;
    };
    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
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

async function handleValidacaoWait(st) {
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
            const bot = require('../bot.js');
            try {
                await bot.processarMensagensPendentes(st.contato);
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

async function handleValidacaoCooldown(st) {
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
    const bot = require('../bot.js');
    process.nextTick(() => bot.processarMensagensPendentes(st.contato));
    return { ok: true, transitioned: true };
}

module.exports = { handleValidacaoSend, handleValidacaoWait, handleValidacaoCooldown };