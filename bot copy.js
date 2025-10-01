const axios = require('axios');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { getActiveTransport } = require('./lib/transport');
const { atualizarContato, getBotSettings, pool, getContatoByPhone } = require('./db');
const { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia, promptClassificaOptOut, promptClassificaReoptin } = require('./prompts.js');
const estadoContatos = require('./state.js');

const EXTRA_FIRST_REPLY_BASE_MS = 45000;
const EXTRA_FIRST_REPLY_JITTER_MS = 10000;
const GLOBAL_PER_MSG_BASE_MS = 3000;
const GLOBAL_PER_MSG_JITTER_MS = 1500;

const processingDebounce = new Map();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const OPTOUT_RX = /\b(pare|para(?!\w)|parar|não quero|nao quero|me remove|remova|me tira|me exclui|excluir|cancelar|unsubscribe|cancel|stop|parem|não mandar|nao mandar)\b/i;

const MAX_OPTOUTS = 3;
const OPTOUT_MSGS = {
    1: 'tranquilo, não vou mais te mandar mensagem. qualquer coisa só chamar',
    2: 'de boa, vou passar o trampo pra outra pessoa e não te chamo mais. não me manda mais mensagem',
};

// --- normalização & detecção --- //
function norm(str) {
    return String(str || '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase().trim();
}

// --- mídia & números: utilidades globais --- //
const truthyFlag = v => v === true || v === 'true' || v === 1 || v === '1';

function looksLikeMediaUrl(s) {
    const n = String(s || '');
    return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
        || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
}

function isMediaMessage(m) {
    if (!m) return false;
    if (truthyFlag(m.temMidia) || truthyFlag(m.hasMedia)) return true;

    // procura URLs de mídia em vários campos comuns
    const possible = [m.texto, m.url, m.mediaUrl, m.media_url, m.preview, m.previewUrl]
        .filter(Boolean)
        .join(' ');
    if (looksLikeMediaUrl(possible)) return true;

    // alguns conectores mandam "type: image"
    const t = String(m.type || '').toLowerCase();
    return t === 'image' || t === 'photo' || t === 'video';
}

function tsEmMs(m) {
    const cands = [
        m.ts, m.timestamp, m.time, m.date, m.createdAt, m.created_at,
        m.sentAt, m.sent_at, m.recebidaEm
    ];
    for (const v of cands) {
        if (v == null) continue;
        const n = typeof v === 'number' ? v : Date.parse(v);
        if (!Number.isNaN(n) && n > 0) {
            // se vier em segundos, normaliza para ms
            return String(v).length <= 10 ? n * 1000 : n;
        }
    }
    return null; // sem timestamp detectável
}

function _ensureSentMap(estado) {
    if (!estado.sentKeys) estado.sentKeys = {};
}
function wasSent(estado, key) {
    _ensureSentMap(estado);
    return !!estado.sentKeys[key];
}
function markSent(estado, key) {
    _ensureSentMap(estado);
    estado.sentKeys[key] = Date.now();
}

async function sendOnce(contato, estado, key, texto, opts = {}) {
    if (wasSent(estado, key)) return false;
    await sendMessage(contato, texto, opts);
    markSent(estado, key);
    estado.historico.push({ role: 'assistant', content: texto });
    return true;
}

async function setDoNotContact(contato, value = true) {
    try {
        await pool.query('UPDATE contatos SET do_not_contact = $2 WHERE id = $1', [contato, !!value]);
        console.log(`[${contato}] do_not_contact atualizado para ${!!value}`);
        if (!value) cancelarConfirmacaoOptOut(contato);
    } catch (e) {
        console.error(`[${contato}] Falha ao setar do_not_contact: ${e.message}`);
    }
}

async function finalizeOptOut(contato, reasonText = '') {
    let permanently = false;

    try {
        const { rows } = await pool.query(
            'SELECT opt_out_count, permanently_blocked FROM contatos WHERE id = $1 LIMIT 1',
            [contato]
        );
        if (rows?.[0]?.permanently_blocked || (rows?.[0]?.opt_out_count || 0) >= MAX_OPTOUTS) return;

        const next = (rows?.[0]?.opt_out_count || 0) + 1;
        permanently = next >= MAX_OPTOUTS;

        await pool.query(`
      UPDATE contatos
         SET do_not_contact = TRUE,
             do_not_contact_at = NOW(),
             do_not_contact_reason = $2,
             opt_out_count = $3,
             permanently_blocked = $4
       WHERE id = $1
    `, [contato, String(reasonText || '').slice(0, 200), next, permanently]);

        const st = estadoContatos[contato] || {};
        if (st?._timer2Abertura) clearTimeout(st._timer2Abertura);
        if (st?.merrecaTimeout) clearTimeout(st.merrecaTimeout);
        if (st?.posMerrecaTimeout) clearTimeout(st.posMerrecaTimeout);

        if (estadoContatos[contato]) {
            estadoContatos[contato].cancelarEnvio = true;
            estadoContatos[contato].enviandoMensagens = false;
            estadoContatos[contato].mensagensPendentes = [];
            if (permanently) {
                estadoContatos[contato].etapa = 'encerrado';
                delete estadoContatos[contato].seqLines;
                delete estadoContatos[contato].seqIdx;
                estadoContatos[contato].paused = false;
            } else {
                estadoContatos[contato].paused = true;
            }
        }

        if (!permanently) {
            // agenda confirmação CANCELÁVEL
            cancelarConfirmacaoOptOut(contato);
            const delayMs = rand(10000, 15000);
            const timer = setTimeout(async () => {
                try {
                    const { rows: r } = await pool.query(
                        'SELECT do_not_contact, permanently_blocked FROM contatos WHERE id = $1 LIMIT 1',
                        [contato]
                    );
                    if (!r?.[0]?.do_not_contact || r?.[0]?.permanently_blocked) return;
                    await sendMessage(contato, OPTOUT_MSGS[next] || OPTOUT_MSGS[2], { bypassBlock: true });
                } finally {
                    const st2 = estadoContatos[contato];
                    if (st2) st2._optoutTimer = null;
                }
            }, delayMs);
            if (estadoContatos[contato]) estadoContatos[contato]._optoutTimer = timer;
        }
    } catch (e) {
        console.error(`[${contato}] Falha ao registrar opt-out: ${e.message}`);
    }

    console.log(`[${contato}] Opt-out concluído (${permanently ? 'permanente' : 'temporário'}).`);
}

async function checarOptOutGlobal(contato, mensagens) {
    try {
        const arr = Array.isArray(mensagens) ? mensagens : [String(mensagens || '')];

        for (const txt of arr) {
            const texto = String(txt || '').trim();
            // 1) regex rápido
            if (OPTOUT_RX.test(texto)) {
                await finalizeOptOut(contato, texto);
                console.log(`[${contato}] Opt-out detectado via REGEX em: "${texto}"`);
                return true;
            }
            // 2) IA (se qualquer UMA for OPTOUT, para tudo)
            const out = await gerarResposta(
                [{ role: 'system', content: promptClassificaOptOut(texto) }],
                ['OPTOUT', 'CONTINUAR']
            );
            if (String(out || '').trim().toUpperCase() === 'OPTOUT') {
                await finalizeOptOut(contato, texto);
                console.log(`[${contato}] Opt-out detectado via LLM em: "${texto}"`);
                return true;
            }
        }

        console.log(`[${contato}] Sem opt-out nas mensagens analisadas.`);
        return false;
    } catch (err) {
        console.error(`[${contato}] Erro em checarOptOutGlobal:`, err?.message || err);
        return false;
    }
}

function cancelarConfirmacaoOptOut(contato) {
    const st = estadoContatos[contato];
    if (st && st._optoutTimer) {
        clearTimeout(st._optoutTimer);
        st._optoutTimer = null;
        console.log(`[${contato}] Confirmação de opt-out pendente CANCELADA.`);
    }
}

async function retomarEnvio(contato) {
    const st = estadoContatos[contato];
    if (!st || !Array.isArray(st.seqLines)) {
        console.log(`[${contato}] Nada para retomar (sem seqLines).`);
        return false;
    }

    const startIdx = st.seqIdx || 0;
    const remaining = st.seqLines.slice(startIdx).join('\n');
    if (!remaining.trim()) {
        delete st.seqLines;
        delete st.seqIdx;
        st.paused = false;
        console.log(`[${contato}] Nada para retomar (sequência já concluída).`);
        return false;
    }

    await delay(rand(10000, 15000));

    try {
        const { rows } = await pool.query(
            'SELECT opt_out_count FROM contatos WHERE id = $1 LIMIT 1',
            [contato]
        );
        const count = rows?.[0]?.opt_out_count || 0;

        let retomadaMsg = null;
        if (count === 1) {
            retomadaMsg = 'certo, vamos continuar então';
        } else if (count >= 2) {
            retomadaMsg = 'última chance, se não for fazer já me avisa pq não posso ficar perdendo tempo não, vou tentar continuar de novo aqui, vamos lá';
        }

        if (retomadaMsg) {
            await sendMessage(contato, retomadaMsg);
            try {
                await atualizarContato(contato, 'Sim', st.etapa || 'retomada', retomadaMsg);
                st.historico?.push?.({ role: 'assistant', content: retomadaMsg });
            } catch (e) {
                console.error(`[${contato}] Falha ao logar mensagem de retomada: ${e.message}`);
            }
        }
    } catch (e) {
        console.error(`[${contato}] Falha ao buscar opt_out_count para retomada: ${e.message}`);
    }

    st.cancelarEnvio = false;
    st.paused = false;

    await enviarLinhaPorLinha(contato, remaining);
    if (!st.seqLines && st.seqKind === 'credenciais') {
        st.credenciaisEntregues = true;
        st.seqKind = null;
        console.log(`[${contato}] Credenciais concluídas na retomada.`);
    }
    return true;
}

function toUpperSafe(x) { return String(x || "").trim().toUpperCase(); }

function normalizeAllowedLabels(allowedLabels) {
    if (Array.isArray(allowedLabels)) return allowedLabels.map(toUpperSafe).filter(Boolean);
    if (typeof allowedLabels === "string") return allowedLabels.split(/[|,]/).map(toUpperSafe).filter(Boolean);
    return [];
}

function pickValidLabel(text, allowed) {
    if (!allowed.length) return null;
    const first = String(text || "").trim().split(/\s+/)[0];
    const u = toUpperSafe(first);
    return allowed.includes(u) ? u : null;
}

function extractJsonLabel(outputText, allowed) {
    try {
        const obj = JSON.parse(outputText || "{}");
        return pickValidLabel(obj.label, allowed);
    } catch { return null; }
}

async function gerarResposta(messages, allowedLabels) {
    const allow = normalizeAllowedLabels(allowedLabels || []);
    const DEFAULT_LABEL = allow.includes("CONTINUAR") ? "CONTINUAR" : (allow[0] || "UNKNOWN");

    try {
        const promptStr = messages.map(m => m.content).join("\n");

        const promptJson = `${promptStr}

Retorne estritamente JSON, exatamente neste formato:
{"label":"${allow.join("|").toLowerCase()}"}`;

        let res = await openai.responses.create({
            model: "gpt-5",
            input: promptJson,
            max_output_tokens: 24  // (mínimo aceito é 16)
            // não envie temperature/top_p/stop (snapshots do gpt-5 podem rejeitar)
        });

        let outText = String(res.output_text || "").trim();
        let label = extractJsonLabel(outText, allow);

        // 2) Fallback: se não for JSON válido, peça 1 palavra e valide
        if (!label) {
            res = await openai.responses.create({
                model: "gpt-5",
                input: `${promptStr}\n\nResponda APENAS com UMA palavra válida: ${allow.join("|")}`,
                max_output_tokens: 24
            });
            const raw = String(res.output_text || "").trim();
            label = pickValidLabel(raw, allow);
        }

        return label || DEFAULT_LABEL;
    } catch (err) {
        console.error("[OpenAI] Erro:", err?.message || err);
        return DEFAULT_LABEL; // não quebra seu fluxo
    }
}

async function decidirOptLabel(texto) {
    const raw = String(texto || '').trim();

    const HARD_STOP = /\b(?:stop|unsubscribe|remover|remova|remove|excluir|exclui(?:r)?|cancelar|cancela|cancelamento|para(?!\w)|parem|pare|nao quero|não quero|não me chame|nao me chame|remove meu número|remova meu numero|golpe|golpista|crime|criminoso|denunciar|denúncia|policia|polícia|federal|civil)\b/i;

    if (HARD_STOP.test(raw)) return 'OPTOUT';

    // Fast-path de retomada para frases batidas (não substitui a IA; só agiliza)
    const norm = raw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const RE_PHRASES = [
        'mudei de ideia', 'quero fazer', 'quero sim', 'vou querer sim',
        'pode continuar', 'pode seguir', 'pode mandar', 'pode prosseguir', 'pode enviar',
        'vamos', 'vamo', 'bora', 'to dentro', 'tô dentro', 'topo', 'fechou', 'fechado', 'partiu', 'segue'
    ];
    if (RE_PHRASES.some(p => norm.includes(p))) return 'REOPTIN';

    // 1) seu prompt de OPT-OUT (com todas as palavras que você exigiu)
    try {
        const r1 = await gerarResposta(
            [{ role: 'system', content: promptClassificaOptOut(raw) }],
            ['OPTOUT', 'CONTINUAR']
        );
        if (String(r1 || '').trim().toUpperCase() === 'OPTOUT') return 'OPTOUT';
    } catch { }

    // 2) não sendo opt-out → seu prompt de RE-OPT-IN
    try {
        const r2 = await gerarResposta(
            [{ role: 'system', content: promptClassificaReoptin(raw) }],
            ['REOPTIN', 'CONTINUAR']
        );
        if (String(r2 || '').trim().toUpperCase() === 'REOPTIN') return 'REOPTIN';
    } catch { }

    // 3) default
    return 'CONTINUAR';
}

function gerarSenhaAleatoria() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

async function enviarLinhaPorLinha(to, texto) {
    const estado = estadoContatos[to];
    if (!estado) {
        console.log(`[${to}] Erro: Estado não encontrado em enviarLinhaPorLinha`);
        return;
    }

    try {
        const { rows } = await pool.query(
            'SELECT do_not_contact, opt_out_count, permanently_blocked FROM contatos WHERE id = $1 LIMIT 1',
            [to]
        );
        const f = rows?.[0] || {};
        if (f.permanently_blocked || (f.opt_out_count || 0) >= MAX_OPTOUTS || f.do_not_contact) {
            console.log(`[${to}] Bloqueado antes do envio (DNC/limite).`);
            return;
        }
    } catch (e) {
        console.error(`[${to}] Falha ao checar bloqueio antes do envio: ${e.message}`);
        return;
    }

    // Selo de identidade (apenas na 1ª resposta da abertura)
    try {
        const isFirstResponse = (estado.etapa === 'abertura' && !estado.aberturaConcluida);
        if (isFirstResponse) {
            const settings = await getBotSettings().catch(() => null);
            const enabled = settings?.identity_enabled !== false;
            let label = (settings?.identity_label || '').trim();

            if (!label) {
                const pieces = [];
                if (settings?.support_email) pieces.push(settings.support_email);
                if (settings?.support_phone) pieces.push(settings.support_phone);
                if (settings?.support_url) pieces.push(settings.support_url);
                if (pieces.length) label = `Suporte • ${pieces.join(' | ')}`;
            }

            if (enabled && label) {
                texto = `${label}\n${texto}`;
            }
        }
    } catch (e) {
        console.error('[SeloIdent] Falha ao avaliar/preparar label:', e.message);
    }

    // Sufixo de opt-out (apenas na 1ª resposta da abertura)
    try {
        const isFirstResponse = (estado.etapa === 'abertura' && !estado.aberturaConcluida);
        if (isFirstResponse) {
            const settings = await getBotSettings().catch(() => null);
            const optHintEnabled = settings?.optout_hint_enabled !== false; // default ON
            const suffix = (settings?.optout_suffix || '· se não quiser: NÃO QUERO').trim();

            if (optHintEnabled && suffix) {
                const linhasTmp = texto.split('\n');
                // pega a última linha não-vazia
                let idx = linhasTmp.length - 1;
                while (idx >= 0 && !linhasTmp[idx].trim()) idx--;
                if (idx >= 0 && !linhasTmp[idx].includes(suffix)) {
                    linhasTmp[idx] = `${linhasTmp[idx]} ${suffix}`;
                    texto = linhasTmp.join('\n');
                }
            }
        }
    } catch (e) {
        console.error('[OptOutHint] Falha ao anexar sufixo:', e.message);
    }

    // Envio linha a linha com memória de progresso (seqLines/seqIdx)
    console.log(`[${to}] Iniciando envio de mensagem: "${texto}"`);

    await delay(10000); // pacing inicial

    const linhas = texto.split('\n').filter(line => line.trim() !== '');

    // snapshot da sequência no estado (só recria se o conteúdo mudou)
    if (!Array.isArray(estado.seqLines) || estado.seqLines.join('\n') !== linhas.join('\n')) {
        estado.seqLines = linhas.slice();
        estado.seqIdx = 0; // começa do início desta sequência
    }

    for (let i = estado.seqIdx || 0; i < estado.seqLines.length; i++) {
        const linha = estado.seqLines[i];
        try {
            // 🛑 checkpoints de cancelamento/pausa
            if (estado.cancelarEnvio || estado.paused) {
                console.log(`[${to}] Loop interrompido: cancelarEnvio/paused=true.`);
                estado.enviandoMensagens = false;
                return; // mantém seqIdx para retomar
            }

            // 🛑 rechecar bloqueio entre linhas (DNC/limite)
            try {
                const { rows } = await pool.query(
                    'SELECT do_not_contact, opt_out_count, permanently_blocked FROM contatos WHERE id = $1 LIMIT 1',
                    [to]
                );
                const f = rows?.[0] || {};
                if (f.permanently_blocked || (f.opt_out_count || 0) >= MAX_OPTOUTS || f.do_not_contact) {
                    console.log(`[${to}] Loop interrompido: bloqueado entre linhas (DNC/limite).`);
                    estado.enviandoMensagens = false;
                    return;
                }
            } catch (e) {
                console.error(`[${to}] Falha ao checar bloqueio entre linhas: ${e.message}`);
                estado.enviandoMensagens = false;
                return;
            }

            await delay(Math.max(500, linha.length * 30));
            await sendMessage(to, linha);
            estado.seqIdx = i + 1; // avançou uma linha
            await delay(7000 + Math.floor(Math.random() * 1000));
        } catch (error) {
            console.error(`[${to}] Erro ao enviar linha "${linha}": ${error.message}`);
            estado.enviandoMensagens = false;
            return;
        }
    }

    // sequência concluída — limpar snapshot
    delete estado.seqLines;
    delete estado.seqIdx;
    estado.paused = false;
}


async function sendManychatBatch(phone, textOrLines) {
    const settings = await getBotSettings().catch(() => ({}));
    const token =
        process.env.MANYCHAT_API_TOKEN ||
        process.env.MANYCHAT_API_KEY ||
        settings.manychat_api_token;
    if (!token) throw new Error('ManyChat: token ausente');

    const contato = await getContatoByPhone(phone).catch(() => null);
    const subscriberId =
        contato?.manychat_subscriber_id ||
        estadoContatos[phone]?.manychat_subscriber_id ||
        null;
    if (!subscriberId) {
        console.warn(`[ManyChat] subscriberId ausente para ${phone} — pulando envio externo (simulação/local).`);
        return { ok: true, skipped: true, reason: 'no-subscriber' };
    }

    const payloadItems = Array.isArray(textOrLines)
        ? textOrLines.map(s => String(s))
        : [String(textOrLines)];
    const messages = payloadItems.slice(0, 10).map(t => ({ type: 'text', text: t }));
    if (!messages.length) return { skipped: true };

    const basePayload = {
        subscriber_id: Number(subscriberId),
        data: { version: 'v2', content: { type: 'whatsapp', messages } }
    };

    async function postMC(path, payload, label) {
        const url = `https://api.manychat.com${path}`;
        const resp = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            validateStatus: () => true
        });
        const brief = typeof resp.data === 'string' ? resp.data.slice(0, 300) : resp.data;

        if (resp.status >= 400 || resp.data?.status === 'error') {
            const err = new Error(`${label} falhou: HTTP ${resp.status}`);
            err.httpStatus = resp.status;
            err.body = resp.data;
            throw err;
        }
        return resp.data;
    }

    try {
        // ✅ SEMPRE usar o namespace /fb (mesmo pro WhatsApp)
        return await postMC('/fb/sending/sendContent', basePayload, 'sendContent/fb');
    } catch (e) {
        // Janela de 24h estourada → usar Flow (template)
        const code = e.body?.code;
        const msg = (e.body?.message || '').toLowerCase();
        const is24h = code === 3011 || /24|window|tag/.test(msg);

        if (!is24h) throw e;

        const flowNs = settings.manychat_fallback_flow_id || process.env.MANYCHAT_FALLBACK_FLOW_ID;
        if (!flowNs) {
            throw new Error('ManyChat: fora da janela e MANYCHAT_FALLBACK_FLOW_ID não configurado.');
        }

        const flowPayload = { subscriber_id: Number(subscriberId), flow_ns: flowNs };
        return await postMC('/fb/sending/sendFlow', flowPayload, 'sendFlow/fb');
    }
}

