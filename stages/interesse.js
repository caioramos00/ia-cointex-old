const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, chooseUnique, BETWEEN_MIN_MS, BETWEEN_MAX_MS } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage } = require('../senders.js');

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

module.exports = { handleInteresseSend };