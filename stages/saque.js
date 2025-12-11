const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { delayRange, tsNow, chooseUnique, BETWEEN_MIN_MS, BETWEEN_MAX_MS, safeStr, truncate } = require('../utils.js');
const { preflightOptOut, enterStageOptOutResetIfNeeded, finalizeOptOutBatchAtEnd } = require('../optout.js');
const { sendMessage, sendImage } = require('../senders.js');
const { promptClassificaRelevancia } = require('../prompts');

async function handleSaqueSend(st) {
    enterStageOptOutResetIfNeeded(st);
    const saquePath = path.join(__dirname, '../content', 'saque.json');
    let saqueData = null;
    function gerarSenhaAleatoria() { return String(Math.floor(1000 + Math.random() * 9000)); }
    const loadSaque = () => {
        if (saqueData) return saqueData;
        let raw = fs.readFileSync(saquePath, 'utf8');
        raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
        saqueData = JSON.parse(raw);
        return saqueData;
    };
    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

    const composeAndSend = async (key) => {
        const msgObj = c[key];
        if (!msgObj) return { ok: true, skipped: true };

        if (msgObj.type === 'image') {
            const imgUrl = pick(msgObj.images);
            const caption = pick(msgObj.caption || []);
            if (!imgUrl) return { ok: false, reason: 'no-image-url' };

            const r = await sendImage(st.contato, imgUrl, { caption });
            return r;
        } else {
            const blocos = [];
            let j = 1;
            while (true) {
                const bkey = `bloco${j}`;
                if (!msgObj[bkey]) break;
                blocos.push(pick(msgObj[bkey]));
                j++;
            }

            let m = '';
            const filteredBlocos = blocos.filter(Boolean);
            if (filteredBlocos.length > 0) {
                switch (key) {
                    case 'msg1':
                        m = filteredBlocos.join(', ');
                        break;
                    case 'msg2':
                        m = filteredBlocos.join(', ');
                        break;
                    case 'msg4':
                        m = filteredBlocos.join(', ');
                        break;
                    case 'msg6':
                        m = `${[filteredBlocos[0], filteredBlocos[1]].filter(Boolean).join(' ')}: ${[filteredBlocos[2], filteredBlocos[3]].filter(Boolean).join(', ')}${filteredBlocos[4] ? '… ' + filteredBlocos[4] : ''}${filteredBlocos[5] ? ', ' + filteredBlocos[5] : ''}`.trim();
                        break;
                    case 'msg7':
                        const header = filteredBlocos.slice(0, 2).filter(Boolean).join(', ');
                        const headLine = header ? `${header}:` : '';
                        const s1 = gerarSenhaAleatoria();
                        const s2 = '8293';
                        const s3 = gerarSenhaAleatoria();
                        m = `${headLine}\n\n${s1}\n${s2}\n${s3}`.trim();
                        break;
                    case 'msg8':
                        const left = [filteredBlocos[0], filteredBlocos[1]].filter(Boolean).join(', ');
                        const right = filteredBlocos[2] ? `${filteredBlocos[2]}!` : '';
                        const tail = filteredBlocos.slice(3).filter(Boolean).join(', ');
                        m = `${[left, right].filter(Boolean).join(' ')}${tail ? ` ${tail}` : ''}`.trim();
                        break;
                    default:
                        m = filteredBlocos.join(', ');
                        break;
                }
            }
            if (!m) return { ok: true, skipped: true };
            return await sendMessage(st.contato, m);
        }
    };

    const c = loadSaque();

    for (let i = 1; i <= 8; i++) {
        const key = `msg${i}`;

        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);

        if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-pre-multi' };

        const r = await composeAndSend(key);

        if (!r?.ok) {
            return { ok: true, paused: r?.reason || 'send-skipped' };
        }

        if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-post-multi' };
    }

    st.mensagensPendentes = [];
    st.mensagensDesdeSolicitacao = [];
    st.lastClassifiedIdx = st.lastClassifiedIdx || {};
    st.lastClassifiedIdx.saque = 0;
    st.saquePediuPrint = false;

    const _prev = st.etapa;
    if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-batch-end' };
    st.etapa = 'saque:wait';
    console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
    return { ok: true };
}