async function sendMessage(to, text, opts = {}) {
    const { bypassBlock = false } = opts;

    if (typeof text === 'function') {
        try { text = text(); } catch (e) { text = String(text); }
    }

    let extraWait = GLOBAL_PER_MSG_BASE_MS + Math.floor(Math.random() * GLOBAL_PER_MSG_JITTER_MS);
    const st = estadoContatos[to];
    if (st?.primeiraRespostaPendente) {
        extraWait += EXTRA_FIRST_REPLY_BASE_MS + Math.floor(Math.random() * EXTRA_FIRST_REPLY_JITTER_MS);
        st.primeiraRespostaPendente = false;
    }
    await delay(extraWait);

    if (!bypassBlock) {
        try {
            const { rows } = await pool.query(
                'SELECT do_not_contact, opt_out_count, permanently_blocked FROM contatos WHERE id = $1 LIMIT 1',
                [to]
            );
            const f = rows?.[0] || {};
            if (f.permanently_blocked || (f.opt_out_count || 0) >= MAX_OPTOUTS || f.do_not_contact) {
                console.log(`[${to}] Envio cancelado (DNC/limite).`);
                return { skipped: true, reason: 'blocked' };
            }
        } catch (e) {
            console.error(`[${to}] Falha ao re-checar bloqueio antes do envio: ${e.message}`);
            return { skipped: true, reason: 'db_error' };
        }
    }

    const { mod: transport, settings } = await getActiveTransport();

    if (transport.name === 'manychat') {
        const payloadItems = Array.isArray(text) ? text.map(String) : [String(text)];
        return await sendManychatBatch(to, payloadItems);
    }

    if (transport.name === 'twilio') {
        const sanitized = to.replace(/^whatsapp:/, '');
        return transport.sendText({ to: sanitized, text }, settings);
    }

    return transport.sendText({ to, text }, settings);
}

function inicializarEstado(contato, tid = '', click_type = 'Orgânico') {
    estadoContatos[contato] = {
        etapa: 'abertura',
        primeiraRespostaPendente: true,
        historico: [],
        encerrado: false,
        ultimaMensagem: Date.now(),
        credenciais: null,
        credenciaisEntregues: false,
        instrucoesConcluida: false,
        instrucoesSequenciada: false,
        instrMsg1Enviada: false,
        instrMsg2Enviada: false,
        instrMsg3Enviada: false,
        acessoMsgsDisparadas: false,
        acessoMsg1Enviada: false,
        acessoMsg2Enviada: false,
        acessoMsg3Enviada: false,
        aguardandoAceiteInstrucoes: false,
        mensagensPendentes: [],
        mensagensDesdeSolicitacao: [],
        saqueInstrucoesEnviadas: false,
        validacaoMsgInicialEnviada: false,
        validacaoRecebeuMidia: false,
        aguardandoPrint: false,
        negativasAbertura: 0,
        aberturaConcluida: false,
        instrucoesEnviadas: false,
        encerradoAte: null,
        aguardandoAcompanhamento: false,
        tentativasAcesso: 0,
        saqueInstrucoesEnviadas: false,
        tentativasConfirmacao: 0,
        saldo_informado: null,
        mensagemDelayEnviada: false,
        enviandoMensagens: false,
        confirmacaoMsgInicialEnviada: false,
        instrucoesCompletas: false,
        aguardandoPrint: false,
        tid: tid,
        click_type: click_type,
        capiContactSent: false
    };
    atualizarContato(contato, 'Sim', 'abertura');
    console.log(`[${contato}] Estado inicializado e contato atualizado: Sim, abertura. TID: ${tid}, click_type: ${click_type}`);
}

async function criarUsuarioDjango(contato) {
    const DJANGO_API_URL = process.env.DJANGO_API_URL || 'https://www.cointex.cash/api/create-user/';

    const st = estadoContatos[contato] || {};
    const tid = st.tid || '';
    const click_type = st.click_type || 'Orgânico';

    // normaliza para E.164 com +
    const phone_e164 = /^\+/.test(contato) ? contato : `+${contato}`;

    const body = { tid, click_type, phone_number: phone_e164 };

    const MAX_TRIES = 3;
    let lastErr;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        try {
            console.log(`[${contato}] Enviando para API Cointex (tentativa ${attempt}/${MAX_TRIES}):`, JSON.stringify(body));

            const resp = await axios.post(DJANGO_API_URL, body, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000,
                validateStatus: () => true
            });

            console.log(`[${contato}] Cointex HTTP ${resp.status}`, resp.data);

            // retry específico pro bug "cannot access local variable 'phone_number'..."
            const retriable500 =
                resp.status === 500 &&
                typeof resp.data?.message === 'string' &&
                /cannot access local variable 'phone_number'/i.test(resp.data.message);

            if (retriable500) {
                await delay(250 + Math.floor(Math.random() * 750));
                continue; // tenta novamente
            }

            if (resp.status < 200 || resp.status >= 300) {
                throw new Error(`Cointex retornou ${resp.status}`);
            }

            const data = resp.data || {};
            if (data.status === 'success' && Array.isArray(data.users) && data.users[0]) {
                const u = data.users[0];
                estadoContatos[contato].credenciais = {
                    username: u.email,
                    password: u.password,
                    link: u.login_url
                };
                console.log(`[${contato}] Usuário criado: ${u.email}`);
            } else {
                console.error(`[${contato}] Resposta inesperada da API Cointex: ${JSON.stringify(data)}`);
            }
            return; // sucesso
        } catch (err) {
            lastErr = err;
            console.error(`[${contato}] Erro na API Django (tentativa ${attempt}/${MAX_TRIES}): ${err.message}`);
            await delay(300 + Math.floor(Math.random() * 900)); // backoff simples
        }
    }

    if (lastErr) {
        console.error(`[${contato}] Falha definitiva ao criar usuário na Cointex: ${lastErr.message}`);
    }
}

