const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, BETWEEN_MIN_MS, BETWEEN_MAX_MS } = require('../utils.js');
const { preflightOptOut, finalizeOptOutBatchAtEnd, enterStageOptOutResetIfNeeded } = require('../optout.js');
const { sendMessage } = require('../senders.js');

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
    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
    const composeMsg1 = () => {
        const c = loadInstrucoes();
        const g1 = pick(c?.msg1?.grupo1);
        const g2 = pick(c?.msg1?.grupo2);
        const g3 = pick(c?.msg1?.grupo3);
        return [g1 && `${g1}?`, g2 && `${g2}…`, g3 && `${g3}:`].filter(Boolean).join(' ');
    };
    const composeMsg2 = () => {
        const c = loadInstrucoes();
        const p1 = [pick(c?.pontos?.p1?.g1), pick(c?.pontos?.p1?.g2), pick(c?.pontos?.p1?.g3)].filter(Boolean).join(', ');
        const p2 = [pick(c?.pontos?.p2?.g1), pick(c?.pontos?.p2?.g2), pick(c?.pontos?.p2?.g3)].filter(Boolean).join(', ');
        const p3 = [pick(c?.pontos?.p3?.g1), pick(c?.pontos?.p3?.g2), pick(c?.pontos?.p3?.g3)].filter(Boolean).join(', ');
        const p4 = [pick(c?.pontos?.p4?.g1), pick(c?.pontos?.p4?.g2), pick(c?.pontos?.p4?.g3)].filter(Boolean).join(', ');
        let out = [`• ${p1}`, '', `• ${p2}`, '', `• ${p3}`, '', `• ${p4}`].join('\n');
        out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        return out;
    };
    const composeMsg3 = () => {
        const c = loadInstrucoes();
        const g1 = pick(c?.msg3?.grupo1);
        const g2 = pick(c?.msg3?.grupo2);
        return [g1 && `${g1}…`, g2 && `${g2}?`].filter(Boolean).join(' ');
    };
    const m1 = composeMsg1();
    const m2 = composeMsg2();
    const m3 = composeMsg3();
    const msgs = [m1, m2, m3];
    let cur = Number(st.stageCursor?.[st.etapa] || 0);
    for (let i = cur; i < msgs.length; i++) {
        if (await preflightOptOut(st)) {
            return { ok: true, interrupted: 'optout-pre-batch' };
        }
        if (!msgs[i]) continue;
        if (i === 0) await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        if (i === 1) { await delayRange(20000, 30000); await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS); }
        if (i === 2) await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
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
        st.lastClassifiedIdx.confirmacao = 0;
        st.lastClassifiedIdx.saque = 0;
        const _prev = st.etapa;
        if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
        st.etapa = 'instrucoes:wait';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        return { ok: true };
    }
    return { ok: true, partial: true };
}

module.exports = { handleInstrucoesSend };