const axios = require('axios');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { getActiveTransport } = require('./lib/transport');
const { atualizarContato, getBotSettings, pool, getContatoByPhone } = require('./db');
const {
  promptClassificaAceite,
  promptClassificaAcesso,
  promptClassificaConfirmacao,
  promptClassificaRelevancia,
  promptClassificaOptOut,
  promptClassificaReoptin
} = require('./prompts.js');

const estadoContatos = require('./state.js');

// ==== Timings ====
const EXTRA_FIRST_REPLY_BASE_MS = 45000;
const EXTRA_FIRST_REPLY_JITTER_MS = 10000;
const GLOBAL_PER_MSG_BASE_MS = 3000;
const GLOBAL_PER_MSG_JITTER_MS = 1500;

// ==== Utils ====
const crypto = require('crypto');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => (Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '');
const textHash = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');
const toUpperSafe = (x) => String(x || '').trim().toUpperCase();

// marca simples de envio (para trechos de fallback)
function markSent(st, key) {
  st.sentKeys = st.sentKeys || {};
  st.sentKeys[key] = true;
}

// ==== Opt-out / Reopt-in config (mantidos) ====
const OPTOUT_RX = /\b(pare|para(?!\w)|parar|não quero|nao quero|me remove|remova|me tira|me exclui|excluir|cancelar|unsubscribe|cancel|stop|parem|não mandar|nao mandar)\b/i;

const MAX_OPTOUTS = 3;
const OPTOUT_MSGS = {
  1: 'tranquilo, não vou mais te mandar mensagem. qualquer coisa só chamar',
  2: 'de boa, vou passar o trampo pra outra pessoa e não te chamo mais. não me manda mais mensagem',
};

// ==== Estado Inicial (LIMPO) ====
function inicializarEstado(contato, tid = '', click_type = 'Orgânico') {
  estadoContatos[contato] = {
    etapa: 'abertura',
    primeiraRespostaPendente: true,
    historico: [],
    ultimaMensagem: Date.now(),

    // flags abertura
    aberturaConcluida: false,
    aberturaMsgEnviada: false,

    // controle de envio
    enviandoMensagens: false,
    mensagensPendentes: [],
    cancelarEnvio: false,
    paused: false,

    // sequência linha-a-linha
    seqLines: null,
    seqIdx: 0,

    // anti-duplicação por contato
    lastSentHash: null,

    // metadados
    tid,
    click_type,
  };

  atualizarContato(contato, 'Sim', 'abertura');
  console.log(`[${contato}] Estado inicializado e contato atualizado: Sim, abertura. TID: ${tid}, click_type: ${click_type}`);
}