async function processarMensagensPendentes(contato) {
    try {
        const estado = estadoContatos[contato];
        if (!estado) return;
        if (estado.enviandoMensagens) {
            console.log(`[${contato}] Skipped processing (already running)`);
            return;
        }
        estado.enviandoMensagens = true;
        if (estado && (estado.merrecaTimeout || estado.posMerrecaTimeout)) {
            console.log(`[${contato}] Ignorando mensagens durante timeout (merreca/posMerreca)`);
            estado.mensagensPendentes = [];
            return;
        }
        console.log(`[${contato}] etapa=${estado.etapa} acessoMsgsDisparadas=${estado.acessoMsgsDisparadas} credEnt=${estado.credenciaisEntregues} confirmIni=${estado.confirmacaoMsgInicialEnviada}`);
        const mensagensPacote = Array.isArray(estado.mensagensPendentes)
            ? estado.mensagensPendentes.splice(0)
            : [];
        console.log(`[${contato}] Before splice: mensagensPendentes.length = ${estado.mensagensPendentes.length}`);
        const { rows: dncRows } = await pool.query(
            'SELECT do_not_contact FROM contatos WHERE id = $1 LIMIT 1',
            [contato]
        );
        const dnc = !!dncRows?.[0]?.do_not_contact;
        if (dnc) {
            const labels = await Promise.all(
                mensagensPacote.map(m => decidirOptLabel(m.texto || ''))
            );
            if (labels.some(l => l === 'REOPTIN')) {
                await setDoNotContact(contato, false);
                cancelarConfirmacaoOptOut(contato);
                if (typeof retomarEnvio === 'function') {
                    await delay(10000 + Math.floor(Math.random() * 5000));
                    await retomarEnvio(contato);
                }
                return;
            }
            console.log(`[${contato}] Ignorando processamento (do_not_contact=true).`);
            estado.mensagensPendentes = [];
            return;
        }
        const agora = Date.now();
        if (estado.etapa === 'encerrado' && estado.encerradoAte && agora < estado.encerradoAte) {
            console.log("[" + contato + "] Lead em timeout até " + new Date(estado.encerradoAte).toLocaleTimeString());
            return;
        }
        if (mensagensPacote.length === 0) {
            console.log("[" + contato + "] Nenhuma mensagem nova para processar");
            return;
        }
        if (await checarOptOutGlobal(contato, mensagensPacote.map(m => m.texto))) {
            await atualizarContato(contato, 'Sim', 'encerrado', '[OPTOUT]');
            return;
        }

        if (estado.etapa === 'abertura') {
            console.log("[" + contato + "] Processando etapa abertura");

            if (!estado.aberturaConcluida) {
                // ---------- MENSAGEM 1 (com dedupe) ----------
                const msg1Grupo1 = ['salve', 'opa', 'slv', 'e aí', 'eae', 'eai', 'fala', 'e ai', 'e ae', 'boa', 'boaa'];
                const msg1Grupo2 = [
                    'tô precisando de alguém pro trampo agora',
                    'preciso de alguém pra um trampo agora',
                    'tô precisando de alguém pra um trampo agora',
                    'preciso de alguém pro trampo agora',
                    'precisando de alguém pro trampo agora',
                    'precisando de alguém pra um trampo agora',
                    'to com vaga pra um trampo agora',
                    'tenho vaga pra um trampo agora',
                    'to com vaga pra um trampo',
                ];
                const msg1Grupo3 = [
                    'tá disponível?',
                    'tá disponível? 🍊',
                    'tá disponível? 🍊🍊',
                    'tá disponível? 🍊🍊🍊',

                    'vai poder fazer?',
                    'vai poder fazer? 🍊',
                    'vai poder fazer? 🍊🍊',
                    'vai poder fazer? 🍊🍊🍊',

                    'bora fazer?',
                    'bora fazer? 🍊',
                    'bora fazer? 🍊🍊',
                    'bora fazer? 🍊🍊🍊',

                    'consegue fazer?',
                    'consegue fazer? 🍊',
                    'consegue fazer? 🍊🍊',
                    'consegue fazer? 🍊🍊🍊',

                    'vamos fazer?',
                    'vamos fazer? 🍊',
                    'vamos fazer? 🍊🍊',
                    'vamos fazer? 🍊🍊🍊',

                    'vai fazer?',
                    'vai fazer? 🍊',
                    'vai fazer? 🍊🍊',
                    'vai fazer? 🍊🍊🍊',

                    'vai poder?',
                    'vai poder? 🍊',
                    'vai poder? 🍊🍊',
                    'vai poder? 🍊🍊🍊',

                    'consegue?',
                    'consegue? 🍊',
                    'consegue? 🍊🍊',
                    'consegue? 🍊🍊🍊',

                    'bora?',
                    'bora? 🍊',
                    'bora? 🍊🍊',
                    'bora? 🍊🍊🍊'
                ];

                const m1 = msg1Grupo1[Math.floor(Math.random() * msg1Grupo1.length)];
                const m2 = msg1Grupo2[Math.floor(Math.random() * msg1Grupo2.length)];
                const m3 = msg1Grupo3[Math.floor(Math.random() * msg1Grupo3.length)];
                let msg1 = `${m1}, ${m2}, ${m3}`;

                try {
                    const settings = await getBotSettings().catch(() => null);
                    const identEnabled = settings?.identity_enabled !== false;
                    let label = (settings?.identity_label || '').trim();
                    if (!label) {
                        const pieces = [];
                        if (settings?.support_email) pieces.push(settings.support_email);
                        if (settings?.support_phone) pieces.push(settings.support_phone);
                        if (settings?.support_url) pieces.push(settings.support_url);
                        if (pieces.length) label = `Suporte • ${pieces.join(' | ')}`;
                    }
                    if (identEnabled && label) msg1 = `${label} — ${msg1}`;
                    const optHintEnabled = settings?.optout_hint_enabled !== false;
                    const suffix = (settings?.optout_suffix || '· se não quiser: NÃO QUERO').trim();
                    if (optHintEnabled && suffix && !msg1.includes(suffix)) msg1 = `${msg1} ${suffix}`;
                } catch (e) {
                    console.error('[Abertura][inline selo/optout] erro:', e.message);
                }

                const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                const msg2Grupo1 = [
                    'nem liga pro nome desse whats,',
                    'nem liga pro nome desse WhatsApp,',
                    'nem liga pro nome desse whatsapp,',
                    'nem liga pro nome desse whats aq,',
                    'nem liga pro nome desse WhatsApp aq,',
                    'nem liga pro nome desse whatsapp aq,',
                    'nem liga pro nome desse whats aqui,',
                    'nem liga pro nome desse WhatsApp aqui,',
                    'nem liga pro nome desse whatsapp aqui,',
                    'nem liga pro nome desse whats, beleza?',
                    'nem liga pro nome desse WhatsApp, beleza?',
                    'nem liga pro nome desse whatsapp, beleza?',
                    'nem liga pro nome desse whats, blz?',
                    'nem liga pro nome desse WhatsApp, blz?',
                    'nem liga pro nome desse whatsapp, blz?',
                    'nem liga pro nome desse whats, tranquilo?',
                    'nem liga pro nome desse WhatsApp, tranquilo?',
                    'nem liga pro nome desse whatsapp, tranquilo?',
                    'nem liga pro nome desse whats, dmr?',
                    'nem liga pro nome desse WhatsApp, dmr?',
                    'nem liga pro nome desse whatsapp, dmr?',
                    'n liga pro nome desse whats,',
                    'n liga pro nome desse WhatsApp,',
                    'n liga pro nome desse whatsapp,',
                    'n liga pro nome desse whats aq,',
                    'n liga pro nome desse WhatsApp aq,',
                    'n liga pro nome desse whatsapp aq,',
                    'n liga pro nome desse whats aqui,',
                    'n liga pro nome desse WhatsApp aqui,',
                    'n liga pro nome desse whatsapp aqui,',
                    'n liga pro nome desse whats, beleza?',
                    'n liga pro nome desse WhatsApp, beleza?',
                    'n liga pro nome desse whatsapp, beleza?',
                    'n liga pro nome desse whats, blz?',
                    'n liga pro nome desse WhatsApp, blz?',
                    'n liga pro nome desse whatsapp, blz?',
                    'n liga pro nome desse whats, tranquilo?',
                    'n liga pro nome desse WhatsApp, tranquilo?',
                    'n liga pro nome desse whatsapp, tranquilo?',
                    'n liga pro nome desse whats, dmr?',
                    'n liga pro nome desse WhatsApp, dmr?',
                    'n liga pro nome desse whatsapp, dmr?',
                    'não liga pro nome desse whats,',
                    'não liga pro nome desse WhatsApp,',
                    'não liga pro nome desse whatsapp,',
                    'não liga pro nome desse whats aq,',
                    'não liga pro nome desse WhatsApp aq,',
                    'não liga pro nome desse whatsapp aq,',
                    'não liga pro nome desse whats aqui,',
                    'não liga pro nome desse WhatsApp aqui,',
                    'não liga pro nome desse whatsapp aqui,',
                    'não liga pro nome desse whats, beleza?',
                    'não liga pro nome desse WhatsApp, beleza?',
                    'não liga pro nome desse whatsapp, beleza?',
                    'não liga pro nome desse whats, blz?',
                    'não liga pro nome desse WhatsApp, blz?',
                    'não liga pro nome desse whatsapp, blz?',
                    'não liga pro nome desse whats, tranquilo?',
                    'não liga pro nome desse WhatsApp, tranquilo?',
                    'não liga pro nome desse whatsapp, tranquilo?',
                    'não liga pro nome desse whats, dmr?',
                    'não liga pro nome desse WhatsApp, dmr?',
                    'não liga pro nome desse whatsapp, dmr?',
                    'ignora o nome desse whats,',
                    'ignora o nome desse WhatsApp,',
                    'ignora o nome desse whatsapp,',
                    'ignora o nome desse whats aq,',
                    'ignora o nome desse WhatsApp aq,',
                    'ignora o nome desse whatsapp aq,',
                    'ignora o nome desse whats aqui,',
                    'ignora o nome desse WhatsApp aqui,',
                    'ignora o nome desse whatsapp aqui,',
                    'ignora o nome desse whats, beleza?',
                    'ignora o nome desse WhatsApp, beleza?',
                    'ignora o nome desse whatsapp, beleza?',
                    'ignora o nome desse whats, blz?',
                    'ignora o nome desse WhatsApp, blz?',
                    'ignora o nome desse whatsapp, blz?',
                    'ignora o nome desse whats, tranquilo?',
                    'ignora o nome desse WhatsApp, tranquilo?',
                    'ignora o nome desse whatsapp, tranquilo?',
                    'ignora o nome desse whats, dmr?',
                    'ignora o nome desse WhatsApp, dmr?',
                    'ignora o nome desse whatsapp, dmr?',
                    'só ignora o nome desse whats,',
                    'só ignora o nome desse WhatsApp,',
                    'só ignora o nome desse whatsapp,',
                    'só ignora o nome desse whats aq,',
                    'só ignora o nome desse WhatsApp aq,',
                    'só ignora o nome desse whatsapp aq,',
                    'só ignora o nome desse whats aqui,',
                    'só ignora o nome desse WhatsApp aqui,',
                    'só ignora o nome desse whatsapp aqui,',
                    'só ignora o nome desse whats, beleza?',
                    'só ignora o nome desse WhatsApp, beleza?',
                    'só ignora o nome desse whatsapp, beleza?',
                    'só ignora o nome desse whats, blz?',
                    'só ignora o nome desse WhatsApp, blz?',
                    'só ignora o nome desse whatsapp, blz?',
                    'só ignora o nome desse whats, tranquilo?',
                    'só ignora o nome desse WhatsApp, tranquilo?',
                    'só ignora o nome desse whatsapp, tranquilo?',
                    'só ignora o nome desse whats, dmr?',
                    'só ignora o nome desse WhatsApp, dmr?',
                    'só ignora o nome desse whatsapp, dmr?'
                ];
                const msg2Grupo2 = [
                    'número empresarial q usamos pros trampo',
                    'número empresarial que usamos pros trampo',
                    'número comercial q usamos pros trampo',
                    'número comercial que usamos pros trampo',
                    'número business q usamos pros trampo',
                    'número business que usamos pros trampo',
                    'número empresarial q usamos pra trampos',
                    'número empresarial que usamos pra trampos',
                    'número comercial q usamos pra trampos',
                    'número comercial que usamos pra trampos',
                    'número business q usamos pra trampos',
                    'número business que usamos pra trampos',
                    'número empresarial q usamos pra um trampo',
                    'número empresarial que usamos pra um trampo',
                    'número comercial q usamos pra um trampo',
                    'número comercial que usamos pra um trampo',
                    'número business q usamos pra um trampo',
                    'número business que usamos pra um trampo',
                    'número empresarial q usamos pro trampo',
                    'número empresarial que usamos pro trampo',
                    'número comercial q usamos pro trampo',
                    'número comercial que usamos pro trampo',
                    'número business q usamos pro trampo',
                    'número business que usamos pro trampo',
                    'é número empresarial q usamos pros trampo',
                    'é número empresarial que usamos pros trampo',
                    'é número comercial q usamos pros trampo',
                    'é número comercial que usamos pros trampo',
                    'é número business q usamos pros trampo',
                    'é número business que usamos pros trampo',
                    'é número empresarial q usamos pra trampos',
                    'é número empresarial que usamos pra trampos',
                    'é número comercial q usamos pra trampos',
                    'é número comercial que usamos pra trampos',
                    'é número business q usamos pra trampos',
                    'é número business que usamos pra trampos',
                    'é número empresarial q usamos pra um trampo',
                    'é número empresarial que usamos pra um trampo',
                    'é número comercial q usamos pra um trampo',
                    'é número comercial que usamos pra um trampo',
                    'é número business q usamos pra um trampo',
                    'é número business que usamos pra um trampo',
                    'é número empresarial q usamos pro trampo',
                    'é número empresarial que usamos pro trampo',
                    'é número comercial q usamos pro trampo',
                    'é número comercial que usamos pro trampo',
                    'é número business q usamos pro trampo',
                    'é número business que usamos pro trampo',
                ];
                const msg2Grupo3 = [
                    'pode salvar como "Ryan"',
                    'pode salvar como "Ryan" mesmo',
                    'pode salvar como Ryan',
                    'pode salvar como Ryan mesmo',
                    'pode salvar com o nome Ryan',
                    'pode salvar com o nome "Ryan"',
                    'pode salvar com o nome "Ryan" mesmo',
                    'pode salvar com o nome Ryan mesmo',
                    'pode salvar esse número como "Ryan"',
                    'pode salvar esse número como Ryan',
                    'pode salvar esse número com o nome Ryan',
                    'pode salvar esse número com o nome "Ryan"',
                    'pode salvar esse número com o nome "Ryan" mesmo',
                    'pode salvar esse número como "Ryan" mesmo',
                    'salva como "Ryan"',
                    'salva como Ryan',
                    'salva com o nome Ryan',
                    'salva com o nome "Ryan"',
                    'salva com o nome "Ryan" mesmo',
                    'salva com o nome Ryan mesmo',
                    'salva esse número como "Ryan"',
                    'salva esse número como Ryan',
                    'salva esse número com o nome Ryan',
                    'salva esse número com o nome "Ryan"',
                    'salva esse número com o nome "Ryan" mesmo',
                    'salva esse número como "Ryan" mesmo',
                ];

                const msg2 = () => `${pick(msg2Grupo1)} ${pick(msg2Grupo2)}, ${pick(msg2Grupo3)}`;

                if (!estado.aberturaSequenciada) {
                    estado.aberturaSequenciada = true;
                    try {
                        if (!estado.msg1Enviada) {
                            estado.msg1Enviada = true;
                            await sendMessage(contato, msg1);
                            estado.historico.push({ role: 'assistant', content: msg1 });
                            await atualizarContato(contato, 'Sim', 'abertura', msg1);
                            console.log(`[${contato}] Mensagem inicial enviada: ${msg1}`);
                        }
                        if (!estado.msg2Enviada) {
                            await delay(7000 + Math.floor(Math.random() * 6000));
                            const m2 = msg2();
                            await sendMessage(contato, m2, { bypassBlock: false });
                            estado.historico.push({ role: 'assistant', content: m2 });
                            await atualizarContato(contato, 'Sim', 'abertura', m2);
                            console.log(`[${contato}] Segunda mensagem enviada: ${m2}`);
                            estado.msg2Enviada = true;
                        }
                        estado.aberturaConcluida = true;
                    } finally {
                        estado.aberturaSequenciada = false;
                    }
                }

                return;
            }
            if (mensagensPacote.length > 0 && estado.etapa === 'abertura') {
                estado.etapa = 'interesse';
                estado.primeiraRespostaPendente = false;
                await atualizarContato(contato, 'Sim', 'interesse', '[Avanço automático após abertura]');
                console.log(`[${contato}] Avanço automático para 'interesse'`);
            }
        }

        if (estado.etapa === 'interesse') {
            console.log("[" + contato + "] Etapa 'interesse'");

            if (estado.interesseSequenciada) {
                console.log(`[${contato}] Interesse: já enviando, pulando.`);
                return;
            }

            if (!estado.interesseEnviado) {
                estado.interesseSequenciada = true;
                try {
                    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                    await delay(7000 + Math.floor(Math.random() * 6000));
                    const g1 = [
                        'to bem corrido aqui',
                        'tô na correria aqui',
                        'tô na correria agora',
                        'tô bem corrido agora',
                        'to sem muito tempo aqui',
                        'tô sem muito tempo aqui',
                        'tô sem muito tempo agora',
                        'to sem tempo aqui',
                        'tô sem tempo aqui',
                        'tô sem tempo agora',
                        'to na maior correria aqui',
                        'tô na maior correria aqui',
                        'tô na maior correria agora',
                        'to na maior correria agora',
                        'to meio sem tempo aqui',
                        'tô meio sem tempo aqui',
                        'tô meio sem tempo agora',
                        'to meio corrido aqui'
                    ];
                    const g2 = [
                        'fazendo vários ao mesmo tempo',
                        'fazendo vários trampos ao mesmo tempo',
                        'fazendo vários trampo ao mesmo tempo',
                        'fazendo vários trampos juntos',
                        'fazendo vários trampo juntos',
                        'fazendo vários trampos',
                        'fazendo vários trampo',
                        'fazendo muitos trampos ao mesmo tempo',
                        'fazendo muitos trampo ao mesmo tempo',
                        'fazendo muitos trampos juntos',
                        'fazendo muitos trampo juntos',
                        'fazendo muitos trampos',
                        'fazendo muitos trampo',
                        'fazendo muito trampo',
                        'fazendo muito trampo ao mesmo tempo',
                        'fazendo muito trampo juntos',
                        'fazendo muito trampo agora'
                    ];
                    const g3 = [
                        'vou te mandando tudo o que você tem que fazer',
                        'vou te mandando tudo que você tem que fazer',
                        'vou te mandando tudo o que precisa fazer',
                        'vou te mandando tudo que precisa fazer',
                        'vou te mandando o que você tem que fazer',
                        'vou te mandando o que precisa fazer',
                        'vou te mandando o que você precisa fazer',
                        'vou te mandando o que você tem que fazer',
                        'vou ir te mandando tudo o que você tem que fazer',
                        'vou ir te mandando tudo que você tem que fazer',
                        'vou ir te mandando tudo o que precisa fazer',
                        'vou ir te mandando tudo que precisa fazer',
                        'vou ir te mandando o que você tem que fazer',
                        'vou ir te mandando o que precisa fazer',
                        'vou ir te mandando o que você precisa fazer',
                        'vou ir te mandando o que você tem que fazer',
                        'vou te falar tudo o que você tem que fazer',
                        'vou te falar tudo que você tem que fazer',
                        'vou te falar tudo o que precisa fazer',
                        'vou te falar tudo que precisa fazer',
                        'vou te falar o que você tem que fazer',
                    ];
                    const g4 = [
                        'e você só responde o que eu te perguntar',
                        'e você só responde o que eu perguntar',
                        'e você só responde o que eu te pedir',
                        'e você só responde o que eu pedir',
                        'e você só responde o que eu for perguntar',
                        'e você só responde o que eu for pedir',
                        'e você só responde o que eu te perguntar',
                        'e você responde só o que eu te perguntar',
                        'e você responde só o que eu perguntar',
                        'e você responde só o que eu te pedir',
                        'e você responde só o que eu pedir',
                        'e você responde só o que eu for perguntar',
                        'e você responde só o que eu for pedir',
                        'e você só fala o que eu te perguntar',
                        'e você só me fala o que eu perguntar',
                        'e você só fala o que eu te pedir',
                        'e você só me fala o que eu pedir',
                        'e você só fala o que eu for perguntar',
                        'e você só me fala o que eu for perguntar',
                        'e você só fala o que eu for pedir',
                        'e você só me fala o que eu for pedir',
                    ];
                    const g5 = [
                        'beleza?',
                        'blz?',
                        'tranquilo?',
                        'demoro?',
                        'dmr?',
                        'certo?',
                        'pode ser?',
                        'entendeu?',
                        'tlgd?',
                    ];

                    estado.interesseEnviado = true;
                    const msgInteresse = `${pick(g1)}, ${pick(g2)}... ${pick(g3)}, ${pick(g4)}, ${pick(g5)}`;
                    const sent = await sendOnce(contato, estado, 'interesse.msg', msgInteresse);
                    if (sent) await atualizarContato(contato, 'Sim', 'interesse', msgInteresse);

                    const pos = Array.isArray(estado.mensagensPendentes) ? estado.mensagensPendentes.splice(0) : [];
                    if (pos.length) {
                        const contexto = pos.map(m => m.texto).join("\n");
                        const cls = String(await gerarResposta(
                            [{ role: "system", content: promptClassificaAceite(contexto) }],
                            ["ACEITE", "RECUSA", "DUVIDA"]
                        )).toUpperCase();
                        if (cls === "ACEITE") {
                            estado.etapa = 'instruções';
                            estado.primeiraRespostaPendente = false;
                            estado.instrucoesEnviadas = false;
                            estado.instrucoesCompletas = true;
                            await atualizarContato(contato, 'Sim', 'instruções', '[Avanço automático após ACEITE]');
                            return;
                        }
                    }
                    return;
                } finally {
                    estado.interesseSequenciada = false;
                }
            }

            if (mensagensPacote.length > 0) {
                const contexto = mensagensPacote.map(m => m.texto).join("\n");
                const classificacao = String(await gerarResposta(
                    [{ role: "system", content: promptClassificaAceite(contexto) }],
                    ["ACEITE", "RECUSA", "DUVIDA"]
                )).toUpperCase();

                console.log(`[${contato}] Resposta em interesse: ${classificacao}`);

                if (classificacao.trim() === "ACEITE") {
                    estado.etapa = 'instruções';
                    estado.primeiraRespostaPendente = false;
                    estado.instrucoesEnviadas = false;
                    estado.instrucoesCompletas = false;
                    estado.instrucoesConcluida = false;
                    estado.instrMsg1Enviada = false;
                    estado.instrMsg2Enviada = false;
                    estado.instrMsg3Enviada = false;
                    await atualizarContato(contato, 'Sim', 'instruções', '[Avanço automático após ACEITE]');
                } else {
                    console.log(`[${contato}] Stand-by em 'interesse' (aguardando ACEITE).`);
                    return;
                }
            }
        }

        if (estado.etapa === 'instruções') {
            console.log("[" + contato + "] Etapa 3: instruções");

            if (!estado.instrucoesConcluida) {
                const pick = (arr) =>
                    Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

                const msg1Grupo1 = [
                    'salvou o contato',
                    'salvou o número',
                    'salvou esse número',
                    'salvou esse contato',
                    'já salvou o contato',
                    'já salvou o número',
                    'já salvou esse número',
                    'já salvou esse contato',
                    'já salvou meu contato',
                    'já salvou meu número',
                    'salvou meu contato',
                    'salvou meu número',
                    'salvou o contato aí',
                    'salvou o número aí',
                    'salvou esse número aí',
                    'salvou esse contato aí',
                    'já salvou o contato aí',
                    'já salvou o número aí',
                    'já salvou esse número aí',
                    'já salvou esse contato aí',
                ];
                const msg1Grupo2 = [
                    'salva ai que se aparecer outro trampo mais tarde eu te chamo tambem',
                    'salva aí que se aparecer outro trampo mais tarde eu te chamo também',
                    'salva porque se aparecer outro trampo mais tarde eu te chamo tambem',
                    'salva porque se aparecer outro trampo mais tarde eu te chamo também',
                    'salva pq se aparecer outro trampo mais tarde eu te chamo tambem',
                    'salva pq se aparecer outro trampo mais tarde eu te chamo também',
                    'salva ai que se aparecer outro trampo eu te chamo tambem',
                    'salva aí que se aparecer outro trampo eu te chamo também',
                    'salva porque se aparecer outro trampo eu te chamo tambem',
                    'salva aí que se aparecer outro trampo eu te chamo tb',
                    'salva ai que se aparecer outro trampo eu te chamo tb',
                    'salva porque se aparecer outro trampo eu te chamo tb',
                    'salva pq se aparecer outro trampo eu te chamo tambem',
                    'salva pq se aparecer outro trampo eu te chamo também',
                    'salva pq se aparecer outro trampo eu te chamo tb',
                    'deixa salvo pq se aparecer outro trampo eu te chamo tambem',
                    'deixa salvo pq se aparecer outro trampo eu te chamo também',
                    'deixa salvo que se aparecer outro trampo eu te chamo tambem',
                    'deixa salvo que se aparecer outro trampo eu te chamo também',
                    'deixa salvo pq se aparecer outro trampo mais tarde eu te chamo tambem',
                    'deixa salvo pq se aparecer outro trampo mais tarde eu te chamo também',
                    'deixa salvo que se aparecer outro trampo mais tarde eu te chamo tambem',
                    'deixa salvo que se aparecer outro trampo mais tarde eu te chamo também',
                ];
                const msg1Grupo3 = [
                    'vou te mandar o passo a passo do que precisa pra fazer certinho',
                    'vou te mandar o passo a passo do que precisa pra fazer direitinho',
                    'vou te mandar o passo a passo do que precisa fazer certinho',
                    'vou te mandar o passo a passo do que precisa fazer direitinho',
                    'vou te mandar o passo a passo do que você precisa pra fazer certinho',
                    'vou te mandar o passo a passo do que você precisa pra fazer direitinho',
                    'vou te mandar o passo a passo do que você precisa fazer certinho',
                    'vou mandar o passo a passo do que você precisa fazer direitinho',
                    'vou mandar o passo a passo do que precisa pra fazer certinho',
                    'vou mandar o passo a passo do que precisa pra fazer direitinho',
                    'vou mandar o passo a passo do que precisa fazer certinho',
                    'vou mandar o passo a passo do que precisa fazer direitinho',
                    'agr vou mandar o passo a passo do que precisa pra fazer certinho',
                    'agora vou mandar o passo a passo do que precisa pra fazer certinho',
                    'agr vou mandar o passo a passo do que precisa pra fazer direitinho',
                    'agora vou mandar o passo a passo do que precisa pra fazer direitinho',
                    'vou mandar agora o passo a passo do que precisa pra fazer certinho',
                    'vou mandar agora o passo a passo do que precisa pra fazer direitinho',
                    'agr vou mandar o passo a passo do que precisa fazer certinho',
                    'agora vou mandar o passo a passo do que precisa fazer certinho',
                    'agora vou te mandar o passo a passo do que precisa fazer direitinho',
                    'agr vou mandar o passo a passo do que precisa fazer direitinho',
                    'agr vou te mandar o passo a passo do que precisa fazer direitinho',
                ];
                const instrMsg1 = `${pick(msg1Grupo1)}? ${pick(msg1Grupo2)}… ${pick(msg1Grupo3)}:`;

                const pontos1Grupo1 = [
                    'você precisa de uma conta com pix ativo pra receber',
                    'você precisa ter uma conta com pix ativo pra receber',
                    'vc precisa de uma conta com pix ativo pra receber',
                    'vc precisa ter uma conta com pix ativo pra receber',
                    'você vai precisar de uma conta com pix ativo pra receber',
                    'você precisa de uma conta com pix pra receber',
                    'você precisa ter uma conta com pix pra receber',
                    'vc precisa de uma conta com pix pra receber',
                    'vc precisa ter uma conta com pix pra receber',
                    'você vai precisar de uma conta com pix pra receber',
                    'você precisa de uma conta bancária com pix ativo pra receber',
                    'você precisa ter uma conta bancária com pix ativo pra receber',
                    'vc precisa de uma conta bancária com pix ativo pra receber',
                    'vc precisa ter uma conta bancária com pix ativo pra receber',
                    'você vai precisar de uma conta bancária com pix ativo pra receber',
                    'você precisa de uma conta bancária com pix pra receber',
                    'você precisa ter uma conta bancária com pix pra receber',
                    'vc precisa de uma conta bancária com pix pra receber',
                    'vc precisa ter uma conta bancária com pix pra receber',
                    'você vai precisar de uma conta bancária com pix pra receber',
                ];
                const pontos1Grupo2 = [
                    'pode ser qualquer banco',
                    'pode ser qlqr banco',
                    'qualquer banco serve',
                    'qualquer banco',
                    'qlqr banco serve',
                ];
                const pontos1Grupo3 = [
                    'so nao da certo se for o SICOOB',
                    'só não dá certo se for o SICOOB',
                    'só não funciona se for o SICOOB',
                    'so nao funciona se for o SICOOB',
                    'só não dá se for o SICOOB',
                    'so nao da certo se for SICOOB',
                    'só não dá certo se for SICOOB',
                    'só não funciona se for SICOOB',
                    'so nao funciona se for SICOOB',
                    'só não dá se for SICOOB',
                    'so nao da certo se for o WISE',
                    'só não dá certo se for o WISE',
                    'só não funciona se for o WISE',
                    'so nao funciona se for o WISE',
                    'só não dá se for o WISE',
                    'so nao da certo se for WISE',
                    'só não dá certo se for WISE',
                    'só não funciona se for WISE',
                    'so nao funciona se for WISE',
                    'só não dá se for WISE',
                ];

                const pontos2Grupo1 = [
                    'se tiver dados moveis',
                    'se tiver dados móveis',
                    'se tiver 5g',
                    'se tiver 4g',
                    'se tiver dados',
                    'se tiver internet no chip',
                    'se vc tiver dados moveis',
                    'se vc tiver dados móveis',
                    'se vc tiver 5g',
                    'se vc tiver 4g',
                    'se vc tiver dados',
                    'se vc tiver internet no chip',
                    'se você tiver dados moveis',
                    'se você tiver dados móveis',
                    'se você tiver 5g',
                    'se você tiver 4g',
                    'se você tiver dados',
                    'se você tiver internet no chip',
                ];
                const pontos2Grupo2 = [
                    'desativa o wi-fi',
                    'desliga o wi-fi',
                    'desativa o wifi',
                    'desliga o wifi',
                    'tira do wi-fi',
                    'tira do wifi',
                    'deixa desligado o wi-fi',
                    'deixa desligado o wifi',
                    'deixa desativado o wi-fi',
                    'deixa desativado o wifi',
                    'deixa o wi-fi desligado',
                    'deixa o wifi desligado',
                ];
                const pontos2Grupo3 = [
                    'mas se nao tiver deixa no wifi mesmo',
                    'mas se não tiver deixa no wifi mesmo',
                    'mas se nao tiver deixa no wi-fi mesmo',
                    'mas se não tiver deixa no wi-fi mesmo',
                    'mas se nao tiver deixa no wifi',
                    'mas se não tiver deixa no wifi',
                    'mas se nao tiver deixa no wi-fi',
                    'mas se não tiver deixa no wi-fi',
                    'mas se não tiver pode deixar no wifi mesmo',
                    'mas se não tiver pode deixar no wi-fi mesmo',
                    'mas se nao tiver pode deixar no wifi mesmo',
                    'mas se nao tiver pode deixar no wi-fi mesmo',
                    'mas se não tiver usa o wifi mesmo',
                    'mas se não tiver usa o wi-fi mesmo',
                    'mas se nao tiver usa o wifi mesmo',
                    'mas se nao tiver usa o wi-fi mesmo',
                    'mas se não tiver pode deixar no wifi',
                    'mas se não tiver pode deixar no wi-fi',
                    'mas se nao tiver pode deixar no wifi',
                    'mas se nao tiver pode deixar no wi-fi',
                ];

                const pontos3Grupo1 = [
                    'vou passar o email e a senha de uma conta pra você acessar',
                    'vou passar o e-mail e a senha de uma conta pra você acessar',
                    'vou passar o email e a senha de uma conta pra vc acessar',
                    'vou passar o e-mail e a senha de uma conta pra vc acessar',
                    'vou te passar o email e a senha de uma conta pra você acessar',
                    'vou te passar o e-mail e a senha de uma conta pra você acessar',
                    'vou te passar o email e a senha de uma conta pra vc acessar',
                    'vou te passar o e-mail e a senha de uma conta pra vc acessar',
                    'vou passar o email e a senha de uma conta pra você entrar',
                    'vou passar o e-mail e a senha de uma conta pra você entrar',
                    'vou passar o email e a senha de uma conta pra vc entrar',
                    'vou passar o e-mail e a senha de uma conta pra vc entrar',
                    'vou te passar o email e a senha de uma conta pra você entrar',
                    'vou te passar o e-mail e a senha de uma conta pra você entrar',
                ];
                const pontos3Grupo2 = [
                    'lá vai ter um saldo disponível',
                    'lá vai ter um saldo disponivel',
                    'vai ter um saldo disponível lá',
                    'vai ter um saldo disponivel lá',
                    'lá vai ter um dinheiro disponível',
                    'lá vai ter um dinheiro disponivel',
                    'vai ter um dinheiro disponível lá',
                    'vai ter um dinheiro disponivel lá',
                    'lá vai ter uma grana disponível',
                    'lá vai ter uma grana disponivel',
                    'vai ter uma grana disponível lá',
                    'vai ter uma grana disponivel lá',
                    'vai ter um dinheiro disponível pra saque lá',
                    'vai ter um dinheiro disponivel pra saque lá',
                    'lá vai ter um dinheiro disponível pra saque',
                    'lá vai ter um dinheiro disponivel pra saque',
                    'vai ter um saldo disponível pra saque lá',
                    'vai ter um saldo disponivel pra saque lá',
                    'lá vai ter um saldo disponível pra saque',
                    'lá vai ter um saldo disponivel pra saque',
                ];
                const pontos3Grupo3 = [
                    'é só você transferir pra sua conta, mais nada',
                    'é só vc transferir pra sua conta, mais nada',
                    'é só você transferir pra sua conta bancária, mais nada',
                    'é só vc transferir pra sua conta bancária, mais nada',
                    'é só você sacar pra sua conta, mais nada',
                    'é só vc sacar pra sua conta, mais nada',
                    'é só você sacar pra sua conta bancária, mais nada',
                    'é só vc sacar pra sua conta bancária, mais nada',
                    'você só precisa transferir pra sua conta, mais nada',
                    'vc só precisa transferir pra sua conta, mais nada',
                    'é só vc mandar pra sua conta, mais nada',
                    'é só você mandar pra sua conta, e já era',
                    'você só precisa transferir pra sua conta bancária, e já era',
                    'vc só precisa transferir pra sua conta bancária, e já era',
                    'é só vc mandar pra sua conta bancária, e já era',
                    'é só você mandar pra sua conta bancária, e já era',
                    'você só precisa sacar pra sua conta, e já era',
                    'vc só precisa sacar pra sua conta, e já era',
                    'você só precisa sacar pra sua conta bancária, e já era',
                    'vc só precisa sacar pra sua conta bancária, e já era',
                ];

                const pontos4Grupo1 = [
                    'sua parte vai ser 2000',
                    'você vai receber 2000',
                    'sua parte é 2000',
                    'você recebe 2000',
                    'sua parte vai ser 2 mil',
                    'sua parte vai ser 2000',
                    'você vai receber 2 mil',
                    'sua parte é 2 mil',
                    'você recebe 2 mil',
                    'sua parte vai ser dois mil',
                    'você vai receber dois mil',
                    'sua parte é dois mil',
                    'você recebe dois mil',
                    'vc vai receber 2000 pelo trampo',
                    'vc vai receber 2 mil pelo trampo',
                    'vc vai receber dois mil pelo trampo',
                    'sua parte vai ser 2000 pelo trampo',
                    'sua parte vai ser 2 mil pelo trampo',
                    'sua parte vai ser dois mil pelo trampo',
                    'você vai receber 2000 pelo trampo',
                    'você vai receber 2000 nesse trampo',
                    'você vai receber 2 mil pelo trampo',
                    'você vai receber 2 mil nesse trampo',
                    'você vai receber dois mil pelo trampo',
                    'você vai receber dois mil nesse trampo',
                ];
                const pontos4Grupo2 = [
                    'o restante manda pra minha conta logo que cair',
                    'o restante você manda pra minha conta logo que cair',
                    'o restante vc manda pra minha conta logo que cair',
                    'o restante manda pra minha conta assim que cair',
                    'o restante você manda pra minha conta assim que cair',
                    'o restante vc manda pra minha conta assim que cair',
                    'o restante manda pra minha conta quando cair',
                    'o restante você manda pra minha conta quando cair',
                    'o restante vc manda pra minha conta quando cair',
                    'o resto você manda pra minha conta logo que cair',
                    'o resto vc manda pra minha conta logo que cair',
                    'o resto você manda pra minha conta assim que cair',
                    'o resto vc manda pra minha conta assim que cair',
                    'o resto você manda pra minha conta quando cair',
                    'o resto vc manda pra minha conta quando cair',
                    'o resto manda pra minha conta logo que cair',
                    'o que sobrar você manda pra minha conta logo que cair',
                    'o que sobrar vc manda pra minha conta logo que cair',
                    'o que sobrar você manda pra minha conta assim que cair',
                    'o que sobrar vc manda pra minha conta assim que cair',
                    'o que sobrar você manda pra minha conta quando cair',
                    'o que sobrar vc manda pra minha conta quando cair',
                ];
                const pontos4Grupo3 = [
                    'eu vou te passar a chave pix depois',
                    'depois eu te passo a chave pix',
                    'a chave pix eu te passo depois',
                    'eu te passo a chave pix depois',
                    'depois eu passo a chave pix',
                    'a chave pix eu passo depois',
                    'depois eu te passo a chave pix',
                    'depois eu passo a chave pix',
                    'eu vou te passar a chave pix mais tarde',
                    'mais tarde eu te passo a chave pix',
                    'a chave pix eu te passo mais tarde',
                    'eu te passo a chave pix mais tarde',
                    'mais tarde eu passo a chave pix',
                    'a chave pix eu passo mais tarde',
                    'mais tarde eu te passo a chave pix',
                    'mais tarde eu passo a chave pix',
                ];

                const instrMsg2 =
                    `• ${pick(pontos1Grupo1)}, ${pick(pontos1Grupo2)}, ${pick(pontos1Grupo3)}\n\n` +
                    `• ${pick(pontos2Grupo1)}, ${pick(pontos2Grupo2)}, ${pick(pontos2Grupo3)}\n\n` +
                    `• ${pick(pontos3Grupo1)}, ${pick(pontos3Grupo2)}, ${pick(pontos3Grupo3)}\n\n` +
                    `• ${pick(pontos4Grupo1)}, ${pick(pontos4Grupo2)}, ${pick(pontos4Grupo3)}`;

                const msg3Grupo1 = [
                    'é tranquilinho',
                    'é tranquilo',
                    'é bem tranquilo',
                    'é muito tranquilo',
                    'é mt tranquilo',
                    'não tem segredo',
                    'nao tem segredo',
                    'é sem segredo',
                    'não tem erro',
                    'nao tem erro',
                    'é sem erro',
                    'é suave',
                    'é isso',
                    'é só isso',
                    'é só isso mesmo',
                    'é só isso aí',
                    'é só isso msm',
                    'é só isso msm',
                    'é só isso aí msm',
                ];
                const msg3Grupo2 = [
                    'a gente vai fazendo parte por parte pra nao ter erro blz',
                    'a gente vai fazendo parte por parte pra não ter erro blz',
                    'a gente vai fazendo parte por parte pra nao ter erro beleza',
                    'a gente vai fazendo parte por parte pra não ter erro beleza',
                    'a gente vai fazendo parte por parte pra nao ter erro, blz',
                    'a gente vai fazendo parte por parte pra não ter erro, blz',
                    'a gente vai fazendo parte por parte pra nao ter erro, beleza',
                    'a gente vai fazendo parte por parte pra não ter erro, beleza',
                    'a gente vai fazendo parte por parte pra nao ter erro, pode ser',
                    'a gente vai fazendo parte por parte pra não ter erro, pode ser',
                    'a gnt vai fazendo parte por parte pra nao ter erro blz',
                    'a gnt vai fazendo parte por parte pra não ter erro blz',
                    'a gnt vai fazendo parte por parte pra nao ter erro beleza',
                    'a gnt vai fazendo parte por parte pra não ter erro beleza',
                    'a gnt vai fazendo parte por parte pra nao ter erro, blz',
                    'a gnt vai fazendo parte por parte pra não ter erro, blz',
                    'a gnt vai fazendo parte por parte pra nao ter erro, beleza',
                    'a gnt vai fazendo parte por parte pra não ter erro, beleza',
                    'a gnt vai fazendo parte por parte pra nao ter erro, pode ser',
                    'a gnt vai fazendo parte por parte pra não ter erro, pode ser',
                    'a gente faz parte por parte pra nao ter erro blz',
                    'a gente faz parte por parte pra não ter erro blz',
                    'a gente faz parte por parte pra nao ter erro beleza',
                    'a gente faz parte por parte pra não ter erro beleza',
                    'a gente faz parte por parte pra nao ter erro, blz',
                    'a gente faz parte por parte pra não ter erro, blz',
                ];
                const instrMsg3 = `${pick(msg3Grupo1)}… ${pick(msg3Grupo2)}?`;

                if (!estado.instrucoesSequenciada) {
                    estado.instrucoesSequenciada = true;
                    try {
                        if (!estado.instrMsg1Enviada) {
                            estado.instrMsg1Enviada = true;
                            await delay(rand(15000, 25000));
                            await sendMessage(contato, instrMsg1);
                            estado.historico.push({ role: 'assistant', content: instrMsg1 });
                            await atualizarContato(contato, 'Sim', 'instruções', instrMsg1);
                            console.log(`[${contato}] [instruções] Msg1 enviada: ${instrMsg1}`);
                        }

                        if (!estado.instrMsg2Enviada) {
                            estado.instrMsg2Enviada = true;
                            await delay(rand(25000, 35000));
                            await sendMessage(contato, instrMsg2);
                            estado.historico.push({ role: 'assistant', content: instrMsg2 });
                            await atualizarContato(contato, 'Sim', 'instruções', instrMsg2);
                            console.log(`[${contato}] [instruções] Msg2 enviada (bullets únicos)`);
                        }

                        if (!estado.instrMsg3Enviada) {
                            estado.instrMsg3Enviada = true;
                            await delay(rand(8000, 12000));
                            await sendMessage(contato, instrMsg3);
                            estado.historico.push({ role: 'assistant', content: instrMsg3 });
                            await atualizarContato(contato, 'Sim', 'instruções', instrMsg3);
                            console.log(`[${contato}] [instruções] Msg3 enviada: ${instrMsg3}`);
                        }

                        estado.instrucoesConcluida = true;
                        estado.instrucoesEnviadas = true;
                        estado.aguardandoAceiteInstrucoes = true;
                    } catch (e) {
                        console.error(`[${contato}] Erro na sequência de instruções: ${e.message}`);
                    } finally {
                        estado.instrucoesSequenciada = false;
                    }
                }
                const pos = Array.isArray(estado.mensagensPendentes) ? estado.mensagensPendentes.splice(0) : [];
                if (pos.length) {
                    const contextoPos = pos.map(m => m.texto).join("\n");
                    const clsPos = String(await gerarResposta(
                        [{ role: "system", content: promptClassificaAceite(contextoPos) }],
                        ["ACEITE", "RECUSA", "DUVIDA"]
                    )).toUpperCase();
                    if (clsPos.includes("ACEITE")) {
                        estado.etapa = 'acesso';
                        estado.tentativasAcesso = 0;
                        estado.mensagensDesdeSolicitacao = [];
                        await atualizarContato(contato, 'Sim', 'acesso', '[ACEITE após instruções (imediato)]');
                        return;
                    }
                }
                return;
            }

            if (mensagensPacote.length > 0) {
                const contexto = mensagensPacote.map(m => m.texto).join("\n");
                const cls = String(await gerarResposta(
                    [{ role: "system", content: promptClassificaAceite(contexto) }],
                    ["ACEITE", "RECUSA", "DUVIDA"]
                )).toUpperCase();

                console.log(`[${contato}] Classificação pós-instruções: ${cls}`);

                if (cls.includes("ACEITE")) {
                    estado.etapa = 'acesso';
                    estado.tentativasAcesso = 0;
                    estado.mensagensDesdeSolicitacao = [];
                    estado.acessoMsgsDisparadas = false;
                    estado.acessoMsg1Enviada = false;
                    estado.acessoMsg2Enviada = false;
                    estado.acessoMsg3Enviada = false;
                    await atualizarContato(contato, 'Sim', 'acesso', '[ACEITE após instruções]');
                }
                console.log(`[${contato}] Stand-by em 'instruções' (aguardando ACEITE).`);
                return;
            }

            return;
        }

        // ===================== ETAPA: ACESSO (reformulada + variações) =====================
        if (estado.etapa === 'acesso') {
            console.log("[" + contato + "] Etapa 4: acesso (reformulada)");

            function isLoginConfirm(s) {
                const n = norm(s);
                if (!n) return false;

                const hits = [
                    /\bentrei\b/,
                    /\bentrou\b/,
                    /\bconsegui\b/,
                    /\bconsegui\s+entrar\b/,
                    /\blogou\b/,
                    /\bloguei\b/,
                    /\bfoi\b/,
                    /\bfoi\s+aq(ui)?\b/,
                    /\bdeu\s+certo\b/,
                    /\bdeu\s+bom\b/,
                    /\bqual\s+a?\s*senha\b/,      // "qual a senha" | "qual senha"
                    /\bt[aá]\s+pedindo\s+senha\b/ // "tá pedindo senha" | "ta pedindo senha"
                ];

                return hits.some(rx => rx.test(n));
            }

            // 1) Garantir credenciais
            if (
                !estado.credenciais ||
                !estado.credenciais.username ||
                !estado.credenciais.password ||
                !estado.credenciais.link
            ) {

                try {
                    await criarUsuarioDjango(contato);
                } catch (e) {
                    console.error(`[${contato}] criarUsuarioDjango falhou: ${e?.message || e}`);
                }
            }

            const cred = estado.credenciais;
            if (!cred || !cred.username || !cred.password || !cred.link) {
                console.log(`[${contato}] Sem credenciais válidas após tentativa; standby em 'acesso'.`);
                return;
            }

            const email = cred.username;
            const senha = cred.password;
            const link = cred.link;

            // 2) Mensagens da etapa
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

            const bloco1A = [
                'vou mandar o e-mail e a senha da conta',
                'vou mandar o email e a senha da conta',
                'te mandar o e-mail e a senha da conta',
                'te mandar o email e a senha da conta',
                'esse é o e-mail e a senha da conta',
                'esse é o email e a senha da conta',
                'e-mail e a senha da conta',
                'email e a senha da conta',
            ];
            const bloco2A = [
                'só copia e cola pra não errar',
                'só copia e cola pra não colocar errado',
                'copia e cola pra não errar',
                'copia e cola pra não colocar errado',
                'só copia aqui e cola lá pra não errar',
                'só copia aqui e cola lá pra não colocar errado',
                'copia aqui e cola lá pra não errar',
                'copia aqui e cola lá pra não colocar errado',
            ];
            const bloco3A = ['E-mail', 'Email'];

            const bloco1C = [
                'entra nesse link', 'entra por esse link', 'esse é o link', 'o link é esse',
                'o link é esse aqui', 'segue o link', 'entra no link', 'clica no link',
                'aperta no link', 'só clicar no link'
            ];
            const bloco2C = [
                'entra na conta mas nao mexe em nada ainda',
                'entra na conta mas nao clica em nada ainda',
                'entra na conta mas nao aperta em nada ainda',
                'entra aí na conta mas nao mexe em nada ainda',
                'entra aí na conta mas nao clica em nada ainda',
                'entra aí na conta mas nao aperta em nada ainda',
                'entra aí mas nao mexe em nada ainda',
                'entra aí mas nao clica em nada ainda',
                'entra aí mas nao aperta em nada ainda',
                'entra aí na conta mas não muda nada ainda'
            ];
            const bloco3C = [
                'assim que conseguir acessar me manda um "ENTREI"',
                'assim que acessar me manda um "ENTREI"',
                'assim que conseguir acessar a conta me manda um "ENTREI"',
                'assim que acessar a conta me manda um "ENTREI"',
                'assim que entrar na conta me manda um "ENTREI"',
                'assim que logar na conta me manda um "ENTREI"',
                'assim q conseguir acessar me manda um "ENTREI"',
                'assim q acessar me manda um "ENTREI"',
                'assim q conseguir acessar a conta me manda um "ENTREI"',
                'assim q acessar a conta me manda um "ENTREI"',
                'assim q entrar na conta me manda um "ENTREI"',
                'assim q logar na conta me manda um "ENTREI"',
            ];

            const msg1 = [
                `${pick(bloco1A)}, ${pick(bloco2A)}:`,
                '',
                `${pick(bloco3A)}:`,
                email,
                '',
                'Senha:'
            ].join('\n');

            const msg2 = String(senha);

            const msg3 = [
                `${pick(bloco1C)}:`,
                '',
                link,
                '',
                `${pick(bloco2C)}, ${pick(bloco3C)}`
            ].join('\n');

            // 3) Disparo único da sequência
            if (!estado.acessoMsgsDisparadas) {
                estado.acessoMsgsDisparadas = true;

                if (!estado.acessoMsg1Enviada) {
                    estado.acessoMsg1Enviada = true;
                    await sendOnce(contato, estado, 'acesso.m1', msg1);
                    await atualizarContato(contato, 'Sim', 'acesso', msg1);
                    await delay(rand(6000, 9000));
                }

                if (!estado.acessoMsg2Enviada) {
                    estado.acessoMsg2Enviada = true;
                    await sendOnce(contato, estado, 'acesso.m2', msg2);
                    await atualizarContato(contato, 'Sim', 'acesso', msg2);
                    await delay(rand(7000, 11000));
                }

                if (!estado.acessoMsg3Enviada) {
                    estado.acessoMsg3Enviada = true;
                    await sendOnce(contato, estado, 'acesso.m3', msg3);
                    await atualizarContato(contato, 'Sim', 'acesso', msg3);
                }

                estado.acessoDesdeTs = Date.now();
                estado.credenciaisEntregues = true;
                await atualizarContato(contato, 'Sim', 'acesso', '[Credenciais enviadas]');
                estado.mensagensPendentes = [];
                return;
            } else {
                console.log(`[${contato}] Acesso: sequência já disparada (acessoMsgsDisparadas=true), não reenviando.`);
            }

            // 4) Analisar respostas desde o envio
            const anyTs = mensagensPacote.some(m => tsEmMs(m) !== null);
            const recentes = (!estado.acessoDesdeTs || !anyTs)
                ? mensagensPacote
                : mensagensPacote.filter(m => {
                    const ts = tsEmMs(m);
                    return ts === null || ts >= estado.acessoDesdeTs;
                });

            const respostasTexto = recentes.map(m => m.texto || '').filter(Boolean);

            // (A) Regra determinística ampla (aceita variações)
            if (respostasTexto.some(isLoginConfirm)) {
                estado.etapa = 'confirmacao';
                estado.mensagensDesdeSolicitacao = [];
                estado.tentativasAcesso = 0;
                estado.confirmacaoMsgInicialEnviada = false;
                await atualizarContato(contato, 'Sim', 'confirmacao', '[Login confirmado — atalho]');
                console.log(`[${contato}] Etapa 5: confirmação — avançou pelo atalho`);
                return;
            }

            // (B) Classificação via LLM (fallback)
            if (!estado.credenciaisEntregues) {
                console.log(`[${contato}] Acesso: aguardando finalizar envio (credenciaisEntregues=false). Não vou classificar ainda.`);
                return;
            }
            const mensagensTexto = respostasTexto.join('\n').trim();
            if (!mensagensTexto) return;

            const classifyInput = promptClassificaAcesso(mensagensTexto);
            const tipoAcessoRaw = await gerarResposta(
                [{ role: 'system', content: classifyInput }],
                ["CONFIRMADO", "NAO_CONFIRMADO", "DUVIDA", "NEUTRO"]
            );
            const tipoAcesso = String(tipoAcessoRaw).toUpperCase();
            console.log(`[${contato}] acesso> LLM="${tipoAcesso}" novas=${recentes.length} texto="${mensagensTexto.slice(0, 120)}..."`);

            if (tipoAcesso === 'CONFIRMADO') {
                estado.etapa = 'confirmacao';
                estado.mensagensDesdeSolicitacao = [];
                estado.tentativasAcesso = 0;
                estado.confirmacaoMsgInicialEnviada = false;

                await atualizarContato(contato, 'Sim', 'confirmacao', '[Login confirmado — avançando]');
                console.log("[" + contato + "] Etapa 5: confirmação — avançou após CONFIRMADO");
                return;
            } else {
                console.log(`[${contato}] Acesso aguardando CONFIRMADO. Retorno: ${tipoAcesso}`);
                estado.mensagensPendentes = [];
                return;
            }
        }

        if (estado.etapa === 'confirmacao') {
            console.log("[" + contato + "] Etapa 5: confirmação");

            // ========= Helpers de MÍDIA & VALOR (compatível com novo routes.js) =========

            // URL típica de mídia (ManyChat S3, WhatsApp CDN, extensões de imagem/arquivo)
            const looksLikeMediaUrl = (s = '') => {
                const n = String(s || '');
                const matches = /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|cdn\.manychat\.com|lookaside\.fbsbx\.com|amazonaws\.com).*\/(original|file)_/i.test(n)
                    || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp|bmp|heic|heif|mp4|mov|m4v|avi|mkv|mp3|m4a|ogg|wav|opus|pdf|docx?|xlsx?|pptx?)(?:\?\S*)?$/i.test(n);
                console.log(`[${contato}] looksLikeMediaUrl("${n.slice(0, 100)}...") = ${matches}`);
                return matches;
            };

            // Extrai possíveis URLs de mídia dos campos enviados pelo routes.js
            const extractPossibleMediaUrls = (m = {}) => {
                const urls = new Set();
                const tryPush = v => { if (v && typeof v === 'string') urls.add(v); };

                // ► NOVO: o routes.js já agrega tudo em m.urls
                (Array.isArray(m.urls) ? m.urls : []).forEach(tryPush);

                // ► E ainda podemos varrer o texto por links (ex.: ManyChat manda o link no texto)
                if (m.texto && typeof m.texto === 'string') {
                    const rx = /(https?:\/\/\S+)/gi;
                    let mt;
                    while ((mt = rx.exec(m.texto)) !== null) tryPush(mt[1]);
                }

                console.log(`[${contato}] extractPossibleMediaUrls: ${Array.from(urls).map(u => u.slice(0, 100))}`);
                return Array.from(urls);
            };

            // Detector unificado de mídia (usa sinal do provedor + type + URLs)
            const isMediaMessage = (m = {}, contatoForLog = '-') => {
                const toBool = v => v === true || v === 1 || String(v).toLowerCase() === 'true';
                // ► Meta/Twilio mandam o sinal do próprio provedor; ManyChat vem false e detectamos por URL/type
                const flagProv = (toBool(m.temMidia) || toBool(m.hasMedia));

                const urls = extractPossibleMediaUrls(m);
                const urlPareceMidia = urls.some(looksLikeMediaUrl);

                // ManyChat/Meta/Twilio podem informar type: image|video|file|audio|document…
                const typeMidia = /image|photo|picture|video|document|file|audio|sticker/i.test(String(m.type || ''));

                const temMidia = !!(flagProv || urlPareceMidia || typeMidia);

                console.log(
                    `[${contatoForLog}] mediaCheck> prov=${!!flagProv} type=${m.type || '-'} urls=${urls.length} ` +
                    `urlPareceMidia=${urlPareceMidia} typeMidia=${typeMidia} => temMidia=${temMidia}`
                );

                if (!temMidia && (m.texto || urls.length)) {
                    console.log(`[${contatoForLog}] mediaCheck> texto="${String(m.texto || '').slice(0, 120)}" urls=${JSON.stringify(urls)}`);
                }
                return temMidia;
            };

            // Normaliza string p/ análise de valor
            const normalizeMoneyStr = (s = '') => s.toLowerCase().replace(/\s+/g, ' ').trim();

            // Converte token "numérico" em Number considerando pt-BR/en-US + mil/k
            const toNumberToken = (raw = '') => {
                let s = normalizeMoneyStr(raw);

                // 1) "2k", "2.5 mil"
                const k = s.match(/^(\d+(?:[.,]\d+)?)\s*k\b/);
                if (k) return parseFloat(k[1].replace(',', '.')) * 1000;

                // 2) "2 mil", "2,5 mil"
                const mil = s.match(/^(\d+(?:[.,]\d+)?)\s*mil\b/);
                if (mil) return parseFloat(mil[1].replace(',', '.')) * 1000;

                // 3) Formatos com R$ opcional e separadores
                s = s.replace(/^r\$\s*/i, '');

                if (/,/.test(s) && !/\./.test(s)) {
                    s = s.replace(/\./g, '').replace(',', '.');
                    return Number(s);
                } else if (/\./.test(s) && !/,/.test(s)) {
                    const last = s.split('.').pop() || '';
                    if (last.length === 3) {
                        s = s.replace(/\./g, '');
                        return Number(s);
                    } else {
                        return Number(s);
                    }
                } else if (/\./.test(s) && /,/.test(s)) {
                    s = s.replace(/\./g, '').replace(',', '.');
                    return Number(s);
                } else {
                    return Number(s);
                }
            };

            // Extrai o MAIOR valor plausível > 0 do texto (saldo costuma ser o maior)
            const extractValorFromText = (texto = '', contatoForLog = '-') => {
                const t = normalizeMoneyStr(texto);
                if (!t) return null;

                const tokens = [];

                // R$ …, números com separadores, decimais
                const rxMoney = /\b(?:r\$\s*)?(\d{1,3}(?:[.\s]\d{3})+|\d+(?:[.,]\d{1,2})?)(?=\b)/gi;
                let m;
                while ((m = rxMoney.exec(t)) !== null) tokens.push(m[0]);

                // "2k", "2,5 mil"
                const rxK = /\b\d+(?:[.,]\d+)?\s*k\b/gi;
                let k;
                while ((k = rxK.exec(t)) !== null) tokens.push(k[0]);

                // "2 mil", "2,5 mil"
                const rxMil = /\b\d+(?:[.,]\d+)?\s*mil\b/gi;
                let mi;
                while ((mi = rxMil.exec(t)) !== null) tokens.push(mi[0]);

                const converted = tokens
                    .map(tok => ({ tok, num: toNumberToken(tok) }))
                    .filter(x => Number.isFinite(x.num) && x.num > 0);

                console.log(`[${contatoForLog}] valorCheck> texto="${t.slice(0, 120)}" tokens=${JSON.stringify(tokens)} parsed=${JSON.stringify(converted)}`);

                if (!converted.length) return null;

                const maior = converted.reduce((a, b) => (b.num > a.num ? b : a));
                return maior.num;
            };

            // === 5.0) Disparo da mensagem inicial de confirmação ===
            if (!estado.confirmacaoMsgInicialEnviada) {
                if (estado.confirmacaoSequenciada) {
                    console.log(`[${contato}] Confirmação: já enviando, pulando.`);
                    return;
                }
                estado.confirmacaoSequenciada = true;

                try {
                    const pick = arr => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

                    const bloco1 = ['boa', 'boaa', 'boaaa', 'beleza', 'belezaa', 'belezaaa', 'tranquilo', 'isso aí'];
                    const bloco2 = [
                        'agora manda um PRINT mostrando o saldo disponível',
                        'agora manda um PRINT mostrando o saldo disponível aí',
                        'agora me manda um PRINT mostrando o saldo disponível nessa conta',
                        'agora me manda um PRINT mostrando o saldo',
                    ];
                    const bloco3 = [
                        'ou escreve aqui quanto que tem disponível',
                        'ou me escreve o valor',
                        'ou manda o valor em escrito',
                        'ou me fala o valor disponível',
                    ];

                    const msgConfirmacao = `${pick(bloco1)}, ${pick(bloco2)}, ${pick(bloco3)}`;

                    const sent = await sendOnce(contato, estado, 'confirmacao.m1', msgConfirmacao);

                    if (sent) {
                        estado.confirmacaoMsgInicialEnviada = true;
                        await atualizarContato(contato, 'Sim', 'confirmacao', msgConfirmacao);
                        estado.confirmacaoDesdeTs = Date.now();
                        estado.mensagensDesdeSolicitacao = [];
                        console.log(`[${contato}] confirmação.m1 enviada; aguardando retorno do lead.`);
                        return;
                    } else {
                        console.log(`[${contato}] confirmação.m1 já havia sido enviada (dedupe). Prosseguindo para análise do pacote.`);
                        estado.confirmacaoMsgInicialEnviada = true;
                        if (!estado.confirmacaoDesdeTs) estado.confirmacaoDesdeTs = Date.now();
                    }
                } catch (e) {
                    console.error(`[${contato}] ERRO ao enviar msg inicial de confirmação: ${e?.message || e}`);
                } finally {
                    estado.confirmacaoSequenciada = false;
                }
            }

            // === 5.1) Coleta o pacote desde o pedido ===
            let mensagensPacote = Array.isArray(estado.mensagensPendentes)
                ? estado.mensagensPendentes.splice(0)
                : [];

            console.log(`[${contato}] confirmacao> pacote apos splice: length=${mensagensPacote.length}`);

            // filtra por timestamp da solicitação de confirmação (se houver)
            if (estado.confirmacaoDesdeTs) {
                const anyTsX = mensagensPacote.some(m => tsEmMs(m) !== null);
                if (anyTsX) {
                    mensagensPacote = mensagensPacote.filter(m => {
                        const ts = tsEmMs(m);
                        const kept = ts === null || ts >= estado.confirmacaoDesdeTs;
                        console.log(`[${contato}] confirmacao> filter ts: msgTs=${ts} desdeTs=${estado.confirmacaoDesdeTs} kept=${kept}`);
                        return kept;
                    });
                }
                console.log(`[${contato}] confirmacao> pacote apos ts filter: length=${mensagensPacote.length}`);
            }

            if (!mensagensPacote.length) {
                console.log(`[${contato}] confirmacao> nenhum item no pacote (pendentes=${(estado.mensagensPendentes || []).length}).`);
                return;
            }

            // histórico legível (marca [mídia] quando detectado)
            estado.mensagensDesdeSolicitacao.push(
                ...mensagensPacote.map(m => (isMediaMessage(m, contato) ? '[mídia]' : (m.texto || '')))
            );

            console.log(`[${contato}] confirmacao> pacote`, mensagensPacote.map(m => ({
                temMidiaFlag: (m?.temMidia || m?.hasMedia) ? true : false,
                type: m?.type || '-',
                texto: (m?.texto || '').slice(0, 120),
                urlCount: (Array.isArray(m?.urls) ? m.urls.length : extractPossibleMediaUrls(m).length)
            })));

            // === 5.2) Regra determinística: MÍDIA OU VALOR numérico ===
            const temMidia = mensagensPacote.some(m => isMediaMessage(m, contato));

            let valorInformado = null;
            for (const m of mensagensPacote) {
                const v = extractValorFromText(m?.texto || '', contato);
                if (Number.isFinite(v) && v > 0) { valorInformado = v; break; }
            }

            console.log(`[${contato}] confirmacao> resumoDeterministico temMidia=${temMidia} valorInformado=${valorInformado}`);

            if (temMidia || valorInformado != null) {
                if (valorInformado != null) estado.saldo_informado = valorInformado;

                estado.etapa = 'saque';
                estado.saqueInstrucoesEnviadas = false;
                estado.mensagensDesdeSolicitacao = [];
                estado.mensagensPendentes = [];
                await atualizarContato(
                    contato,
                    'Sim',
                    'saque',
                    temMidia ? '[Confirmado por print]' : `[Confirmado por valor=${valorInformado}]`
                );
                console.log(`[${contato}] Confirmação OK -> SAQUE (midia=${temMidia}, valor=${valorInformado})`);
                return;
            }

            // === 5.3) Fallback LLM (opcional) ===
            const textoAgregado = [
                ...estado.mensagensDesdeSolicitacao,
                ...mensagensPacote.map(m => m.texto || '')
            ].join('\n');

            const okConf = String(await gerarResposta(
                [{ role: 'system', content: promptClassificaConfirmacao(textoAgregado) }],
                ['CONFIRMADO', 'NAO_CONFIRMADO', 'DUVIDA', 'NEUTRO']
            )).toUpperCase();

            console.log(`[${contato}] confirmacao> fallbackLLM resposta=${okConf}`);

            if (okConf === 'CONFIRMADO') {
                estado.etapa = 'saque';
                estado.saqueInstrucoesEnviadas = false;
                estado.mensagensDesdeSolicitacao = [];
                estado.mensagensPendentes = [];
                await atualizarContato(contato, 'Sim', 'saque', '[Confirmado — avançando]');
                console.log(`[${contato}] Confirmação OK via LLM -> SAQUE`);
                return;
            }

            // LOG de diagnóstico final (por que NÃO avançou)
            console.log(`[${contato}] confirmacao> NÃO avançou: temMidia=${temMidia} valorInformado=${valorInformado} fallback=${okConf}`);
            return;
        }

        else if (estado.etapa === 'saque') {
            console.log("[" + contato + "] Etapa 6: saque - Início do processamento");
            // 6.1) Dispara exatamente 3 MENSAGENS (com variações em blocos), uma única vez.
            if (!estado.saqueInstrucoesEnviadas) {
                // flags de dedupe/retomada (como nas outras etapas)
                estado.saqueMsg1Enviada = !!estado.saqueMsg1Enviada;
                estado.saqueMsg2Enviada = !!estado.saqueMsg2Enviada;
                estado.saqueMsg3Enviada = !!estado.saqueMsg3Enviada;
                const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                // ---------- MSG 1: "{b1}, {b2}, {b3}, {b4}… {b5}, {b6}" ----------
                const m1b1 = [
                    'essa aí tá recheada kkkk',
                    'essa conta aí tá recheada kkk',
                    'essa aí veio recheada kkkkk',
                    'essa conta tá recheada kkkkkk',
                    'essa aí veio logo premiada kk',
                    'essa conta aí tá premiada kkkkkk',
                    'essa aí tá forrada kkk',
                    'essa conta tá forrada kkkkk',
                    'essa aí veio forrada kkkkkk',
                    'essa conta aí veio forrada kk',
                    'essa aí veio logo forrada kkkk',
                    'essa aí tá pesada kkk',
                    'essa conta aí veio pesada kkkkk',
                    'essa aí tá transbordando kkkk',
                    'essa conta tá transbordando kk',
                    'essa aí veio carregada kkkk',
                    'essa conta tá carregada kkkkk',
                    'essa aí tá é premiada kk',
                    'essa conta aí tá premiada kkkkk',
                    'essa aí tá caprichada kkkk',
                    'essa conta veio caprichada kk',
                    'essa aí veio no luxo kkkk',
                    'essa conta tá luxo kk',
                    'essa aí tá bala kkkkk',
                    'essa conta veio bala kk',
                    'essa aí tá estralando kkkkkk',
                    'essa conta tá estralando kkk',
                    'essa aí tá estourada kk',
                    'essa conta veio estourada kkkkk',
                    'essa aí tá monstruosa kkkk',
                    'essa conta aí veio monstruosa kk',

                    'sua conta tá recheada kkk',
                    'sua conta aí tá forrada kkkkk',
                    'sua conta veio premiada kkkkk',
                    'sua conta tá pesada kk',
                    'sua conta tá transbordando kkkkk',
                    'sua conta veio carregada kkkk',
                    'sua conta tá caprichada kkk',
                    'sua conta tá luxo kkkkk',
                    'sua conta veio bala kk',
                    'sua conta tá estralando kkkk',
                    'sua conta tá estourada kk',
                    'sua conta veio monstruosa kkkkk',

                    'tua conta tá recheada kkkk',
                    'tua conta veio forrada kkkkk',
                    'tua conta tá premiada kk',
                    'tua conta tá bala kkk',
                    'tua conta tá transbordando kkkkkk',
                    'tua conta veio carregada kk',
                    'tua conta tá estralando kkk',
                    'tua conta tá estourada kkkkk',
                ];

                const m1b2 = [
                    'mas agora é o seguinte',
                    'agora é o seguinte',
                    'mas agora presta atenção',
                    'agora presta atenção',
                    'mas agora presta muita atenção',
                    'agora presta muita atenção',
                    'agora presta atenção aqui',
                    'se liga agora',
                    'agora se liga',
                    'mas se liga agora',
                    'mas agr é o seguinte',
                    'mas agr presta atenção',
                    'mas muita atenção agora',
                    'mas mta atenção agora',
                    'mas muita atenção agr',
                    'presta atenção agora',
                    'muita atenção agora',
                    'mta atenção agr',
                    'presta atenção agr',
                    'se liga agr',
                    'mas presta atenção agora',
                    'mas presta atenção aqui',
                    'atenção agora',
                    'atenção total agora',
                    'mas atenção total agora',
                    'mas se liga agr',
                    'presta muita atenção agora',
                ];

                const m1b3 = [
                    'vc só vai sacar 5 mil porque assim não dá errado',
                    'vc só vai sacar 5 mil porque assim não dá ruim',
                    'vc só vai sacar 5000 porque assim não dá errado',
                    'vc só vai sacar 5000 porque assim não dá ruim',
                    'vc só vai sacar cinco mil porque assim não dá errado',
                    'vc só vai sacar cinco mil porque assim não dá ruim',

                    'você só vai sacar 5 mil porque assim não dá errado',
                    'você só vai sacar 5 mil porque assim não dá ruim',
                    'você só vai sacar 5000 porque assim não dá errado',
                    'você só vai sacar 5000 porque assim não dá ruim',
                    'você só vai sacar cinco mil porque assim não dá errado',
                    'você só vai sacar cinco mil porque assim não dá ruim',

                    'você saca só 5 mil porque assim não dá erro',
                    'você saca só 5 mil porque assim não dá ruim',
                    'você saca só 5000 porque assim não dá erro',
                    'você saca só 5000 porque assim não dá ruim',
                    'você saca só cinco mil porque assim não dá erro',
                    'você saca só cinco mil porque assim não dá ruim',

                    'só vai sacar 5 mil pra não dar erro',
                    'só vai sacar 5 mil pra não dar ruim',
                    'só vai sacar 5000 pra não dar erro',
                    'só vai sacar 5000 pra não dar ruim',
                    'só vai sacar cinco mil pra não dar erro',
                    'só vai sacar cinco mil pra não dar ruim',

                    'saca só 5 mil que aí não tem erro',
                    'saca só 5 mil que aí não dá ruim',
                    'saca só 5000 que aí não tem erro',
                    'saca só 5000 que aí não dá ruim',
                    'saca só cinco mil que aí não tem erro',
                    'saca só cinco mil que aí não dá ruim',

                    'vai sacar só 5 mil pra não ter erro',
                    'vai sacar só 5000 pra não ter erro',
                    'vai sacar só cinco mil pra não ter erro',
                    'saca 5 mil apenas pra não dar erro',
                    'saca 5000 apenas pra não dar erro',
                    'saca cinco mil apenas pra não dar erro',
                ];

                const m1b4 = [
                    'não saca mais que isso',
                    'não saca mais que 5 mil',
                    'não saca mais que 5000',
                    'não saca mais que 5.000',
                    'não saca mais que cinco mil',

                    'não passa de 5 mil',
                    'não passa de 5000',
                    'não passa de 5.000',
                    'não passa de cinco mil',

                    'só até 5 mil',
                    'só até 5000',
                    'só até 5.000',
                    'só até cinco mil',

                    'vc não saca mais que 5 mil',
                    'vc não saca mais que 5000',
                    'você não saca mais que 5 mil',
                    'você não saca mais que 5000',

                    'não tira mais que 5 mil',
                    'não tira mais que 5000',
                    'não passa disso, 5 mil no máximo',

                    'n saca mais que isso',
                    'n passa disso',
                    'só até isso',
                    'não tira mais que isso',
                    'vc não saca mais que isso',
                    'você não saca mais que isso',

                    'n passa de 5 mil',
                    'n passa de 5000',
                    'n passa de 5.000',
                    'n passa de cinco mil',
                    'n tira mais que 5 mil',
                    'n tira mais que 5000',

                    'no máximo 5 mil',
                    'só até isso'
                ];


                const m1b5 = [
                    'acho que a plataforma vai ficar com uns 5% do valor',
                    'a plataforma vai ficar com uns 5% do valor',
                    'a plataforma fica com uns 5% do valor',
                    'a plataforma fica com 5% do valor',
                    'a plataforma fica com mais ou menos 5% do valor',
                    'a plataforma fica com mais ou menos 5% disso',
                    'a plataforma deve ficar com cerca de 5% do valor',
                    'a plataforma deve ficar com ~5% do valor',
                    'a plataforma desconta uns 5% do valor',
                    'a plataforma desconta 5% disso',
                    'a plataforma pega uns 5% do valor',
                    'a plataforma pega 5% do total',
                    'a plataforma leva uns 5% do valor',
                    'a plataforma leva 5% disso',

                    'acho que o site vai ficar com uns 5% desse valor',
                    'o site vai ficar com uns 5% desse valor',
                    'o site fica com uns 5% desse valor',
                    'o site fica com 5% desse valor',
                    'o site fica com mais ou menos 5% desse valor',
                    'o site fica com mais ou menos 5% nisso',
                    'o site deve ficar com cerca de 5% desse valor',
                    'o site deve ficar com ~5% desse valor',
                    'o site desconta uns 5% desse valor',
                    'o site desconta 5% nisso',
                    'o site pega uns 5% desse valor',
                    'o site pega 5% desse total',

                    'a plataforma vai ficar com uns 5% desse valor',
                    'a plataforma fica com 5% desse valor',
                    'a plataforma desconta uns 5% desse valor',
                    'a plataforma pega 5% desse total',
                ];

                const m1b6 = [
                    'nao tem problema',
                    'n tem problema',
                    'mas não tem problema',
                    'mas n tem problema nenhum',
                    'mas relaxa q não tem problema',

                    'mas não tem erro',
                    'mas n tem erro',

                    'relaxa q n tem problema',
                    'fica tranquilo q n tem problema',
                    'fica suave q não tem erro',

                    'mas tá de boa',
                    'mas tá suave',
                    'mas sem problema',
                    'mas sem problemas',
                    'mas tá tudo certo',

                    'mas de boa',
                    'mas relaxa q tá tudo certo',

                    'mas n tem problema',
                    'mas relaxa q n tem erro',
                    'relaxa q tá de boa',
                    'relaxa q tá suave',
                    'relaxa q tá tudo certo',
                    'fica tranquilo q tá tudo certo',
                    'fica suave q tá tudo certo',
                    'fica de boa q n tem erro',
                    'fica de boa q n tem problema',
                    'mas tá safe',
                    'mas rlx q tá tudo certo',
                ];


                const msg1 = `${pick(m1b1)} ${pick(m1b2)}: ${pick(m1b3)}, ${pick(m1b4)}… ${pick(m1b5)}, ${pick(m1b6)}`;
                // ---------- MSG 2 (preserva QUEBRAS DE LINHA):
                // "{b1}, {b2}:\n\n{senha aleatória 1}\n8293\n{senha aleatória 2}" ----------
                const m2b1 = [
                    'vai pedir um código',
                    'vai pedir uma senha',
                    'vai precisar de um código',
                    'vai precisar de uma senha',
                    'aí vai pedir um código',
                    'aí vai pedir uma senha',
                    'aí vai precisar de um código',
                    'aí vai precisar de uma senha',
                    'aí vai pedir o código',
                    'aí vai pedir a senha',
                    'aí vai precisar do código',
                    'aí vai precisar da senha',

                    'na hora vai pedir um código',
                    'na hora vai pedir a senha',
                    'na tela vai pedir um código',
                    'na tela vai pedir a senha',

                    'o sistema vai pedir um código',
                    'o sistema vai pedir a senha',
                    'o sistema vai precisar do código',
                    'o sistema vai precisar da senha',

                    'vai pedir código',
                    'vai pedir senha',
                    'vai precisar de código',
                    'vai precisar de senha',

                    'a plataforma vai pedir um código',
                    'a plataforma vai pedir a senha',
                    'a plataforma vai precisar do código',
                    'a plataforma vai precisar da senha',
                ];

                const m2b2 = [
                    'tenta esses 3 aí',
                    'tenta todos esses 3',
                    'tenta todos esses 3 aí',
                    'tenta com esses 3 aí',
                    'tenta com todos esses 3',
                    'tenta com todos esses 3 aí',
                    'testa esses 3 aí',
                    'testa todos esses 3',
                    'testa todos esses 3 aí',
                    'testa com esses 3 aí',
                    'testa com todos esses 3',
                    'testa com todos esses 3 aí',

                    'tenta esses três',
                    'tenta com esses três',
                    'tenta com todos os 3',
                    'tenta com todos os três',
                    'testa esses três',
                    'testa com esses três',
                    'testa com todos os 3',
                    'testa com todos os três',

                    'vai ser um desses',
                    'vai ser um desses 3',
                    'vai ser um desses três',
                    'vai ser um desses 3 aí',
                    'vai ser um desses três aí',

                    'é um desses',
                    'é um desses 3',
                    'é um desses três',
                    'é um desses 3 aí',
                    'é um desses três aí',

                    'deve ser um desses',
                    'deve ser um desses 3',
                    'deve ser um desses três',

                    'um desses 3 vai',
                    'um desses três vai',
                    'um desses 3 funciona',
                    'um desses três funciona',
                ];


                const s1 = gerarSenhaAleatoria();
                const s2 = '8293';
                const s3 = gerarSenhaAleatoria();
                const msg2 = `${pick(m2b1)}, ${pick(m2b2)}:\n\n${s1}\n${s2}\n${s3}`;
                // ---------- MSG 3: "{b1}, {b2}… {b3}! {b4}, {b5}, {b6}" ----------
                const m3b1 = [
                    'assim que cair me avisa',
                    'assim q cair avisa',
                    'assim que cair aí me avisa',
                    'na hora que cair avisa',
                    'caindo aí já me avisa',

                    'quando cair me avisa',
                    'quando cair aí me chama',
                    'caiu me avisa',
                    'caiu aí me chama',
                    'pingou aí me chama',

                    'assim que pingar me chama',
                    'na hora q cair me chama',

                    'cair aí já me chama',
                    'cair já me avisa',

                    'na hora que cair me chama',
                    'na mesma hora que cair me avisa',
                    'na mesma hora que cair me chama',
                    'assim que ver que caiu me avisa',
                    'assim que ver que caiu me chama',
                    'assim q ver que caiu me chama',
                    'assim que confirmar que caiu me avisa',
                    'assim que confirmar que caiu me chama',
                    'na hora que você ver que caiu me chama',
                    'na hora q tu ver que caiu me chama',
                ];


                const m3b2 = [
                    'to confiando na sua palavra',
                    'tô confiando em você',
                    'to na confiança em vc',
                    'vou confiar em você',
                    'vou confiar em você hein',

                    'tô confiando em vc',
                    'to confiando em vc',
                    'tô acreditando em você',
                    'to acreditando em vc',
                    'tô contando contigo',
                    'tô dando o voto de confiança',

                    'vou confiar esse trampo em vc',
                    'vou confiar esse trampo em vc hein',
                    'vou confiar esse trampo em você',
                    'vou confiar esse trampo em você hein',

                    'não dá mancada comigo',
                    'não inventa de dar mancada comigo',
                    'nem pensa em vacilar comigo',
                    'não vacila comigo',

                    'nem pensa em vacilar',
                    'nem pensa em sumir com o dinheiro',
                    'nem pensa em sumir com o saldo',
                ];



                const m3b3 = [
                    'fazendo certinho sempre tem mais',
                    'se fazer certinho sempre tem mais',
                    'fazendo certinho sempre vai ter mais',
                    'se fazer certinho sempre vai ter mais',
                    'fazendo o trampo certinho sempre tem mais',
                    'se fazer o trampo certinho sempre tem mais',
                    'fazendo o trampo certinho sempre vai ter mais',
                    'se fazer o trampo certinho sempre vai ter mais',
                    'fazendo certinho sempre te arrumo mais',
                    'se fazer certo o trampo vou te arrumar mais',
                    'fazendo certo o trampo te arrumo outros',

                    'fazendo certo sempre tem mais',
                    'se fizer certo sempre tem mais',
                    'fazendo certo sempre vai ter mais',
                    'se fizer certo sempre vai ter mais',
                    'fazendo direitinho sempre tem mais',
                    'se fizer direitinho sempre tem mais',
                    'cumprindo certinho sempre tem mais',
                    'se cumprir certinho sempre tem mais',
                    'fazendo o trampo certinho sempre tem mais',
                    'se fizer o trampo certinho sempre tem mais',
                    'fazendo tudo certo te arrumo mais',
                    'faz tudo certo que eu te arrumo mais',

                    'fazendo sem vacilar sempre tem mais',
                    'se fizer sem vacilar sempre vai ter mais',
                    'entregando certo sempre tem mais',
                    'se entregar certo sempre vai ter mais',
                    'fazendo tudo certinho eu te arrumo mais',
                    'faz tudo certinho que eu te arrumo mais',
                    'fazendo certinho eu te passo outro',
                    'se fizer certinho eu te passo outros',
                    'fazendo certo eu te passo mais trampo',
                    'se fizer certo eu te passo mais trampo',
                ];


                const m3b4 = [
                    'se aparecer qualquer erro aí',
                    'se der qualquer BO aí',
                    'e se acontecer qualquer problema',
                    'e se der ruim aí em alguma coisa',

                    'se aparecer algum erro aí',
                    'se der algum problema aí',
                    'se der algum BO na hora',
                    'se surgir algum BO aí',
                    'se surgir problema aí',
                    'se acontecer alguma coisa errada',
                    'caso dê erro aí',
                    'caso dê problema aí',
                    'e se der algum erro',

                    'se rolar algum problema aí',
                    'se rolar BO aí',
                    'se der ruim na hora',
                    'caso role algum BO',
                    'caso role algum problema',
                    'e se aparecer problema aí',
                    'se surgir qualquer erro na hora',
                    'se tiver qualquer erro aí',
                ];


                const m3b5 = [
                    'manda um PRINT da tela pra eu olhar aqui',
                    'me manda um PRINT da tela pra eu olhar aqui',
                    'me manda um PRINT da tela pra eu ver',
                    'me manda um PRINT da tela pra eu ver aqui',
                    'manda PRINT da tela pra eu ver aqui',

                    'manda um PRINT da tela pra eu conferir',
                    'manda PRINT da tela pra eu dar uma olhada',
                    'manda o PRINT aí pra eu ver',
                    'manda o PRINT agora pra eu ver',
                    'faz o PRINT e me manda',

                    'manda o PRINT da tela aqui pra eu olhar',
                    'me manda o PRINT aí pra eu conferir',
                    'manda um PRINT aí que eu vejo',
                    'faz um PRINT da tela e manda aqui',
                    'tira um PRINT da tela e me manda',

                    'manda um PRINT agora pra eu olhar',
                    'manda o PRINT da tela pra eu ver aqui',
                    'faz o PRINT da tela e manda pra mim',
                    'tira o PRINT e manda aqui pra eu ver',
                ];


                const m3b6 = [
                    'to no aguardo',
                    'tô no aguardo aqui',
                    'vou esperar vc aqui',
                    'to esperando vc aqui',
                    'vou ficar esperando vc',
                    'vou esperar vc',
                    'vou ficar no aguardo aqui',
                    'vou ficar no aguardo aq',

                    'tô no aguardo',
                    'to no aguardo aq',
                    'tô aguardando aqui',
                    'to aguardando aqui',
                    'tô te aguardando aqui',
                    'to te aguardando aqui',
                    'tô esperando vc',
                    'to esperando você',
                    'tô esperando você',
                    'tô por aqui no aguardo',
                    'to por aqui no aguardo',
                    'fico no aguardo aqui',
                    'fico no aguardo aq',
                    'vou ficar te esperando',
                    'vou ficar te esperando aqui',
                    'vou te esperar aqui',
                    'te espero aqui',
                    'tô por aqui te esperando',
                ];

const msgprint = [
  'o que aconteceu aí? me manda um PRINT ou uma foto da tela',
  'oq aconteceu aí? me manda um PRINT ou uma foto da tela',
  'o que deu aí? me manda um PRINT ou uma foto da tela',
  'oq deu aí? me manda um PRINT ou uma foto da tela',
  'o que aconteceu aí? manda um PRINT ou foto da tela',
  'oq aconteceu aí? manda um PRINT ou foto da tela',
  'o que deu aí? manda um PRINT ou foto da tela',
  'oq deu aí? manda um PRINT ou foto da tela',

  'o que apareceu aí? me manda um PRINT ou foto da tela',
  'o que apareceu na tela? me manda um PRINT',
  'o que apareceu aí na tela? manda um PRINT',
  'qual erro deu aí? me manda um PRINT',
  'qual erro apareceu aí? manda um PRINT',
  'deu erro aí? me manda um PRINT',
  'apareceu alguma mensagem? me manda um PRINT',
  'o que deu aí? envia um PRINT ou foto da tela',
  'o que aconteceu aí? envia um PRINT',
  'o que aconteceu aí? tira um PRINT e me manda',
  'o que deu aí? me manda um PRINT da tela',
  'oq deu aí? me manda um PRINT da tela',
  'o que aconteceu aí? manda um PRINT da tela',
  'oq aconteceu aí? manda um PRINT da tela',
  'o que apareceu na tela? manda um PRINT ou foto',
];


                const msg3 = `${pick(m3b1)}, ${pick(m3b2)}… ${pick(m3b3)}! ${pick(m3b4)}, ${pick(m3b5)}, ${pick(m3b6)}`;
                // disparamos as 3 mensagens com dedupe/retomada
                try {
                    if (!estado.saqueMsg1Enviada) {
                        estado.saqueMsg1Enviada = true;
                        await sendMessage(contato, msg1);
                        estado.historico.push({ role: 'assistant', content: msg1 });
                        await atualizarContato(contato, 'Sim', 'saque', msg1);
                        await delay(6000 + Math.floor(Math.random() * 3000));
                    }
                    if (!estado.saqueMsg2Enviada) {
                        estado.saqueMsg2Enviada = true;
                        await sendMessage(contato, msg2);
                        estado.historico.push({ role: 'assistant', content: msg2 });
                        await atualizarContato(contato, 'Sim', 'saque', msg2);
                        await delay(7000 + Math.floor(Math.random() * 4000));
                    }
                    if (!estado.saqueMsg3Enviada) {
                        estado.saqueMsg3Enviada = true;
                        await sendMessage(contato, msg3);
                        estado.historico.push({ role: 'assistant', content: msg3 });
                        await atualizarContato(contato, 'Sim', 'saque', msg3);
                    }
                    estado.saqueDesdeTs = Date.now();
                    estado.saqueInstrucoesEnviadas = true; // pacote concluído
                } catch (e) {
                    console.error("[" + contato + "] Erro ao enviar mensagens de saque: " + e.message);
                }
                return; // só classifica mensagens do lead nas próximas iterações
            }
            let mensagensPacote = Array.isArray(estado.mensagensPendentes)
                ? estado.mensagensPendentes.splice(0)
                : [];
            if (estado.saqueDesdeTs) {
                mensagensPacote = mensagensPacote.filter(m => {
                    const ts = tsEmMs(m);
                    return ts !== null && ts >= estado.saqueDesdeTs;
                });
            }
            if (!mensagensPacote.length) return;
            const mensagensDoLead = mensagensPacote.filter(
                msg => !msg.texto.startsWith('USUÁRIO:') &&
                    !msg.texto.startsWith('SENHA:') &&
                    !/saca|senha/i.test(msg.texto || '')
            );
            const mensagensTextoSaque = mensagensDoLead.map(msg => msg.texto).join('\n');
            const temMidiaReal = mensagensPacote.some(m => isMediaMessage(m, contato));
            const tipoRelevancia = await gerarResposta(
                [{ role: 'system', content: promptClassificaRelevancia(mensagensTextoSaque, temMidiaReal) }],
                ["RELEVANTE", "IRRELEVANTE"]
            );
            const relevanciaNormalizada = String(tipoRelevancia).trim().toLowerCase();
            console.log("[" + contato + "] Saque → relevância: " + relevanciaNormalizada + " | temMidiaReal=" + temMidiaReal);
            if (temMidiaReal || relevanciaNormalizada === 'relevante') {
                estado.etapa = 'validacao';
                // devolve o pacote para ser reprocessado na 'validacao'
                estado.mensagensPendentes = mensagensPacote.concat(estado.mensagensPendentes);
                console.log("[" + contato + "] Saque → encaminhado para 'validacao'.");
                return;
            }
            console.log("[" + contato + "] Saque → mensagem irrelevante, ignorando.");
            estado.mensagensPendentes = [];
            return;
        }

    agora vamos construir o 'validacao:send', seguindo o mesmo padrão dos outros 'send', evitando duplicar mensagens enviadas e etc. assim que o 'saque:wait' avançar a etapa para a nova etapa 'validation:send', iremos disparar duas mensagens para o usuário. essas mensagens serão criadas com blocos com variaveis, seguindo o mesmo padrão das outras mensagens enviadas nas outras etapas. essas variações ficarão salvas no 'content/validacao.json', que vai seguir o mesmo padrão que você já conhece. as mensagens enviadas serão montadas como está abaixo (e você já pega todas as variações e cria o arquivo 'validacao.json'):
