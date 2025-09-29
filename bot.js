const axios = require('axios');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EXTRA_FIRST_REPLY_BASE_MS = 45000;
const EXTRA_FIRST_REPLY_JITTER_MS = 10000;
const GLOBAL_PER_MSG_BASE_MS = 3000;
const GLOBAL_PER_MSG_JITTER_MS = 1500;

const { getActiveTransport } = require('./lib/transport');
const { getContatoByPhone } = require('./db');
const { atualizarContato, getBotSettings, pool } = require('./db.js');
const { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia, promptClassificaOptOut, promptClassificaReoptin } = require('./prompts.js');
const estadoContatos = require('./state.js');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const URL_RX = /https?:\/\/\S+/i;
const OPTOUT_RX = /\b(pare|para(?!\w)|parar|não quero|nao quero|me remove|remova|me tira|me exclui|excluir|cancelar|unsubscribe|cancel|stop|parem|não mandar|nao mandar)\b/i;

const MAX_OPTOUTS = 3;
const OPTOUT_MSGS = {
  1: 'tranquilo, não vou mais te mandar mensagem. qualquer coisa só chamar',
  2: 'de boa, vou passar o trampo pra outra pessoa e não te chamo mais. não me manda mais mensagem',
};

function pick(arr) {
  return Array.isArray(arr) && arr.length
    ? arr[Math.floor(Math.random() * arr.length)]
    : '';
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

async function enviarLinhaPorLinhaOnce(contato, estado, baseKey, texto) {
  const linhas = String(texto || '').split('\n').filter(l => l !== '');
  for (let i = 0; i < linhas.length; i++) {
    const line = linhas[i];
    const key = `${baseKey}#${i}#${line}`;
    if (!wasSent(estado, key)) {
      await enviarLinhaPorLinha(contato, line);
      markSent(estado, key);
      estado.historico.push({ role: 'assistant', content: line });
    }
  }
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

  // mesmo delay das mensagens de opt-out (10–15s)
  await delay(rand(10000, 15000));

  // 1ª retomada => msg curta; 2ª retomada => aviso "última chance"
  // usa opt_out_count do DB para decidir
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
        // registra no histórico com a etapa atual (ou "retomada" se não houver)
        await atualizarContato(contato, 'Sim', st.etapa || 'retomada', retomadaMsg);
        st.historico?.push?.({ role: 'assistant', content: retomadaMsg });
      } catch (e) {
        console.error(`[${contato}] Falha ao logar mensagem de retomada: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[${contato}] Falha ao buscar opt_out_count para retomada: ${e.message}`);
  }

  // limpar flags e continuar a partir da próxima linha
  st.cancelarEnvio = false;
  st.paused = false;

  // reutiliza o mesmo mecanismo, passando apenas as linhas restantes
  await enviarLinhaPorLinha(contato, remaining);
  if (!st.seqLines && st.seqKind === 'credenciais') {
    st.credenciaisEntregues = true;
    st.seqKind = null;
    console.log(`[${contato}] Credenciais concluídas na retomada.`);
  }
  return true;
}

// --- helpers --- //
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