// ==== DB helpers mantidos (otimizados) ====
async function setDoNotContact(contato, value = true) {
  try {
    await pool.query('UPDATE contatos SET do_not_contact = $2 WHERE id = $1', [contato, !!value]);
    console.log(`[${contato}] do_not_contact atualizado para ${!!value}`);
    if (!value) cancelarConfirmacaoOptOut(contato);
  } catch (e) {
    console.error(`[${contato}] Falha ao setar do_not_contact: ${e.message}`);
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

    await pool.query(
      `
      UPDATE contatos
         SET do_not_contact = TRUE,
             do_not_contact_at = NOW(),
             do_not_contact_reason = $2,
             opt_out_count = $3,
             permanently_blocked = $4
       WHERE id = $1
      `,
      [contato, String(reasonText || '').slice(0, 200), next, permanently]
    );

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
        estadoContatos[contato].paused = false;
        delete estadoContatos[contato].seqLines;
        delete estadoContatos[contato].seqIdx;
      } else {
        estadoContatos[contato].paused = true;
      }
    }

    if (!permanently) {
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
      // 2) IA (mantido)
      const out = await gerarResposta([{ role: 'system', content: promptClassificaOptOut(texto) }], ['OPTOUT', 'CONTINUAR']);
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

// ==== LLM helpers (mantidos) ====
function normalizeAllowedLabels(allowedLabels) {
  if (Array.isArray(allowedLabels)) return allowedLabels.map(toUpperSafe).filter(Boolean);
  if (typeof allowedLabels === 'string') return allowedLabels.split(/[|,]/).map(toUpperSafe).filter(Boolean);
  return [];
}
function pickValidLabel(text, allowed) {
  if (!allowed.length) return null;
  const first = String(text || '').trim().split(/\s+/)[0];
  const u = toUpperSafe(first);
  return allowed.includes(u) ? u : null;
}
function extractJsonLabel(outputText, allowed) {
  try {
    const obj = JSON.parse(outputText || '{}');
    return pickValidLabel(obj.label, allowed);
  } catch {
    return null;
  }
}

async function gerarResposta(messages, allowedLabels) {
  const allow = normalizeAllowedLabels(allowedLabels || []);
  const DEFAULT_LABEL = allow.includes('CONTINUAR') ? 'CONTINUAR' : allow[0] || 'UNKNOWN';

  try {
    const promptStr = messages.map((m) => m.content).join('\n');

    const promptJson = `${promptStr}

Retorne estritamente JSON, exatamente neste formato:
{"label":"${allow.join('|').toLowerCase()}"}`;

    let res = await openai.responses.create({
      model: 'gpt-5',
      input: promptJson,
      max_output_tokens: 24
    });

    let outText = String(res.output_text || '').trim();
    let label = extractJsonLabel(outText, allow);

    if (!label) {
      res = await openai.responses.create({
        model: 'gpt-5',
        input: `${promptStr}\n\nResponda APENAS com UMA palavra válida: ${allow.join('|')}`,
        max_output_tokens: 24
      });
      const raw = String(res.output_text || '').trim();
      label = pickValidLabel(raw, allow);
    }

    return label || DEFAULT_LABEL;
  } catch (err) {
    console.error('[OpenAI] Erro:', err?.message || err);
    return DEFAULT_LABEL;
  }
}

async function decidirOptLabel(texto) {
  const raw = String(texto || '').trim();

  const HARD_STOP =
    /\b(?:stop|unsubscribe|remover|remova|remove|excluir|exclui(?:r)?|cancelar|cancela|cancelamento|para(?!\w)|parem|pare|nao quero|não quero|não me chame|nao me chame|remove meu número|remova meu numero|golpe|golpista|crime|criminoso|denunciar|denúncia|policia|polícia|federal|civil)\b/i;

  if (HARD_STOP.test(raw)) return 'OPTOUT';

  const norm = raw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const RE_PHRASES = [
    'mudei de ideia',
    'quero fazer',
    'quero sim',
    'vou querer sim',
    'pode continuar',
    'pode seguir',
    'pode mandar',
    'pode prosseguir',
    'pode enviar',
    'vamos',
    'vamo',
    'bora',
    'to dentro',
    'tô dentro',
    'topo',
    'fechou',
    'fechado',
    'partiu',
    'segue'
  ];
  if (RE_PHRASES.some((p) => norm.includes(p))) return 'REOPTIN';

  try {
    const r1 = await gerarResposta([{ role: 'system', content: promptClassificaOptOut(raw) }], ['OPTOUT', 'CONTINUAR']);
    if (String(r1 || '').trim().toUpperCase() === 'OPTOUT') return 'OPTOUT';
  } catch {}

  try {
    const r2 = await gerarResposta([{ role: 'system', content: promptClassificaReoptin(raw) }], ['REOPTIN', 'CONTINUAR']);
    if (String(r2 || '').trim().toUpperCase() === 'REOPTIN') return 'REOPTIN';
  } catch {}

  return 'CONTINUAR';
}

// ==== Linha-a-linha (injeta selo/opt-out na 1ª resposta da abertura) ====
async function enviarLinhaPorLinha(to, texto) {
  const estado = estadoContatos[to];
  if (!estado) {
    console.log(`[${to}] Erro: Estado não encontrado em enviarLinhaPorLinha`);
    return;
  }

  // Bloqueios DB
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

  // Selo de identidade + opt-out hint na 1ª resposta da abertura
  try {
    const isFirstResponse = estado.etapa === 'abertura' && !estado.aberturaConcluida;
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

      const optHintEnabled = settings?.optout_hint_enabled !== false;
      const suffix = (settings?.optout_suffix || '· se não quiser: NÃO QUERO').trim();
      if (optHintEnabled && suffix) {
        const linhasTmp = String(texto).split('\n');
        let idx = linhasTmp.length - 1;
        while (idx >= 0 && !linhasTmp[idx].trim()) idx--;
        if (idx >= 0 && !linhasTmp[idx].includes(suffix)) {
          linhasTmp[idx] = `${linhasTmp[idx]} ${suffix}`;
          texto = linhasTmp.join('\n');
        }
      }
    }
  } catch (e) {
    console.error('[Selo/OptOutHint] Falha ao preparar label/sufixo:', e.message);
  }

  // Pacing inicial
  console.log(`[${to}] Iniciando envio de mensagem: "${texto}"`);
  await delay(10000);

  const linhas = String(texto)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // snapshot da sequência
  const joined = linhas.join('\n');
  if (!Array.isArray(estado.seqLines) || estado.seqLines.join('\n') !== joined) {
    estado.seqLines = linhas.slice();
    estado.seqIdx = 0;
  }

  for (let i = estado.seqIdx || 0; i < estado.seqLines.length; i++) {
    if (estado.cancelarEnvio || estado.paused) {
      console.log(`[${to}] Loop interrompido: cancelarEnvio/paused=true.`);
      estado.enviandoMensagens = false;
      return;
    }

    // Rechecar bloqueio entre linhas
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

    const linha = estado.seqLines[i];
    await delay(Math.max(500, Math.min(3000, linha.length * 30)));
    await sendMessage(to, linha); // anti-duplicação está dentro de sendMessage
    estado.seqIdx = i + 1;
    if (i < estado.seqLines.length - 1) await delay(7000 + Math.floor(Math.random() * 1000));
  }

  delete estado.seqLines;
  delete estado.seqIdx;
  estado.paused = false;
}

