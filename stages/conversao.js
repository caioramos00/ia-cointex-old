const path = require('path');
const fs = require('fs');
const { delayRange, tsNow, BETWEEN_MIN_MS, BETWEEN_MAX_MS } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage, sendImage } = require('../senders.js');
const { getActiveTransport } = require('../lib/transport/index.js');

async function handleConversaoSend(st) {
    enterStageOptOutResetIfNeeded(st);
    if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-pre-batch' };

    let raw = fs.readFileSync(path.join(__dirname, '../content', 'conversao.json'), 'utf8');
    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
    const conversao = JSON.parse(raw);

    const pick = (arr) =>
        Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

    // -----------------------
    // BATCH 0 (abre conversa)
    // -----------------------
    if (st.conversaoBatch === 0) {
        const m1 = [
            pick(conversao?.msg1?.msg1b1),
            pick(conversao?.msg1?.msg1b2),
        ].filter(Boolean).join(', ');

        // m3 dividido em duas mensagens:
        // 1) só msg3b1
        // 2) msg3b2 + msg3b3
        const m3_1 = pick(conversao?.msg3?.msg3b1);
        const m3_2 = [
            pick(conversao?.msg3?.msg3b2),
            pick(conversao?.msg3?.msg3b3),
        ].filter(Boolean).join(', ');

        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        if (m1) {
            const r1 = await sendMessage(st.contato, m1);
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' };
            if (!r1?.ok) return { ok: false, reason: 'send-aborted' };
        }

        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

        const { mod } = await getActiveTransport();
        const provider = mod?.name || 'unknown';
        let r2;

        if (provider === 'manychat') {
            const FLOW_NS_IMAGEM = 'content20251005164000_207206';
            r2 = await sendImage(st.contato, '', {
                flowNs: FLOW_NS_IMAGEM,
                caption: 'Comprovante de transferência',
            });
        } else if (provider === 'meta') {
            const imgUrl = 'https://images2.imgbox.com/b7/6a/tgmALzh8_o.jpg';
            r2 = await sendImage(st.contato, imgUrl, {
                caption: 'Comprovante de transferência',
            });
        } else {
            console.warn(`[${st.contato}] Provider não suportado para imagem: ${provider}`);
            r2 = { ok: false, reason: 'unsupported-provider' };
        }

        if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' };
        if (!r2?.ok) return { ok: false, reason: r2?.reason || 'image-send-failed' };

        // m3_1
        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        if (m3_1) {
            const r3a = await sendMessage(st.contato, m3_1);
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-mid-batch' };
            if (!r3a?.ok) return { ok: false, reason: 'send-aborted' };
        }

        // m3_2
        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
        if (m3_2) {
            const r3b = await sendMessage(st.contato, m3_2);
            if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-batch' };
            if (!r3b?.ok) return { ok: false, reason: 'send-aborted' };
        }

        st.conversaoBatch = 1;
        // não queremos mais aguardar resposta do usuário
        st.conversaoAwaitMsg = false;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        if (!st.lastClassifiedIdx) st.lastClassifiedIdx = {};
        st.lastClassifiedIdx.conversao = 0;

        // Adição: Trigger automático para processar o batch 1 imediatamente
        const bot = require('../bot.js');
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));

        return { ok: true, batch: 1 };
    }

    // -------------------------------
    // BATCH 1 – taxa / validação
    // -------------------------------
    if (st.conversaoBatch === 1) {
        // m4 em 3 mensagens
        const m4_1 = [
            pick(conversao?.msg4?.msg4b1),
            pick(conversao?.msg4?.msg4b2),
        ].filter(Boolean).join(', ');

        const m4_2 = [
            pick(conversao?.msg4?.msg4b3),
            pick(conversao?.msg4?.msg4b4),
        ].filter(Boolean).join(', ');

        const m4_3 = pick(conversao?.msg4?.msg4b5);

        // m5: head + '?' + tail
        const m5_head = [
            pick(conversao?.msg5?.msg5b1),
            pick(conversao?.msg5?.msg5b2),
        ].filter(Boolean).join(', ');
        const m5_tail = pick(conversao?.msg5?.msg5b3);
        const m5 = m5_head
            ? `${m5_head}? ${m5_tail || ''}`.trim()
            : (m5_tail || '');

        // m6 em 3 mensagens
        const m6_1 = [
            pick(conversao?.msg6?.msg6b1),
            pick(conversao?.msg6?.msg6b2),
            pick(conversao?.msg6?.msg6b3),
        ].filter(Boolean).join(', ');

        const m6_2 = pick(conversao?.msg6?.msg6b4);

        const m6_3 = pick(conversao?.msg6?.msg6b5);

        const msgsBatch1 = [m4_1, m4_2, m4_3, m5, m6_1, m6_2, m6_3].filter(Boolean);

        for (let i = 0; i < msgsBatch1.length; i++) {
            const interruptedLabel =
                i === msgsBatch1.length - 1 ? 'optout-post-batch' : 'optout-mid-batch';
            if (await preflightOptOut(st)) return { ok: true, interrupted: interruptedLabel };
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            const r = await sendMessage(st.contato, msgsBatch1[i]);
            if (!r?.ok) return { ok: false, reason: 'send-aborted' };
        }

        st.conversaoBatch = 2;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        if (!st.lastClassifiedIdx) st.lastClassifiedIdx = {};
        st.lastClassifiedIdx.conversao = 0;

        // Adição: Trigger automático para processar o batch 2 imediatamente
        const bot = require('../bot.js');
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));

        return { ok: true, batch: 2 };
    }

    // --------------------------------------
    // BATCH 2 – reforço + atraso na mpay
    // --------------------------------------
    if (st.conversaoBatch === 2) {
        // m7 em 2 mensagens
        const m7_1 = [
            pick(conversao?.msg7?.msg7b1),
            pick(conversao?.msg7?.msg7b2),
        ].filter(Boolean).join(', ');

        const m7_2 = [
            pick(conversao?.msg7?.msg7b3),
            pick(conversao?.msg7?.msg7b4),
            pick(conversao?.msg7?.msg7b5),
        ].filter(Boolean).join(', ');

        // m8 em 2 mensagens
        const m8_1 = pick(conversao?.msg8?.msg8b1);
        const m8_2 = [
            pick(conversao?.msg8?.msg8b2),
            pick(conversao?.msg8?.msg8b3),
        ].filter(Boolean).join('. ');

        // m9 / m10 (4 mensagens, disparadas depois de 9–11 minutos)
        const m9_1 = [
            pick(conversao?.msg9?.msg9b1),
            pick(conversao?.msg9?.msg9b2),
        ].filter(Boolean).join(', ');

        const m9_2 = [
            pick(conversao?.msg9?.msg9b3),
            pick(conversao?.msg9?.msg9b4),
        ].filter(Boolean).join(', ');

        const m9_3 = [
            pick(conversao?.msg10?.msg10b1),
            pick(conversao?.msg10?.msg10b2),
        ].filter(Boolean).join(', ');

        const m9_4 = [
            pick(conversao?.msg10?.msg10b3),
            pick(conversao?.msg10?.msg10b4),
            pick(conversao?.msg10?.msg10b5),
        ].filter(Boolean).join(', ');

        const msgsBatch2Now = [
            m7_1,
            m7_2,
            m8_1,
            m8_2,
        ].filter(Boolean);

        for (let i = 0; i < msgsBatch2Now.length; i++) {
            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            const r = await sendMessage(st.contato, msgsBatch2Now[i]);
            const interruptedLabel =
                i === msgsBatch2Now.length - 1 ? 'optout-post-batch' : 'optout-mid-batch';
            if (await preflightOptOut(st)) return { ok: true, interrupted: interruptedLabel };
            if (!r?.ok) return { ok: false, reason: 'send-aborted' };
        }

        // Fecha batch 2 e entra em modo de espera automática (sem depender do usuário)
        st.conversaoBatch = 3;
        st.conversaoAwaitMsg = false;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        if (!st.lastClassifiedIdx) st.lastClassifiedIdx = {};
        st.lastClassifiedIdx.conversao = 0;

        const _prev = st.etapa;
        if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
        st.etapa = 'conversao:wait';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);

        // --------------------------------------
        // PAUSA 9–11 MIN APÓS msg8 → bloco m9–m12
        // --------------------------------------
        const delayMsg9Ms = Math.floor(9 + Math.random() * 3) * 60 * 1000; // 9–11 minutos

        setTimeout(async () => {
            if (await preflightOptOut(st)) return;

            // m9 / m10 (já montadas acima)
            const msgsM9 = [m9_1, m9_2, m9_3, m9_4].filter(Boolean);

            // m11
            const m11 = [
                pick(conversao?.msg11?.msg11b1),
                pick(conversao?.msg11?.msg11b2),
            ].filter(Boolean).join(', ') + '\n\n' +
                [
                    pick(conversao?.msg11?.msg11b3),
                    pick(conversao?.msg11?.msg11b4),
                ].filter(Boolean).join(', ');

            // m12
            const m12 = [
                pick(conversao?.msg12?.msg12b1),
                pick(conversao?.msg12?.msg12b2),
                pick(conversao?.msg12?.msg12b3),
                pick(conversao?.msg12?.msg12b4),
            ].filter(Boolean).join(', ');

            const msgsAteM12 = [...msgsM9, m11, m12].filter(Boolean);

            for (const msg of msgsAteM12) {
                if (await preflightOptOut(st)) return;
                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                await sendMessage(st.contato, msg);
            }

            if (await preflightOptOut(st)) return;

            // --------------------------------------
            // PAUSA 14–16 MIN APÓS msg12 → m13 em diante
            // --------------------------------------
            const delayDepoisM12Ms = Math.floor(14 + Math.random() * 3) * 60 * 1000; // 14–16 minutos

            setTimeout(async () => {
                if (await preflightOptOut(st)) return;

                const m13 = [
                    pick(conversao?.msg13?.msg13b1),
                    pick(conversao?.msg13?.msg13b2),
                ].filter(Boolean).join(', ');

                const m14 = [
                    pick(conversao?.msg14?.msg14b1),
                    pick(conversao?.msg14?.msg14b2),
                    pick(conversao?.msg14?.msg14b3),
                ].filter(Boolean).join(', ');

                const m15 = [
                    pick(conversao?.msg15?.msg15b1),
                    pick(conversao?.msg15?.msg15b2),
                    pick(conversao?.msg15?.msg15b3),
                ].filter(Boolean).join(', ');

                const m16 = [
                    pick(conversao?.msg16?.msg16b1),
                    pick(conversao?.msg16?.msg16b2),
                    pick(conversao?.msg16?.msg16b3),
                ].filter(Boolean).join(', ') + '?';

                const ultimasMsgs = [m13, m14, m15, m16].filter(Boolean);

                for (const msg of ultimasMsgs) {
                    if (await preflightOptOut(st)) break;
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    await sendMessage(st.contato, msg);
                }
            }, delayDepoisM12Ms);
        }, delayMsg9Ms);

        return { ok: true, batch: 3, done: true };
    }

    // Se já passou de todo o fluxo, só garante etapa consistente
    if (st.conversaoBatch >= 3) {
        st.conversaoAwaitMsg = false;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        const _prev = st.etapa;
        st.etapa = 'conversao:wait';
        console.log(`[${st.contato}] ${_prev} -> ${st.etapa}`);
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