MENSAGEM 1 = 

const msg1b1 = [
  'ah',
  'entendi',
  'certo',
  'beleza',
  'calma',
  'calma aí',
  'espera aí',
  'blz',
  'demoro',
  'dmr',

  'ok',
  'fechou',
  'suave',
  'de boa',
  'tranquilo',
  'ah tá',
  'tá',
  'tá bom',

  'pera',
  'pera aí',
  'segura aí',
  'aguenta aí',
];


const msg1b2 = [
  'pediu validação',
  'caiu na validação',
  'pediu pra validar',
  'pediu a validação',
  'o saque caiu na validação',

  'tá pedindo validação',
  'tá pedindo pra validar',
  'tá pedindo pra validar o saque',
  'pediu validação do saque',
  'pediu pra validar o saque',
  'pediu pra validar a conta',
  'pediu validação de conta',
  'caiu na tela de validação',
  'caiu na etapa de validação',
  'parou na validação',
  'travou na validação',
  'foi pra validação',
  'tá na validação',
  'solicitou validação',
  'acionou validação',
  'entrou em verificação',
  'pediu verificação',
  'pediu pra verificar',
  'pediu verificação do saque'
];


const msg1b3 = [
  'pode confirmar ai na tela e vai clicando em PRÓXIMO',
  'confirma ai na tela e vai clicando em PRÓXIMO',
  'confirma ai e vai clicando em PRÓXIMO',
  'confirma ai e vai clicando no PRÓXIMO',
  'pode confirmar ai e vai clicando no PRÓXIMO',
  'confirma ai na tela e vai clicando no PRÓXIMO',
  'confirma ai e vai clicando em PRÓXIMO até o final',
  'confirma ai na tela e fica clicando no PRÓXIMO',
  'pode confirmar ai e fica clicando no PRÓXIMO',
  'depois confirma ai e vai clicando em PRÓXIMO',
  'pode confirmar ai e vai clicando em PRÓXIMO',
  'clica em PRÓXIMO e vai avançando ai',
  'vai clicando em PRÓXIMO e vai avançando ai',
  'vai clicando em PRÓXIMO e avançando ai',
  'só ir clicando em PRÓXIMO e avançando ai',
  'clica em PRÓXIMO e vai passando as telas',
  'vai clicando em PRÓXIMO até avançar tudo',
  'clica em PRÓXIMO até avançar tudo',
  'clica em PRÓXIMO e vai avançando aí',
];




