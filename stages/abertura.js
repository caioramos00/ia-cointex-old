const path = require('path');
const fs = require('fs');
const { delay, delayRange, tsNow, FIRST_REPLY_DELAY_MS, BETWEEN_MIN_MS, BETWEEN_MAX_MS } = require('../utils.js');
const { preflightOptOut, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage } = require('../senders.js');
const { chooseUnique, enterStageOptOutResetIfNeeded } = require('../bot.js');

async function handleAberturaSend(st) {
    enterStageOptOutResetIfNeeded(st);
    const aberturaPath = path.join(__dirname, '../content', 'abertura.json');
    let aberturaData = null;
    const loadAbertura = () => {
        if (aberturaData) return aberturaData;
        let raw = fs.readFileSync(aberturaPath, 'utf8');
        raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
        aberturaData = JSON.parse(raw);
        return aberturaData;
    };
    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
    const composeAberturaMsg1 = () => {
        const c = loadAbertura();
        const g1 = pick(c?.msg1?.grupo1);
        const g2 = pick(c?.msg1?.grupo2);
        const g3 = pick(c?.msg1?.grupo3);
        return [g1, g2, g3].filter(Boolean).join(', ');
    };
    const composeAberturaMsg2 = () => {
        const c = loadAbertura();
        const g1 = pick(c?.msg2?.grupo1);
        const g2 = pick(c?.msg2?.grupo2);
        const g3 = pick(c?.msg2?.grupo3);
        const head = [g1, g2].filter(Boolean).join(' ');
        return [head, g3].filter(Boolean).join(', ');
    };
    const m1 = chooseUnique(composeAberturaMsg1, st) || composeAberturaMsg1();
    const m2 = chooseUnique(composeAberturaMsg2, st) || composeAberturaMsg2();
    const msgs = [m1, m2];
    let cur = Number(st.stageCursor?.[st.etapa] || 0);
    for (let i = cur; i < msgs.length; i++) {
        if (await preflightOptOut(st)) {
            return { ok: true, interrupted: 'optout-pre-batch' };
        }
        if (!msgs[i]) {
            st.stageCursor[st.etapa] = i + 1;
            continue;
        }
        if (i === 0) {
            await delay(FIRST_REPLY_DELAY_MS);
        } else {
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        }
        const r = await sendMessage(st.contato, msgs[i]);
        if (!r?.ok) {
            return { ok: true, paused: r?.reason || 'send-skipped', idx: i };
        }
        st.stageCursor[st.etapa] = i + 1;
        if (await preflightOptOut(st)) {
            return { ok: true, interrupted: 'optout-mid-batch' };
        }
    }
    if ((st.stageCursor[st.etapa] || 0) >= msgs.length) {
        if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
        st.stageCursor[st.etapa] = 0;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        st.lastClassifiedIdx.interesse = 0;
        const _prev = st.etapa;
        if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
        st.etapa = 'abertura:wait';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        return { ok: true };
    }
    return { ok: true, partial: true };
}

module.exports = { handleAberturaSend };