// ==== Transporte ====
async function sendManychatBatch(phone, textOrLines) {
  const settings = await getBotSettings().catch(() => ({}));
  const token = process.env.MANYCHAT_API_TOKEN || process.env.MANYCHAT_API_KEY || settings.manychat_api_token;
  if (!token) throw new Error('ManyChat: token ausente');

  const contato = await getContatoByPhone(phone).catch(() => null);
  const subscriberId = contato?.manychat_subscriber_id || estadoContatos[phone]?.manychat_subscriber_id || null;
  if (!subscriberId) {
    console.warn(`[ManyChat] subscriberId ausente para ${phone} — pulando envio externo (simulação/local).`);
    return { ok: true, skipped: true, reason: 'no-subscriber' };
    }
  const payloadItems = Array.isArray(textOrLines) ? textOrLines.map((s) => String(s)) : [String(textOrLines)];
  const messages = payloadItems.slice(0, 10).map((t) => ({ type: 'text', text: t }));
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
    return await postMC('/fb/sending/sendContent', basePayload, 'sendContent/fb');
  } catch (e) {
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
    try {
      text = text();
    } catch (e) {
      text = String(text);
    }
  }

  // ======== ANTI-DUPLICAÇÃO (por contato) ========
  try {
    const stDedupe = estadoContatos[to] || (estadoContatos[to] = {});
    const textStr = Array.isArray(text) ? text.join('\n') : String(text);
    const h = textHash(textStr.trim());
    if (stDedupe.lastSentHash === h) {
      console.log(`[${to}] Skip envio duplicado.`);
      return { skipped: true, reason: 'duplicate' };
    }
    stDedupe.lastSentHash = h;
  } catch (e) {
    console.error('[Dedupe] falha:', e.message);
  }
  // ===============================================

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