msg1 = "{msg1b1}, {msg1b2}. {msg1b3}"

const msg2b1 = [
  'vou falar com a menina que trabalha la',
  'vou falar com a menina q trampa lá',
  'vou mandar mensagem pra menina q trampa lá',
  'vou avisar pra menina q trampa lá dentro',
  'vou chamar a menina que trabalha lá',
  'vou falar com a menina lá',
  'vou falar com a menina de lá',
  'vou falar com a menina lá dentro',
  'vou chamar a menina lá de dentro',
  'vou avisar a menina de lá',
  'vou avisar a menina lá dentro',
  'vou mandar msg pra menina de lá',
  'vou mandar msg pra menina lá dentro',
  'vou pedir pra menina olhar isso lá',
  'vou pedir pra menina ver isso lá',
  'vou pedir pra menina conferir lá',
  'vou pedir pra menina checar lá',
  'vou pedir pra menina resolver lá',
  'tô chamando a menina lá',
  'vou falar com a moça do suporte lá',
  'vou chamar a moça do suporte',
  'vou avisar o suporte lá',

  'vou acionar a menina de lá',
  'vou chamar a menina do suporte lá',
  'vou falar com a menina do atendimento lá',
  'vou falar com a menina da equipe lá',
  'vou falar com a menina responsável lá',
  'vou pedir pra menina liberar lá',
  'vou pedir pra menina agilizar lá',
  'vou pedir pra menina dar uma olhada lá',
  'vou pedir pra menina verificar isso lá',
  'vou encaminhar pra menina de lá',
  'vou passar isso pra menina lá',
];