// --- principal --- //
async function gerarResposta(messages, allowedLabels) {
  const allow = normalizeAllowedLabels(allowedLabels || []);
  const DEFAULT_LABEL = allow.includes("CONTINUAR") ? "CONTINUAR" : (allow[0] || "UNKNOWN");

  try {
    const promptStr = messages.map(m => m.content).join("\n");

    // 1) Tentativa pedindo JSON via prompt (sem response_format / text.format)
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

function quebradizarTexto(resposta) {
  return resposta.replace(/\b(você|vcê|cê|ce)\b/gi, 'vc');
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
  estado.enviandoMensagens = true;
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
  estado.enviandoMensagens = false;
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
    console.log(`[ManyChat][${label}] POST ${url}`);
    console.log(`[ManyChat][${label}] Payload: ${JSON.stringify(payload)}`);
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      validateStatus: () => true
    });
    const brief = typeof resp.data === 'string' ? resp.data.slice(0, 300) : resp.data;
    console.log(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(brief)}`);

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
    negativasAbertura: 0,
    aberturaConcluida: false,
    instrucoesEnviadas: false,
    encerradoAte: null,
    aguardandoAcompanhamento: false,
    tentativasAcesso: 0,
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

    if (estado && (estado.merrecaTimeout || estado.posMerrecaTimeout)) {
      console.log(`[${contato}] Ignorando mensagens durante timeout (merreca/posMerreca)`);
      estado.mensagensPendentes = [];
      return;
    }

    if (!estado || estado.enviandoMensagens) {
      console.log(`[${contato}] Bloqueado: estado=${!!estado}, enviandoMensagens=${estado && estado.enviandoMensagens}`);
      return;
    }
    estado.enviandoMensagens = true;

    const estadoSemTimeout = Object.assign({}, estado, { acompanhamentoTimeout: estado && estado.acompanhamentoTimeout ? '[Timeout]' : null });
    console.log("[" + contato + "] Estado atual: " + JSON.stringify(estadoSemTimeout, null, 2));

    const mensagensPacote = Array.isArray(estado.mensagensPendentes)
      ? estado.mensagensPendentes.splice(0)
      : [];
    const mensagensTexto = mensagensPacote.map(msg => msg.texto).join('\n');
    const temMidia = mensagensPacote.some(msg => msg.temMidia);

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

      if (!estado.interesseEnviado) {
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

        const msgInteresse = `${pick(g1)}, ${pick(g2)}... ${pick(g3)}, ${pick(g4)}, ${pick(g5)}`;
        const sent = await sendOnce(contato, estado, 'interesse.msg', msgInteresse);
        if (sent) {
          estado.interesseEnviado = true;
          await atualizarContato(contato, 'Sim', 'interesse', msgInteresse);
        } else if (wasSent(estado, 'interesse.msg')) {
          estado.interesseEnviado = true;
        }

        estado.mensagensPendentes = [];
        estado.mensagensDesdeSolicitacao = [];
        return;
      }

      if (mensagensPacote.length > 0) {
        const contexto = mensagensPacote.map(m => m.texto).join("\n");
        const classificacao = String(await gerarResposta(
          [{ role: "system", content: promptClassificaAceite(contexto) }],
          ["ACEITE", "RECUSA", "DUVIDA"]
        )).toUpperCase();

        console.log(`[${contato}] Resposta em interesse: ${classificacao}`);

        if (classificacao.includes("ACEITE")) {
          estado.etapa = 'instruções';
          estado.primeiraRespostaPendente = false;
          estado.instrucoesEnviadas = false;
          estado.instrucoesCompletas = true; // (opcional; não é lida no bloco de instruções)
          await atualizarContato(contato, 'Sim', 'instruções', '[Avanço automático após ACEITE]');
          // importante: NÃO dar return aqui → deixa “cair” no bloco de instruções ainda neste ciclo
        } else {
          console.log(`[${contato}] Stand-by em 'interesse' (aguardando ACEITE).`);
          return; // standby só quando NÃO for ACEITE
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
        const instrMsg1 = `${pick(msg1Grupo1)}? ${pick(msg1Grupo2)}… ${pick(msg1Grupo3)}`;

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
          await atualizarContato(contato, 'Sim', 'acesso', '[ACEITE após instruções]');
        }

        console.log(`[${contato}] Stand-by em 'instruções' (aguardando ACEITE).`);
        return;
      }

      return;
    }

    if (estado.etapa === 'acesso') {
      console.log("[" + contato + "] Etapa 4: acesso (reformulada)");

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

      // 1) Montagem dos blocos (TUDO AQUI dentro)
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
        'e-mail e a senha da conta',
        'email e a senha da conta',
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
      const bloco3A = [
        'E-mail',
        'Email',
      ];

      const bloco1C = [
        'entra nesse link',
        'entra por esse link',
        'esse é o link',
        'o link é esse',
        'o link é esse aqui',
        'segue o link',
        'entra no link',
        'clica no link',
        'aperta no link',
        'só clicar no link'
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

        estado.credenciaisEntregues = true;
        await atualizarContato(contato, 'Sim', 'acesso', '[Credenciais enviadas]');
      } else {
        console.log(`[${contato}] Acesso: sequência já disparada (acessoMsgsDisparadas=true), não reenviando.`);
      }

      const mensagensTexto = mensagensPacote.map(m => m.texto).join('\n');
      const tipoAcesso = String(await gerarResposta(
        [{ role: 'system', content: promptClassificaAcesso(mensagensTexto) }],
        ["CONFIRMADO", "NAO_CONFIRMADO", "DUVIDA", "NEUTRO"]
      )).toUpperCase();

      console.log("[" + contato + "] Classificação em acesso: " + tipoAcesso);

      if (tipoAcesso.includes('CONFIRMADO')) {
        estado.etapa = 'confirmacao';
        estado.mensagensDesdeSolicitacao = [];
        estado.tentativasAcesso = 0;
        estado.confirmacaoMsgInicialEnviada = false;

        await atualizarContato(contato, 'Sim', 'confirmacao', '[Login confirmado — avançando]');
        console.log("[" + contato + "] Etapa 5: confirmação — avançou após CONFIRMADO");
        return;
      } else {
        console.log("[" + contato + "] Acesso em standby (aguardando CONFIRMADO).");
        estado.mensagensPendentes = [];
      }
      return;
    }

    else if (estado.etapa === 'confirmacao') {
      console.log("[" + contato + "] Etapa 5: confirmação");
      estado.mensagensDesdeSolicitacao.push(
        ...mensagensPacote.map(m => (m.temMidia ? '[mídia]' : (m.texto || '')))
      );
      const mensagensTextoConfirmacao = estado.mensagensDesdeSolicitacao.join('\n');
      const temMidiaConfirmacao = mensagensPacote.some(msg => msg.temMidia);
      let tipoConfirmacao;
      if (temMidiaConfirmacao) {
        tipoConfirmacao = 'CONFIRMADO';
        console.log("[" + contato + "] Mídia detectada, classificando como confirmado automaticamente");
      } else {
        tipoConfirmacao = String(await gerarResposta(
          [{ role: 'system', content: promptClassificaConfirmacao(mensagensTextoConfirmacao) }],
          ["CONFIRMADO", "NAO_CONFIRMADO", "DUVIDA", "NEUTRO"]
        )).toUpperCase();
      }

      let saldoInformado = null;
      if (tipoConfirmacao.includes('CONFIRMADO')) {
        const candidatos = estado.mensagensDesdeSolicitacao
          .slice()
          .reverse()
          .filter(msg => !msg.includes('[mídia]') && !URL_RX.test(msg))
          .map(msg => {
            const m = msg.match(/(\d{1,3}(\.\d{3})*|\d+)(,\d{2})?/);
            return m ? m[0] : null;
          })
          .filter(Boolean);

        if (candidatos[0]) {
          saldoInformado = candidatos[0].replace(/\./g, '').replace(',', '.');
        } else if (temMidiaConfirmacao) {
          saldoInformado = '5000';
          console.log(`[${contato}] Mídia sem valor em texto; usando saldo default: ${saldoInformado}`);
        }
      }

      console.log("[" + contato + "] Mensagens processadas: " + mensagensTextoConfirmacao + ", Classificação: " + tipoConfirmacao + ", Saldo informado: " + (saldoInformado || 'nenhum'));

      if (tipoConfirmacao.includes('CONFIRMADO') && saldoInformado) {
        estado.saldo_informado = saldoInformado;
        const saqueVariacoes = [
          'beleza, saca R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho) dessa conta',
          'beleza, pode sacar R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho) dessa conta',
          'beleza, saca R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho)',
          'certo, pode sacar R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho)',
          'certo, saca R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho)',
          'pode sacar R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho)',
          'pode sacar R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho)'
        ];
        const senhaIntroVariacao = [
          'vai pedir uma senha de saque, vai ser uma dessas:',
          'vou te passar uma senha de saque, vai ser uma dessas:',
          'vai pedir uma senha, vai ser uma dessas:',
          'vai pedir a senha de saque, vai ser uma dessas:'
        ];
        const parteVariacao = [
          'tua parte no trampo é de 2000',
          'tua parte é de 2000',
          'não esquece, sua parte é de 2000',
          'tua parte no trampo é de R$ 2000',
          'tua parte é de R$ 2000',
          'não esquece, sua parte é de R$ 2000'
        ];
        const avisaVariacao = [
          'assim que cai me avisa',
          'assim que cair me manda uma mensagem',
          'me avisa assim que cai',
          'me manda quando cair'
        ];
        const pixVariacao = [
          'pra eu te passar como você vai mandar minha parte',
          'pra eu poder te passar como vc vai mandar minha parte',
          'pra eu te falar como vc vai me mandar meu dinheiro',
          'pra eu te explicar como vc vai mandar minha parte',
          'pra eu te mostrar como vc vai mandar minha parte'
        ];
        const avisoVariacao = [
          'sem gracinha',
          'certo pelo certo',
          'não pisa na bola',
          'faz direitinho',
          'manda certinho',
          'manda tudo certo'
        ];
        const confiancaVariacao = [
          'tô confiando em vc, se fazer certinho tem mais trampo. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)',
          'tô na fé em vc, faz certo que te passo mais trampo. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)',
          'tô na confiança, faz certo que vai ter mais. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)'
        ];
        const senha1 = gerarSenhaAleatoria();
        const senha2 = '8293';
        const mensagensSaque = [
          saqueVariacoes[Math.floor(Math.random() * saqueVariacoes.length)],
          senhaIntroVariacao[Math.floor(Math.random() * senhaIntroVariacao.length)],
          senha1,
          senha2,
          parteVariacao[Math.floor(Math.random() * parteVariacao.length)],
          avisaVariacao[Math.floor(Math.random() * avisaVariacao.length)] + ' ' + pixVariacao[Math.floor(Math.random() * pixVariacao.length)],
          avisoVariacao[Math.floor(Math.random() * avisoVariacao.length)],
          confiancaVariacao[Math.floor(Math.random() * confiancaVariacao.length)]
        ];
        for (const msg of mensagensSaque) {
          await enviarLinhaPorLinha(contato, msg);
          estado.historico.push({ role: 'assistant', content: msg });
          await atualizarContato(contato, 'Sim', 'saque', msg);
        }
        estado.etapa = 'saque';
        estado.mensagensDesdeSolicitacao = [];
        console.log("[" + contato + "] Etapa 6: saque - instruções enviadas");
      } else if (tipoConfirmacao.includes('NAO_CONFIRMADO')) {
        const respostasNaoConfirmadoConfirmacao = [
          'me escreve o valor que tá disponível, EXATAMENTE nesse formato: R$ 5000, por exemplo',
          'me manda aqui escrito o valor disponível, EXATAMENTE nesse formato: R$ 5000, por exemplo',
          'me escreve aqui o valor disponível, EXATAMENTE nesse formato: R$ 5000, por exemplo',
          'escreve aqui o valor disponível, EXATAMENTE nesse formato: R$ 5000, por exemplo'
        ];
        if (estado.tentativasConfirmacao < 2) {
          const resposta = respostasNaoConfirmadoConfirmacao[Math.floor(Math.random() * respostasNaoConfirmadoConfirmacao.length)];
          await enviarLinhaPorLinha(contato, resposta);
          estado.tentativasConfirmacao++;
          estado.historico.push({ role: 'assistant', content: resposta });
          await atualizarContato(contato, 'Sim', 'confirmacao', resposta);
          console.log("[" + contato + "] Etapa 5: confirmação - tentativa " + (estado.tentativasConfirmacao + 1) + "/2, insistindo");
        } else {
          const mensagem = 'não deu certo, tenta de novo outra hora';
          await enviarLinhaPorLinha(contato, mensagem);
          estado.etapa = 'encerrado';
          estado.encerradoAte = Date.now() + 3 * 60 * 60 * 1000;
          estado.historico.push({ role: 'assistant', content: mensagem });
          await atualizarContato(contato, 'Sim', 'encerrado', mensagem);
          console.log(`[${contato}] Etapa encerrada após 2 tentativas`);
        }
      } else if (tipoConfirmacao.includes('DUVIDA')) {
        const respostasDuvidasComuns = {
          'não tenho 4g': 'não, tudo bem, vamos manter no wi-fi. o resto tá pronto, bora seguir',
          'qual cpf': 'usa o CPF da sua conta que vai receber a grana. faz aí e me avisa',
          'onde fica o perfil': 'no app, geralmente tá nas configurações ou no canto superior, procura por PERFIL',
          'não tenho 5k': 'tenta arrumar uma conta com alguém, precisa ter 5k pra rolar',
          'onde coloco o usuário': 'no campo de login no link que te mandei. copia o usuário e senha certinho',
          'o link não abre': 'tenta copiar e colar no navegador. me avisa se não rolar',
          'qual senha': 'a senha é a que te mandei. copia e cola no login',
          'não achei perfil': 'no app, vai nas configurações ou no canto superior, procura por PERFIL',
          'onde tá financeiro': 'no app, procura no menu ou configurações, tá como FINANCEIRO, depois me manda o valor em texto',
          'qual valor mando': 'o valor que aparece em FINANCEIRO, só escreve o número em texto',
          'como faço o saque': 'vai em FINANCEIRO, seleciona sacar, coloca TUDO pra sua conta e usa as senhas que te mandei',
          'qual chave pix': 'te passo a chave assim que confirmar que caiu, saca primeiro e me avisa',
          'demora quanto': 'saca tudo agora, geralmente cai na hora. me avisa quando cair'
        };
        const mensagemLower = mensagensTextoConfirmacao.toLowerCase();
        let resposta = 'me manda o valor que tá em FINANCEIRO, só o número em texto';
        for (const [duvida, respostaPronta] of Object.entries(respostasDuvidasComuns)) {
          if (mensagemLower.includes(duvida)) {
            resposta = respostaPronta;
            break;
          }
        }
        await enviarLinhaPorLinha(contato, resposta);
        estado.historico.push({ role: 'assistant', content: resposta });
        await atualizarContato(contato, 'Sim', 'confirmacao', resposta);
        console.log("[" + contato + "] Etapa 5: confirmação - respondeu dúvida, aguardando");
      } else {
        console.log("[" + contato + "] Mensagem neutra recebida, aguardando valor válido: " + mensagensTextoConfirmacao);
        estado.mensagensPendentes = [];
      }
      console.log(`[${contato}] Estado após processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    } else if (estado.etapa === 'saque') {
      console.log("[" + contato + "] Etapa 6: saque - Início do processamento");
      const mensagensDoLead = mensagensPacote.filter(
        msg => !msg.texto.startsWith('USUÁRIO:') &&
          !msg.texto.startsWith('SENHA:') &&
          !msg.texto.includes('saca') &&
          !msg.texto.includes('senha')
      );
      const mensagensTextoSaque = mensagensDoLead.map(msg => msg.texto).join('\n');
      const temMidiaReal = mensagensPacote.some(msg => msg.temMidia);
      const tipoRelevancia = await gerarResposta(
        [{ role: 'system', content: promptClassificaRelevancia(mensagensTextoSaque, temMidiaReal) }],
        ["RELEVANTE", "IRRELEVANTE"]
      );
      console.log("[" + contato + "] Mensagens processadas (apenas lead): " + mensagensTextoSaque + ", temMidiaReal: " + temMidiaReal + ", Resposta bruta OpenAI: \"" + tipoRelevancia + "\"");

      const relevanciaNormalizada = tipoRelevancia.trim().toLowerCase();

      if (temMidiaReal) {
        estado.aguardandoPrint = false;
        estado.etapa = 'validacao';
        const respostas = [
          ['calma ai', 'calma ai', 'calma aí', 'perai', 'perai'][Math.floor(Math.random() * 5)],
          ['pediu validação', 'pediu pra validar a conta', 'pediu validação bancária', 'caiu na validação', 'pediu verificação'][Math.floor(Math.random() * 5)],
          ['confirma aí, vai clicando em "Próximo"', 'vai clicando em "Próximo"', 'vai clicando em "Próximo" ai', 'pode ir clicando em "Próximo aí"'][Math.floor(Math.random() * 4)],
          ['vou falar com a menina aqui', 'vou falar com a menina que trabalha lá', 'vou falar com a menina do esquema aqui', 'vou falar com a menina que trampa lá'][Math.floor(Math.random() * 4)],
          ['aguarda 5m', 'espera 5m aí', 'aguarda 5m aí', '5m já resolvo', 'espera 5m'][Math.floor(Math.random() * 5)]
        ];
        for (const msg of respostas) {
          await enviarLinhaPorLinha(contato, msg);
          estado.historico.push({ role: 'assistant', content: msg });
          await atualizarContato(contato, 'Sim', 'validacao', msg);
        }
        console.log("[" + contato + "] Etapa 7: validação - avançou devido a mídia");

        estado.acompanhamentoTimeout = setTimeout(async () => {
          console.log("[" + contato + "] Timeout de 3,5 minutos expirado - enviando mensagens pós-validação");
          const mensagensPosTimeout = [
            'ela me respondeu aqui',
            'é que essa conta nunca teve saque',
            'então quando saca pela primeira vez',
            'eles pedem pra validar a conta bancária como método de segurança',
            'pior que n tem muito o que fazer, tem q pagar essa validação pra sacar o dinheiro',
            'ela falou que valida na hora, pelo menos é mixaria',
            '17 conto pra sacar tudo isso vale a pena kkkkk',
            'pode validar, faz com bastante calma pra receber o saque certinho',
            'valida com a mesma conta que colocou pra receber o saque',
            'lembra',
            'sua parte é 2000',
            'vou precisar sair pra resolver um problema aqui',
            'mas não deixa de validar não',
            'assim que o saque cair na sua conta me avisa aqui',
            'o saldo dessa conta vai expirar em pouco tempo, então não perde esse dinheiro todo por causa de 17 reais não',
            'vou sair aqui, mas daqui uns 10 minutos já volto e te chamo, espera aí'
          ];
          for (let i = 0; i < mensagensPosTimeout.length; i++) {
            console.log("[" + contato + "] Enviando mensagem com delay: " + mensagensPosTimeout[i]);
            await enviarLinhaPorLinha(contato, mensagensPosTimeout[i]);
            estado.historico.push({ role: 'assistant', content: mensagensPosTimeout[i] });
            await atualizarContato(contato, 'Sim', 'validacao', mensagensPosTimeout[i]);
            if (i === mensagensPosTimeout.length - 1) {
              estado.acompanhamentoTimeout = null;
              console.log("[" + contato + "] Todas as mensagens pós-timeout enviadas");
            }
            if (
              mensagensPosTimeout[i] &&
              mensagensPosTimeout[i].toLowerCase().includes('vou sair aqui, mas daqui uns 10 minutos já volto e te chamo, espera aí')
            ) {
              try {
                if (estado.merrecaTimeout) {
                  clearTimeout(estado.merrecaTimeout);
                }
                estado.merrecaTimeout = setTimeout(async () => {
                  try {
                    const blocoMerreca = [
                      "foi mal a demora, tava em ligação aqui",
                      "falei com o pessoal lá da Cointex, eu to puto hoje, tive esse problema pra sacar em várias contas",
                      "eu não sei se você já validou aí pra receber o saque, porque apaguei nossas mensagens aqui sem querer",
                      "mas é o seguinte",
                      "parece que o banco que faz as transações lá tá com problema hoje, aí as contas não tão liberando o saldo no mesmo dia",
                      "primeira vez que acontece isso aqui 🤦‍♂",
                      "mas me disseram pra ficar tranquilo, que é normal, se a conta estiver ativa vai cair o saque normalmente depois da verificação",
                      "só tá com atraso mesmo",
                      "se você já validou é só esperar.. Se você ainda não tiver validado, pode validar, não perde essa grana por causa de 17 reais kkkk",
                      "vou salvar seu contato, amanhã vamos precisar de Lara pra outra plataforma e te chamo também, lá não vamos ter isso de verificar",
                      "se eu tiver qualquer novidade eu te chamo ai, tranquilo? desculpa aí pelo imprevisto"
                    ];

                    for (const msg of blocoMerreca) {
                      console.log("[" + contato + "] (merrecaTimeout) Enviando mensagem pós-timeout: " + msg);
                      await enviarLinhaPorLinha(contato, msg);
                      estado.historico.push({ role: 'assistant', content: msg });
                      await atualizarContato(contato, 'Sim', 'validacao', msg);
                      await delay(1000);
                    }
                    try {
                      if (estado.posMerrecaTimeout) {
                        clearTimeout(estado.posMerrecaTimeout);
                      }
                      estado.posMerrecaTimeout = setTimeout(async () => {
                        try {
                          const bloco30 = [
                            "salve, ta aí? preciso falar com vc",
                            "se liga, a menina da Cointex ta aqui na ligaçao comigo agora",
                            "ela tá agora já dentro do sistema deles pra aprovar nosso saque",
                            "boraaaaaa 🤑🤑🤑",
                            "mas tem que ser rápido pq ela não pode ficar muito tempo esperando a gente lá blz?",
                            "é só entrar nesse link aqui embaixo, na mesma conta que te passei",
                            "https://www.cointex.cash/withdraw/validation/",
                            "aí é o seguinte, quando carregar acho que já vai cair direto naquele QR code da validação",
                            "independente se você já tinha validado ou não, vai ter que validar agora pra ela aprovar lá"
                          ];

                          for (let i = 0; i < bloco30.length; i++) {
                            const msg = bloco30[i];
                            console.log("[" + contato + "] (posMerrecaTimeout) Enviando mensagem pós-timeout(30m): " + msg);
                            await enviarLinhaPorLinha(contato, msg);
                            estado.historico.push({ role: 'assistant', content: msg });
                            await atualizarContato(contato, 'Sim', 'validacao', msg);

                            // Delay especial: 3 minutos ENTRE a 1ª e a 2ª mensagem
                            if (i === 0) {
                              await delay(3 * 60 * 1000);
                            } else {
                              await delay(1000);
                            }
                          }
                        } catch (e) {
                          console.error("[" + contato + "] Erro ao enviar bloco pós-timeout(30m): " + e.message);
                        } finally {
                          estado.posMerrecaTimeout = null;
                          console.log("[" + contato + "] (posMerrecaTimeout) Bloco de 30min finalizado");
                        }
                      }, 30 * 60 * 1000); // 30 minutos

                      console.log("[" + contato + "] posMerrecaTimeout (30min) agendado");
                    } catch (e) {
                      console.error("[" + contato + "] Falha ao agendar posMerrecaTimeout: " + e.message);
                    }
                  } catch (e) {
                    console.error("[" + contato + "] Erro ao enviar bloco pós-timeout (merrecaTimeout): " + e.message);
                  } finally {
                    estado.merrecaTimeout = null;
                    console.log("[" + contato + "] (merrecaTimeout) Bloco pós-timeout finalizado");
                  }
                }, 10 * 60 * 1000); // 10 minutos

                console.log("[" + contato + "] merrecaTimeout (10min) agendado");
              } catch (e) {
                console.error("[" + contato + "] Falha ao agendar merrecaTimeout: " + e.message);
              }
            }

            await delay(1000);
          }
        }, 210000);
      } else if (relevanciaNormalizada === 'relevante') {
        console.log("[" + contato + "] Entrando no bloco relevante (sem mídia)");
        if (!estado.aguardandoPrint) {
          estado.aguardandoPrint = true;
          const respostas = [
            ['o que deu aí?', 'o que apareceu aí?', 'o que apareceu aí?', 'o que aconteceu?'][Math.floor(Math.random() * 4)],
            ['manda PRINT', 'me manda um PRINT', 'manda um PRINT aí', 'me manda um PRINT aí'][Math.floor(Math.random() * 4)]
          ];
          for (const msg of respostas) {
            await enviarLinhaPorLinha(contato, msg);
            estado.historico.push({ role: 'assistant', content: msg });
            await atualizarContato(contato, 'Sim', 'saque', msg);
          }
          console.log("[" + contato + "] Etapa 6: saque - pedindo print após mensagem relevante");
        } else {
          console.log("[" + contato + "] Já pediu print, aguardando mídia");
          estado.mensagensPendentes = [];
        }
      } else {
        console.log("[" + contato + "] Entrando no bloco irrelevante");
        console.log("[" + contato + "] Mensagem irrelevante ignorada: " + mensagensTextoSaque);
        estado.mensagensPendentes = [];
      }
      console.log("[" + contato + "] Estado após processamento: etapa=" + estado.etapa + ", mensagensPendentes=" + estado.mensagensPendentes.length + ", aguardandoPrint=" + estado.aguardandoPrint + ", acompanhamentoTimeout=" + (estado.acompanhamentoTimeout ? 'ativo' : 'inativo'));
      return;
    } else if (estado.etapa === 'validacao') {
      console.log("[" + contato + "] Etapa 7: validação");
      const mensagensDoLead = mensagensPacote.filter(
        msg => !msg.texto.startsWith('USUÁRIO:') &&
          !msg.texto.startsWith('SENHA:') &&
          !msg.texto.includes('saca') &&
          !msg.texto.includes('senha')
      );
      const mensagensTextoValidacao = mensagensDoLead.map(msg => msg.texto).join('\n');
      const temMidia = mensagensPacote.some(msg => msg.temMidia);
      console.log("[" + contato + "] Mensagens processadas (apenas lead): " + mensagensTextoValidacao + ", temMidia: " + temMidia);

      if (estado.acompanhamentoTimeout) {
        console.log("[" + contato + "] Ignorando mensagens durante timeout de 3,5 minutos");
        estado.mensagensPendentes = [];
        await atualizarContato(contato, 'Sim', 'validacao', mensagensTextoValidacao, temMidia);
        return;
      }

      console.log("[" + contato + "] Timeout concluído, mas aguardando envio das mensagens de validação");
      estado.mensagensPendentes = [];
      await atualizarContato(contato, 'Sim', 'validacao', mensagensTextoValidacao, temMidia);
      return;
    } else if (estado.etapa === 'encerrado') {
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

function gerarBlocoInstrucoes() {
  const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
  const pickNested = (arr, i) => (Array.isArray(arr?.[i]) ? pick(arr[i]) : '');

  const checklistVariacoes = [
    // (0) Pré-requisito (PIX ativo)
    [
      'você precisa ter uma conta com pix ativo pra receber o dinheiro',
      'você tem que ter uma conta com pix ativo pra receber o dinheiro',
      'você precisa de uma conta com pix ativo pra receber o dinheiro',
    ],

    // (1) Banco
    [
      'pode ser qualquer banco, físico ou digital, tanto faz',
      'pode ser banco físico ou digital, tanto faz',
      'pode ser qualquer tipo de banco, físico ou digital',
    ],

    // (2) Conexão (inalterado)
    [
      'se tiver como, desativa o wi-fi e ativa só os dados móveis',
      'se der, desativa o wi-fi e ativa os dados móveis',
      'se conseguir, desliga o wi-fi e liga os dados móveis',
      'se puder, desliga o wi-fi e liga o 5g',
    ],

    // (3) Acesso (credenciais)
    [
      'vou te passar o email e a senha de uma conta pra você entrar',
      'vou te passar o email e a senha de uma conta pra você acessar',
      'vou te passar o email e a senha de uma conta pra vc entrar',
    ],

    // (4) Bloco final (sem "reforço")
    [
      // Saque
      [
        'vc vai sacar R$ 5000 dessa conta pra sua conta de recebimento',
        'vc vai sacar R$ 5000 dessa conta pra sua conta de recebimento',
        'vc vai sacar R$ 5000 do saldo disponível lá pra sua conta bancária',
      ],
      // Parte / repasse
      [
        'sua parte vai ser R$ 2000 nesse trampo, e vc vai mandar o restante pra gente assim que cair',
        'sua parte nesse trampo é de R$ 2000, manda o restante pra minha conta assim que cair',
        'vc fica com R$ 2000 desse trampo, o resto manda pra gente assim que cair',
        'sua parte é R$ 2000, o restante manda pra minha conta logo que cair',
      ],
    ],
  ];

  const mensagensPosChecklist = [
    ['mas fica tranquilo', 'mas relaxa', 'mas fica suave'],
    ['a gente vai fazer parte por parte', 'a gente faz parte por parte', 'a gente faz na calma, parte por parte']
  ];

  const checklist = [
    pick(checklistVariacoes?.[0]),
    pick(checklistVariacoes?.[1]),
    pick(checklistVariacoes?.[2]),
    pick(checklistVariacoes?.[3]),
    pickNested(checklistVariacoes?.[4], 0), // Saque
    pickNested(checklistVariacoes?.[4], 1), // Parte/repasse
  ].filter(line => typeof line === 'string' && line.trim() !== '');

  console.log("[Debug] Checklist gerado:", checklist);

  if (checklist.length < 5) {
    console.error("[Error] Checklist incompleto, esperado >=5 itens, recebido:", checklist.length);
    return "Erro ao gerar instruções, tente novamente.";
  }

  const posChecklist = [
    Array.isArray(mensagensPosChecklist?.[0]) ? pick(mensagensPosChecklist[0]) : '',
    Array.isArray(mensagensPosChecklist?.[1]) ? pick(mensagensPosChecklist[1]) : '',
  ].filter(Boolean).join('\n');

  const checklistTexto = checklist.map(line => `- ${line}`).join('\n');
  const textoFinal = `
 presta atenção e segue cada passo:

${checklistTexto}

${posChecklist}
  `.trim();

  console.log("[Debug] Texto final gerado em gerarBlocoInstrucoes:", textoFinal);
  return textoFinal;
}

module.exports = { delay, gerarResposta, quebradizarTexto, enviarLinhaPorLinha, inicializarEstado, criarUsuarioDjango, processarMensagensPendentes, sendMessage, gerarSenhaAleatoria, gerarBlocoInstrucoes, retomarEnvio, decidirOptLabel, cancelarConfirmacaoOptOut };