// ==== Credenciais na Cointex (mantido) ====
async function criarUsuarioDjango(contato) {
  const DJANGO_API_URL = process.env.DJANGO_API_URL || 'https://www.cointex.cash/api/create-user/';

  const st = estadoContatos[contato] || {};
  const tid = st.tid || '';
  const click_type = st.click_type || 'Orgânico';

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

      const retriable500 =
        resp.status === 500 && typeof resp.data?.message === 'string' && /cannot access local variable 'phone_number'/i.test(resp.data.message);

      if (retriable500) {
        await delay(250 + Math.floor(Math.random() * 750));
        continue;
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
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[${contato}] Erro na API Django (tentativa ${attempt}/${MAX_TRIES}): ${err.message}`);
      await delay(300 + Math.floor(Math.random() * 900));
    }
  }

  if (lastErr) {
    console.error(`[${contato}] Falha definitiva ao criar usuário na Cointex: ${lastErr.message}`);
  }
}

// ==== Retomada simples (mantida e enxuta) ====
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
    console.log(`[${contato}] Nada para retomar (sequência concluída).`);
    return false;
  }

  await delay(rand(10000, 15000));

  try {
    const { rows } = await pool.query('SELECT opt_out_count FROM contatos WHERE id = $1 LIMIT 1', [contato]);
    const count = rows?.[0]?.opt_out_count || 0;

    let retomadaMsg = null;
    if (count === 1) retomadaMsg = 'certo, vamos continuar então';
    else if (count >= 2) retomadaMsg = 'última chance, se não for fazer já me avisa pq não posso ficar perdendo tempo não, vou tentar continuar de novo aqui, vamos lá';

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
  return true;
}

// ==== Abertura (padrão único para etapas) ====
function createAberturaMsg() {
  const g1 = ['salve', 'opa', 'e aí', 'fala'];
  const g2 = ['tô precisando de alguém pro trampo agora', 'tenho vaga pra um trampo agora'];
  const g3 = ['tá disponível?', 'bora?', 'consegue?'];
  return `${pick(g1)}, ${pick(g2)}, ${pick(g3)}`;
}

async function handleAbertura(contato, estado, mensagensPacote) {
  // Envia mensagem única de abertura (selo/opt-out via enviarLinhaPorLinha)
  if (!estado.aberturaMsgEnviada) {
    const msg = createAberturaMsg();
    await enviarLinhaPorLinha(contato, msg);
    try {
      estado.historico?.push?.({ role: 'assistant', content: msg });
      await atualizarContato(contato, 'Sim', 'abertura', msg);
    } catch (e) {
      console.error('[Abertura] Falha ao logar:', e.message);
    }
    estado.aberturaMsgEnviada = true;
    estado.aberturaConcluida = true;
  }

  // Chegou qualquer mensagem do usuário? Avança etapa (iremos implementar depois)
  if (Array.isArray(mensagensPacote) && mensagensPacote.length > 0) {
    estado.etapa = 'interesse';
    estado.primeiraRespostaPendente = false;
    try {
      await atualizarContato(contato, 'Sim', 'interesse', '[Avanço automático após abertura]');
    } catch {}
    console.log(`[${contato}] Avanço automático para 'interesse'`);
  }
}

// ==== Processamento principal (com mesma assinatura) ====
async function processarMensagensPendentes(contato) {
  let estado;
  try {
    estado = estadoContatos[contato];

    // timeouts externos (se existirem, respeita)
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

    console.log(
      `[${contato}] etapa=${estado.etapa} aberturaConcluida=${estado.aberturaConcluida} msgAbertura=${estado.aberturaMsgEnviada}`
    );

    const mensagensPacote = Array.isArray(estado.mensagensPendentes) ? estado.mensagensPendentes.splice(0) : [];

    // DNC curto-circuito: reoptin permitido
    const { rows: dncRows } = await pool.query('SELECT do_not_contact FROM contatos WHERE id = $1 LIMIT 1', [contato]);
    const dnc = !!dncRows?.[0]?.do_not_contact;
    if (dnc) {
      const labels = await Promise.all(mensagensPacote.map((m) => decidirOptLabel(m.texto || '')));
      if (labels.some((l) => l === 'REOPTIN')) {
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

    // sem novas mensagens e nada a enviar
    if (mensagensPacote.length === 0 && estado.aberturaMsgEnviada && estado.aberturaConcluida) {
      console.log(`[${contato}] Nenhuma mensagem nova para processar`);
      return;
    }

    // opt-out global (mantido)
    if (await checarOptOutGlobal(contato, mensagensPacote.map((m) => m.texto))) {
      await atualizarContato(contato, 'Sim', 'encerrado', '[OPTOUT]');
      return;
    }

    // === ETAPAS (padrão) === //
    if (estado.etapa === 'abertura') {
      console.log(`[${contato}] Processando etapa abertura`);
      await handleAbertura(contato, estado, mensagensPacote);
      return;
    }

    // (Futuras etapas seguirão o mesmo padrão de handler)
    console.log(`[${contato}] Etapa atual (${estado.etapa}) ainda não implementada neste arquivo simplificado.`);

  } catch (error) {
    console.error(`[${contato}] Erro em processarMensagensPendentes: ${error.message}`);
    if (estadoContatos[contato]) {
      estadoContatos[contato].mensagensPendentes = [];
    }
    const mensagem = 'vou ter que sair aqui, daqui a pouco te chamo';
    if (!estadoContatos[contato]?.sentKeys?.['erro.fallback']) {
      await enviarLinhaPorLinha(contato, mensagem);
      markSent(estadoContatos[contato], 'erro.fallback');
      await atualizarContato(contato, 'Sim', estadoContatos[contato]?.etapa || 'erro', mensagem);
    }
  } finally {
    try {
      if (estadoContatos[contato]) {
        estadoContatos[contato].enviandoMensagens = false;
        if (Array.isArray(estadoContatos[contato].mensagensPendentes) && estadoContatos[contato].mensagensPendentes.length > 0) {
          setImmediate(() => processarMensagensPendentes(contato).catch(console.error));
        }
      }
    } catch (e) {
      console.error(e);
    }
  }
}

// ==== Miscelânea ====
function gerarSenhaAleatoria() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ==== Exports (mantidos) ====
module.exports = {
  delay,
  gerarResposta,
  enviarLinhaPorLinha,
  inicializarEstado,
  criarUsuarioDjango,
  processarMensagensPendentes,
  sendMessage,
  gerarSenhaAleatoria,
  retomarEnvio,
  decidirOptLabel,
  cancelarConfirmacaoOptOut
};