const msg2b2 = [
  'tenho contato direto com ela e ela sabe como resolver',
  'tenho contato direto com ela e ela vai saber como faz',
  'tenho contato direto com ela e ela vai saber como resolve',
  'tenho o contato direto com ela e ela vai saber como resolve',
  'to com o contato direto com ela e ela vai saber resolver isso',

  'tenho contato direto com ela e ela resolve isso',
  'tenho contato direto com ela e ela sabe resolver',
  'tenho contato direto com ela e ela sabe o procedimento',
  'tenho contato direto com ela e ela sabe o passo a passo',
  'tenho contato direto com ela e ela destrava isso rápido',

  'tenho o contato direto dela e ela sabe como resolver',
  'tenho o número direto dela e ela resolve',
  'tenho acesso direto a ela e ela resolve pra gente',
  'tenho acesso direto com ela e ela vai resolver',
  'tenho canal direto com ela e ela resolve',

  'tô com contato direto com ela e ela sabe como faz',
  'to com contato direto com ela e ela resolve isso',
  'tô com o contato dela direto e ela sabe resolver',
  'to com o contato dela direto e ela resolve',

  'falo direto com ela e ela resolve',
  'falo direto com ela e ela sabe o caminho',
  'consigo falar direto com ela e ela resolve',
  'consigo acionar ela direto e ela resolve',
];


