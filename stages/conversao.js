const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, BETWEEN_MIN_MS, BETWEEN_MAX_MS } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage, sendImage } = require('../senders.js');
const { getActiveTransport } = require('../lib/transport/index.js');

async function handleConversaoSend(st) {
    enterStageOptOutResetIfNeeded(st);
    if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-pre-batch' };

    let conversao = null;
    let raw = fs.readFileSync(path.join(__dirname, '../content', 'conversao.json'), 'utf8');
    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
    conversao = JSON.parse(raw);
    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

    if (st.conversaoBatch === 0) {
        const m1 = [pick(conversao?.msg1?.msg1b1), pick(conversao?.msg1?.msg1b2)].filter(Boolean).join(', ');
        const m3 = [pick(conversao?.msg3?.msg3b1), pick(conversao?.msg3?.msg3b2), pick(conversao?.msg3?.msg3b3)].filter(Boolean).join(', ');

        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        if (m1) {
            const r1 = await sendMessage(st.contato, m1);
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' };
            if (!r1?.ok) return { ok: false, reason: 'send-aborted' };
        }

        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

        const { mod, settings } = await getActiveTransport();
        const provider = mod?.name || 'unknown';
        let r2;
        if (provider === 'manychat') {
            const FLOW_NS_IMAGEM = 'content20251005164000_207206';
            r2 = await sendImage(st.contato, '', {
                flowNs: FLOW_NS_IMAGEM,
                caption: 'Comprovante de transferência'
            });
        } else if (provider === 'meta') {
            const imgUrl = 'https://images2.imgbox.com/b6/bf/GC6mll55_o.jpg';
            r2 = await sendImage(st.contato, imgUrl, {
                caption: 'Comprovante de transferência'
            });
        } else {
            console.warn(`[${st.contato}] Provider não suportado para imagem: ${provider}`);
            r2 = { ok: false, reason: 'unsupported-provider' };
        }

        if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' };
        if (!r2?.ok) return { ok: false, reason: r2?.reason || 'image-send-failed' };

        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        if (m3) {
            const r3 = await sendMessage(st.contato, m3);
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
            if (!r3?.ok) return { ok: false, reason: 'send-aborted' };
        }

        st.conversaoBatch = 1;
        st.conversaoAwaitMsg = true;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        return { ok: true, batch: 1 };
    }

    if (st.conversaoAwaitMsg) {
        const temMsg =
            (Array.isArray(st.mensagensPendentes) && st.mensagensPendentes.length > 0) ||
            (Array.isArray(st.mensagensDesdeSolicitacao) && st.mensagensDesdeSolicitacao.length > (st.lastClassifiedIdx?.conversao || 0));
        if (!temMsg) {
            st.mensagensPendentes = [];
            return { ok: true, noop: 'await-user-message' };
        }
        st.lastClassifiedIdx.conversao = st.mensagensDesdeSolicitacao.length;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];

        if (st.conversaoBatch === 1) {
            const m4 = [pick(conversao?.msg4?.msg4b1), pick(conversao?.msg4?.msg4b2), pick(conversao?.msg4?.msg4b3), pick(conversao?.msg4?.msg4b4), pick(conversao?.msg4?.msg4b5), pick(conversao?.msg4?.msg4b6), pick(conversao?.msg4?.msg4b7)].filter(Boolean).join('. ');
            const m5 = [pick(conversao?.msg5?.msg5b1), pick(conversao?.msg5?.msg5b2)].filter(Boolean).join(', ');
            const m6 = [pick(conversao?.msg6?.msg6b1), pick(conversao?.msg6?.msg6b2), pick(conversao?.msg6?.msg6b3)].filter(Boolean).join(', ');

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m4) { const r = await sendMessage(st.contato, m4); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m5) { const r = await sendMessage(st.contato, m5 ? `${m5}?` : m5); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m6) { const r = await sendMessage(st.contato, m6); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }

            st.conversaoBatch = 2;
            st.conversaoAwaitMsg = true;
            return { ok: true, batch: 2 };
        }

        if (st.conversaoBatch === 2) {
            const m7 = [pick(conversao?.msg7?.msg7b1), pick(conversao?.msg7?.msg7b2), pick(conversao?.msg7?.msg7b3), pick(conversao?.msg7?.msg7b4), pick(conversao?.msg7?.msg7b5)].filter(Boolean).join('. ');
            const m8 = [pick(conversao?.msg8?.msg8b1), pick(conversao?.msg8?.msg8b2), pick(conversao?.msg8?.msg8b3), pick(conversao?.msg8?.msg8b4)].filter(Boolean).join(', ');
            const m9 = [pick(conversao?.msg9?.msg9b1), pick(conversao?.msg9?.msg9b2), pick(conversao?.msg9?.msg9b3), pick(conversao?.msg9?.msg9b4), pick(conversao?.msg9?.msg9b5), pick(conversao?.msg9?.msg9b6), pick(conversao?.msg9?.msg9b7)].filter(Boolean).join('. ');

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m7) { const r = await sendMessage(st.contato, m7); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m8) { const r = await sendMessage(st.contato, m8); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m9) { const r = await sendMessage(st.contato, m9); if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' }; if (!r?.ok) return { ok: false, reason: 'send-aborted' }; }

            st.conversaoBatch = 3;
            st.conversaoAwaitMsg = false;
            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.conversao = 0;
            const _prev = st.etapa;
            if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
            st.etapa = 'conversao:wait';
            console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);

            const delayMinutos = Math.floor(12 + Math.random() * 4) * 60 * 1000;
            setTimeout(async () => {
                const m10 = [pick(conversao?.msg10?.msg10b1), pick(conversao?.msg10?.msg10b2)].filter(Boolean).join(', ') + '…\n\n' + [pick(conversao?.msg10?.msg10b3), pick(conversao?.msg10?.msg10b4)].filter(Boolean).join(', ');
                const m11 = [pick(conversao?.msg11?.msg11b1), pick(conversao?.msg11?.msg11b2)].filter(Boolean).join(', ') + '\n\n' + [pick(conversao?.msg11?.msg11b3), pick(conversao?.msg11?.msg11b4), pick(conversao?.msg11?.msg11b5)].filter(Boolean).join(', ');
                const m12 = [pick(conversao?.msg12?.msg12b1), pick(conversao?.msg12?.msg12b2), pick(conversao?.msg12?.msg12b3), pick(conversao?.msg12?.msg12b4)].filter(Boolean).join(', ');
                const m13 = [pick(conversao?.msg13?.msg13b1), pick(conversao?.msg13?.msg13b2), pick(conversao?.msg13?.msg13b3)].filter(Boolean).join(', ') + '\n\n' + [pick(conversao?.msg13?.msg13b4)].filter(Boolean).join('') + '?';

                const novasMsgs = [m10, m11, m12, m13];

                for (const msg of novasMsgs) {
                    if (await preflightOptOut(st)) break;
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    await sendMessage(st.contato, msg);
                }

                if (await preflightOptOut(st)) return;

                const delayUltimoBlocoMs = Math.floor(15 + Math.random() * 6) * 60 * 1000;
                setTimeout(async () => {
                    const m14 = [pick(conversao?.msg14?.msg14b1), pick(conversao?.msg14?.msg14b2)].filter(Boolean).join(', ');
                    const m15 = [pick(conversao?.msg15?.msg15b1), pick(conversao?.msg15?.msg15b2), pick(conversao?.msg15?.msg15b3)].filter(Boolean).join(', ');
                    const m16 = [pick(conversao?.msg16?.msg16b1), pick(conversao?.msg16?.msg16b2), pick(conversao?.msg16?.msg16b3)].filter(Boolean).join(', ') + '?';
                    const m17 = [pick(conversao?.msg17?.msg17b1), pick(conversao?.msg17?.msg17b2), pick(conversao?.msg17?.msg17b3)].filter(Boolean).join(', ') + '?';

                    const ultimasMsgs = [m14, m15, m16, m17];

                    for (const msg of ultimasMsgs) {
                        if (await preflightOptOut(st)) break;
                        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                        await sendMessage(st.contato, msg);
                    }
                }, delayUltimoBlocoMs);
            }, delayMinutos);

            return { ok: true, batch: 3, done: true };
        }
    }

    if (st.conversaoBatch >= 3) {
        st.conversaoAwaitMsg = false;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        const _prev = st.etapa;
        st.etapa = 'conversao:wait';
        console.log(`[${st.contato}] ${(_prev)} -> ${st.etapa}`);
        return { ok: true, coerced: 'conversao:wait' };
    }

    return { ok: true };
}

async function handleConversaoWait(st) {
    if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
    if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
    st.mensagensPendentes = [];
    return { ok: true, noop: 'idle' };
}

module.exports = { handleConversaoSend, handleConversaoWait };