async function handleSaqueWait(st) {
    if (await preflightOptOut(st)) return { ok: true, interrupted: 'optout-hard-wait' };
    if (await finalizeOptOutBatchAtEnd(st)) return { ok: true, interrupted: 'optout-ia-wait' };
    if (!Array.isArray(st.mensagensPendentes) || st.mensagensPendentes.length === 0) {
        return { ok: true, noop: 'waiting-user' };
    }
    const totalPend = st.mensagensPendentes.length;
    const startIdx = Math.min(totalPend, Math.max(0, Number(st.lastClassifiedIdx?.saque || 0)));
    const novasMsgs = st.mensagensPendentes.slice(startIdx);
    if (novasMsgs.length === 0) {
        st.mensagensPendentes = [];
        st.lastClassifiedIdx.saque = 0;
        return { ok: true, noop: 'no-new-messages' };
    }
    const apiKey = process.env.OPENAI_API_KEY;
    const looksLikeMediaUrl = (s) => {
        const n = String(s || '');
        return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
            || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
    };
    let temImagem = false;
    for (const m of novasMsgs) {
        const msg = safeStr(m?.texto || '').trim();
        if (m?.temMidia || m?.hasMedia || looksLikeMediaUrl(msg) || /^\[m[ií]dia\]$/i.test(msg)) {
            console.log(`[${st.contato}] Análise: imagem ("${truncate(msg, 140)}")`);
            temImagem = true;
            break;
        }
    }
    if (temImagem) {
        st.lastClassifiedIdx.saque = 0;
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        st.saquePediuPrint = false;
        const _prev = st.etapa;
        st.etapa = 'validacao:send';
        console.log(`${tsNow()} [${st.contato}] ${_prev} -> ${st.etapa}`);
        st.mensagensPendentes = [];
        st.mensagensDesdeSolicitacao = [];
        const bot = require('../bot.js');
        process.nextTick(() => bot.processarMensagensPendentes(st.contato));
        return { ok: true, transitioned: true };
    } else {
        let relevante = false;
        if (apiKey) {
            const contexto = novasMsgs.map(m => safeStr(m?.texto || '')).join(' | ');
            const structuredPrompt =
                `${promptClassificaRelevancia(contexto, false)}\n\n` +
                `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
                `{"label": "relevante"} or {"label": "irrelevante"}`;
            const callOnce = async (maxTok) => {
                let r;
                try {
                    r = await axios.post(
                        'https://api.openai.com/v1/responses',
                        { model: 'gpt-5', input: structuredPrompt, max_output_tokens: maxTok, reasoning: { effort: 'low' } },
                        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true }
                    );
                } catch (e) {
                    console.error(`[${st.contato}] Erro na chamada à API: ${e.message}`);
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

                if (!rawText) {
                    try {
                        const { extractTextForLog } = require('../bot.js');
                        if (typeof extractTextForLog === 'function') {
                            rawText = String(extractTextForLog(data) || '').trim();
                        }
                    } catch (e) {
                    }
                }

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

                if (!picked) {
                    try {
                        const { pickLabelFromResponseData } = require('../bot.js');
                        if (typeof pickLabelFromResponseData === 'function') {
                            picked = pickLabelFromResponseData(data, ['relevante', 'irrelevante']) || null;
                        }
                    } catch (e) {
                    }
                }

                return { status: r.status, picked };
            };
            try {
                let resp = await callOnce(64);
                if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) resp = await callOnce(256);
                relevante = (resp.status >= 200 && resp.status < 300 && resp.picked === 'relevante');
                console.log(`[${st.contato}] Análise: ${resp.picked || (relevante ? 'relevante' : 'irrelevante')} ("${truncate(contexto, 140)}")`);
            } catch (e) {
                console.error(`[${st.contato}] Erro na classificação de relevância: ${e.message}`);
            }
        } else {
            console.warn(`[${st.contato}] API Key não configurada; assumindo irrelevante.`);
        }
        st.lastClassifiedIdx.saque = 0;
        st.mensagensPendentes = [];
        if (relevante) {
            const saquePath = path.join(__dirname, '../content', 'saque.json');
            let raw = fs.readFileSync(saquePath, 'utf8');
            raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
            const parsed = JSON.parse(raw);
            const lista = Array.isArray(parsed?.msgprint) ? parsed.msgprint : [];
            if (!lista.length) return { ok: true, classe: 'aguardando_imagem' };
            if (!st.saquePediuPrint) {
                const pickLocal = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                const m = pickLocal(lista);
                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                const r = m ? await sendMessage(st.contato, m) : { ok: true };
                if (!r?.ok) return { ok: true, paused: r?.reason || 'send-skipped' };
                st.saquePediuPrint = true;
                return { ok: true, classe: 'relevante' };
            }
            return { ok: true, classe: 'aguardando_imagem' };
        }
        return { ok: true, classe: 'irrelevante' };
    }
}

module.exports = { handleSaqueSend, handleSaqueWait };