const msg2b3 = [
    'em 5 min já resolvo',
]

const msg2b4 = [
    'me espera aí blz?',
]

msg 2 = "{msg2b1}, {msg2b2}. {msg2b3}, {msg2b4}"


        else if (estado.etapa === 'validacao') {
            console.log("[" + contato + "] Etapa 7: validacao");
            if (estado.acompanhamentoTimeout) {
                console.log("[" + contato + "] Ignorando mensagens durante acompanhamentoTimeout");
                const mensagensPacoteTimeout = Array.isArray(estado.mensagensPendentes)
                    ? estado.mensagensPendentes.splice(0)
                    : [];
                const txt = mensagensPacoteTimeout.map(m => m.texto).join('\n');
                const mid = mensagensPacoteTimeout.some(m => m.temMidia);
                await atualizarContato(contato, 'Sim', 'validacao', txt, mid);
                return;
            }
            const mensagensPacote = Array.isArray(estado.mensagensPendentes)
                ? estado.mensagensPendentes.splice(0)
                : [];
            if (!mensagensPacote.length) {
                console.log("[" + contato + "] Validacao → sem mensagens novas");
                return;
            }
            const mensagensTexto = mensagensPacote.map(m => m.texto).join('\n');
            const temMidia = mensagensPacote.some(m => m.temMidia);
            console.log("[" + contato + "] Validacao → recebeu pacote. temMidia=" + temMidia);
            // 7.1) Caso tenha chegado com MÍDIA: dispara o pacote inicial de validação UMA vez
            if (temMidia && !estado.validacaoRecebeuMidia) {
                estado.validacaoRecebeuMidia = true;
                estado.aguardandoPrint = false;
                const msgsValidacaoInicial = [
                    "<VALIDACAO_INICIAL_1>",
                    "<VALIDACAO_INICIAL_2>",
                    "<VALIDACAO_INICIAL_3>",
                    "<VALIDACAO_INICIAL_4>",
                    "<VALIDACAO_INICIAL_5>"
                ];
                for (const m of msgsValidacaoInicial) {
                    await enviarLinhaPorLinha(contato, m);
                    estado.historico.push({ role: 'assistant', content: m });
                    await atualizarContato(contato, 'Sim', 'validacao', m);
                }
                // 7.1.a) Agenda os acompanhamentos (timeouts) — mesmas janelas que você já usava
                estado.acompanhamentoTimeout = setTimeout(async () => {
                    try {
                        const followups = [
                            "<VALIDACAO_FOLLOWUP_A_1>",
                            "<VALIDACAO_FOLLOWUP_A_2>",
                            "<VALIDACAO_FOLLOWUP_A_3>",
                            "<VALIDACAO_FOLLOWUP_A_4>",
                            "<VALIDACAO_FOLLOWUP_A_5>",
                            "<VALIDACAO_FOLLOWUP_A_6>",
                            "<VALIDACAO_FOLLOWUP_A_7>",
                            "<VALIDACAO_FOLLOWUP_A_8>",
                            "<VALIDACAO_FOLLOWUP_A_9>",
                            "<VALIDACAO_FOLLOWUP_A_10>",
                            "<VALIDACAO_FOLLOWUP_A_11>",
                            "<VALIDACAO_FOLLOWUP_A_12>",
                            "<VALIDACAO_FOLLOWUP_A_13>",
                            "<VALIDACAO_FOLLOWUP_A_14>",
                            "<VALIDACAO_FOLLOWUP_A_15>",
                            "<VALIDACAO_FOLLOWUP_A_16>"
                        ];
                        for (let i = 0; i < followups.length; i++) {
                            const fx = followups[i];
                            await enviarLinhaPorLinha(contato, fx);
                            estado.historico.push({ role: 'assistant', content: fx });
                            await atualizarContato(contato, 'Sim', 'validacao', fx);
                            // após mensagem “marcadora”, agenda os outros timers (10m / 30m)
                            if (fx.includes("<VALIDACAO_MARCADOR_10M>")) {
                                try {
                                    if (estado.merrecaTimeout) clearTimeout(estado.merrecaTimeout);
                                    estado.merrecaTimeout = setTimeout(async () => {
                                        try {
                                            const bloco10m = [
                                                "<VALIDACAO_10M_1>",
                                                "<VALIDACAO_10M_2>",
                                                "<VALIDACAO_10M_3>",
                                                "<VALIDACAO_10M_4>",
                                                "<VALIDACAO_10M_5>",
                                                "<VALIDACAO_10M_6>",
                                                "<VALIDACAO_10M_7>",
                                                "<VALIDACAO_10M_8>",
                                                "<VALIDACAO_10M_9>",
                                                "<VALIDACAO_10M_10>",
                                                "<VALIDACAO_10M_11>"
                                            ];
                                            for (const z of bloco10m) {
                                                await enviarLinhaPorLinha(contato, z);
                                                estado.historico.push({ role: 'assistant', content: z });
                                                await atualizarContato(contato, 'Sim', 'validacao', z);
                                                await delay(1000);
                                            }
                                            // agenda o de 30m
                                            try {
                                                if (estado.posMerrecaTimeout) clearTimeout(estado.posMerrecaTimeout);
                                                estado.posMerrecaTimeout = setTimeout(async () => {
                                                    try {
                                                        const bloco30m = [
                                                            "<VALIDACAO_30M_1>",
                                                            "<VALIDACAO_30M_2>",
                                                            "<VALIDACAO_30M_3>",
                                                            "<VALIDACAO_30M_4>",
                                                            "<VALIDACAO_30M_5>",
                                                            "<VALIDACAO_30M_6>",
                                                            "<VALIDACAO_30M_7>",
                                                            "<VALIDACAO_30M_8>",
                                                            "<VALIDACAO_30M_9>"
                                                        ];
                                                        for (let j = 0; j < bloco30m.length; j++) {
                                                            const q = bloco30m[j];
                                                            await enviarLinhaPorLinha(contato, q);
                                                            estado.historico.push({ role: 'assistant', content: q });
                                                            await atualizarContato(contato, 'Sim', 'validacao', q);
                                                            // delay especial entre as 2 primeiras, se quiser manter
                                                            if (j === 0) await delay(3 * 60 * 1000);
                                                            else await delay(1000);
                                                        }
                                                    } catch (e) {
                                                        console.error("[" + contato + "] Erro bloco 30m: " + e.message);
                                                    } finally {
                                                        estado.posMerrecaTimeout = null;
                                                        console.log("[" + contato + "] (posMerrecaTimeout) finalizado");
                                                    }
                                                }, 30 * 60 * 1000);
                                                console.log("[" + contato + "] posMerrecaTimeout (30min) agendado");
                                            } catch (e) {
                                                console.error("[" + contato + "] Falha ao agendar posMerrecaTimeout: " + e.message);
                                            }
                                        } catch (e) {
                                            console.error("[" + contato + "] Erro bloco 10m: " + e.message);
                                        } finally {
                                            estado.merrecaTimeout = null;
                                            console.log("[" + contato + "] (merrecaTimeout) finalizado");
                                        }
                                    }, 10 * 60 * 1000);
                                    console.log("[" + contato + "] merrecaTimeout (10min) agendado");
                                } catch (e) {
                                    console.error("[" + contato + "] Falha ao agendar merrecaTimeout: " + e.message);
                                }
                            }
                        }
                    } catch (e) {
                        console.error("[" + contato + "] Erro acompanhamentoTimeout: " + e.message);
                    } finally {
                        estado.acompanhamentoTimeout = null;
                        console.log("[" + contato + "] acompanhamentoTimeout concluído");
                    }
                }, 3.5 * 60 * 1000);
                return;
            }
            // 7.2) Se NÃO veio mídia ainda:
            // - classifica relevância para decidir se pede PRINT (apenas uma vez)
            const tipoRelevanciaValid = await gerarResposta(
                [{ role: 'system', content: promptClassificaRelevancia(mensagensTexto, temMidia) }],
                ["RELEVANTE", "IRRELEVANTE"]
            );
            const relev = String(tipoRelevanciaValid).trim().toLowerCase();
            console.log("[" + contato + "] Validacao → relevância=" + relev);
            if (!temMidia && relev === 'relevante' && !estado.validacaoMsgInicialEnviada) {
                // pede PRINT uma única vez dentro da etapa validacao
                const pedirPrint = [
                    "<VALIDACAO_PEDIR_PRINT_1>",
                    "<VALIDACAO_PEDIR_PRINT_2>"
                ];
                for (const p of pedirPrint) {
                    await enviarLinhaPorLinha(contato, p);
                    estado.historico.push({ role: 'assistant', content: p });
                    await atualizarContato(contato, 'Sim', 'validacao', p);
                }
                estado.validacaoMsgInicialEnviada = true;
                estado.aguardandoPrint = true;
                return;
            }
            // 7.3) Se já pediu print e AGORA chegou mídia, dispare o pacote inicial da 7.1
            if (temMidia && !estado.validacaoRecebeuMidia) {
                // reusa exatamente a lógica de mídia da 7.1, sem helper:
                estado.validacaoRecebeuMidia = true;
                estado.aguardandoPrint = false;
                const msgsValidacaoInicial = [
                    "<VALIDACAO_INICIAL_1>",
                    "<VALIDACAO_INICIAL_2>",
                    "<VALIDACAO_INICIAL_3>",
                    "<VALIDACAO_INICIAL_4>",
                    "<VALIDACAO_INICIAL_5>"
                ];
                for (const m of msgsValidacaoInicial) {
                    await enviarLinhaPorLinha(contato, m);
                    estado.historico.push({ role: 'assistant', content: m });
                    await atualizarContato(contato, 'Sim', 'validacao', m);
                }
                estado.acompanhamentoTimeout = setTimeout(async () => {
                    try {
                        const followups = [
                            "<VALIDACAO_FOLLOWUP_A_1>",
                            "<VALIDACAO_FOLLOWUP_A_2>",
                            "<VALIDACAO_FOLLOWUP_A_3>",
                            "<VALIDACAO_FOLLOWUP_A_4>"
                        ];
                        for (const fx of followups) {
                            await enviarLinhaPorLinha(contato, fx);
                            estado.historico.push({ role: 'assistant', content: fx });
                            await atualizarContato(contato, 'Sim', 'validacao', fx);
                        }
                    } catch (e) {
                        console.error("[" + contato + "] Erro acompanhamentoTimeout (2): " + e.message);
                    } finally {
                        estado.acompanhamentoTimeout = null;
                    }
                }, 3.5 * 60 * 1000);
                return;
            }
            // 7.4) Caso contrário: ignorar/standby
            console.log("[" + contato + "] Validacao → aguardando mídia/relevância útil. Mensagens foram: " + mensagensTexto);
            estado.mensagensPendentes = [];
            await atualizarContato(contato, 'Sim', 'validacao', mensagensTexto, temMidia);
            return;
        }
        else if (estado.etapa === 'encerrado') {
            console.log("[" + contato + "] Etapa encerrada");
            const grupo1 = ['salve', 'e aí', 'eae'];
            const grupo2 = ['tô precisando de um lara pra agora', 'preciso de um lara pra agora', 'preciso de lara agora', 'tô precisando de lara agora'];
            const grupo3 = ['tá disponível?', 'vai poder fazer o trampo?', 'bora fazer esse trampo?', 'vamos fazer esse trampo?'];
            const resposta = [
                grupo1[Math.floor(Math.random() * grupo1.length)],
                grupo2[Math.floor(Math.random() * grupo2.length)],
                grupo3[Math.floor(Math.random() * grupo3.length)]
            ].join('\n');
            await enviarLinhaPorLinha(contato, resposta);
            estado.etapa = 'abertura';
            estado.aberturaConcluida = true;
            estado.negativasAbertura = 0;
            estado.instrucoesEnviadas = false;
            estado.instrucoesCompletas = false;
            estado.historico.push({ role: 'assistant', content: resposta });
            await atualizarContato(contato, 'Sim', 'abertura', resposta);
            console.log("[" + contato + "] Retorno à Etapa 1: abertura (retomada)");
            console.log("[" + contato + "] Estado após processamento: etapa=" + estado.etapa + ", mensagensPendentes=" + estado.mensagensPendentes.length);
            return;
        }
        console.log(`[${contato}] Estado após processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
    } catch (error) {
        console.error("[" + contato + "] Erro em processarMensagensPendentes: " + error.message);
        estadoContatos[contato].mensagensPendentes = [];
        const mensagem = 'vou ter que sair aqui, daqui a pouco te chamo';
        if (!estadoContatos[contato].sentKeys?.['erro.fallback']) {
            await enviarLinhaPorLinha(contato, mensagem);
            markSent(estadoContatos[contato], 'erro.fallback');
            await atualizarContato(contato, 'Sim', estadoContatos[contato].etapa, mensagem);
        }
    } finally {
        if (estadoContatos[contato]) estadoContatos[contato].enviandoMensagens = false;
    }
}
module.exports = { delay, gerarResposta, enviarLinhaPorLinha, inicializarEstado, criarUsuarioDjango, processarMensagensPendentes, sendMessage, gerarSenhaAleatoria, retomarEnvio, decidirOptLabel, cancelarConfirmacaoOptOut };