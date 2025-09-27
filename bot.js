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
const OPTOUT_RX = /\b(pare|para(?!\w)|parar|nÃ£o quero|nao quero|me remove|remova|me tira|me exclui|excluir|cancelar|unsubscribe|cancel|stop|parem|nÃ£o mandar|nao mandar)\b/i;

const MAX_OPTOUTS = 3;
const OPTOUT_MSGS = {
  1: 'tranquilo, nÃ£o vou mais te mandar mensagem. qualquer coisa sÃ³ chamar',
  2: 'de boa, vou passar o trampo pra outra pessoa e nÃ£o te chamo mais. nÃ£o me manda mais mensagem',
};

const crypto = require('crypto');

// --- Outbox (idempotência) ---
async function ensureOutboxSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outbox (
      id BIGSERIAL PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      contato_id TEXT NOT NULL,
      etapa TEXT NOT NULL,
      linha_idx INTEGER NOT NULL DEFAULT 0,
      texto_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent'
      provider_msg_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS outbox_contato_idx ON outbox (contato_id);
  `);
}
ensureOutboxSchema().catch(err => console.error('[outbox] schema:', err.message));

function normalizeTextForKey(s = '') {
  return String(s).trim().replace(/\s+/g, ' ');
}
function buildDedupeKey({ to, etapa, linhaIdx = 0, text }) {
  const payload = normalizeTextForKey(text || '');
  const base = `${to}|${etapa}|${linhaIdx}|${payload}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}

async function beginSendOnce(to, text, { linhaIdx = 0 } = {}) {
  const etapa = (estadoContatos[to]?.etapa) || 'desconhecida';
  const textoNorm = normalizeTextForKey(text);
  const textoHash = crypto.createHash('sha256').update(textoNorm).digest('hex');
  const dedupeKey = buildDedupeKey({ to, etapa, linhaIdx, text: textoNorm });

  // Reserva o envio (bloqueia duplicatas concorrentes)
  const res = await pool.query(
    `INSERT INTO outbox (dedupe_key, contato_id, etapa, linha_idx, texto_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [dedupeKey, to, etapa, linhaIdx, textoHash]
  );
  if (res.rowCount === 0) {
    return { allowed: false, dedupeKey };
  }
  return { allowed: true, dedupeKey, etapa, linhaIdx };
}

async function commitSendOnce(dedupeKey, providerMsgId = null) {
  await pool.query(
    `UPDATE outbox SET status = 'sent', provider_msg_id = COALESCE($2, provider_msg_id)
     WHERE dedupe_key = $1`,
    [dedupeKey, providerMsgId]
  );
}

async function rollbackSendOnce(dedupeKey) {
  await pool.query(
    `DELETE FROM outbox WHERE dedupe_key = $1 AND status = 'pending'`,
    [dedupeKey]
  );
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
      // agenda confirmaÃ§Ã£o CANCELÃVEL
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

  console.log(`[${contato}] Opt-out concluÃ­do (${permanently ? 'permanente' : 'temporÃ¡rio'}).`);
}

async function checarOptOutGlobal(contato, mensagens) {
  try {
    const arr = Array.isArray(mensagens) ? mensagens : [String(mensagens || '')];

    for (const txt of arr) {
      const texto = String(txt || '').trim();
      // 1) regex rÃ¡pido
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
    console.log(`[${contato}] ConfirmaÃ§Ã£o de opt-out pendente CANCELADA.`);
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
    console.log(`[${contato}] Nada para retomar (sequÃªncia jÃ¡ concluÃ­da).`);
    return false;
  }

  // mesmo delay das mensagens de opt-out (10â€“15s)
  await delay(rand(10000, 15000));

  // 1Âª retomada => msg curta; 2Âª retomada => aviso "Ãºltima chance"
  // usa opt_out_count do DB para decidir
  try {
    const { rows } = await pool.query(
      'SELECT opt_out_count FROM contatos WHERE id = $1 LIMIT 1',
      [contato]
    );
    const count = rows?.[0]?.opt_out_count || 0;

    let retomadaMsg = null;
    if (count === 1) {
      retomadaMsg = 'certo, vamos continuar entÃ£o';
    } else if (count >= 2) {
      retomadaMsg = 'Ãºltima chance, se nÃ£o for fazer jÃ¡ me avisa pq nÃ£o posso ficar perdendo tempo nÃ£o, vou tentar continuar de novo aqui, vamos lÃ¡';
    }

    if (retomadaMsg) {
      await sendMessage(contato, retomadaMsg);
      try {
        // registra no histÃ³rico com a etapa atual (ou "retomada" se nÃ£o houver)
        await atualizarContato(contato, 'Sim', st.etapa || 'retomada', retomadaMsg);
        st.historico?.push?.({ role: 'assistant', content: retomadaMsg });
      } catch (e) {
        console.error(`[${contato}] Falha ao logar mensagem de retomada: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[${contato}] Falha ao buscar opt_out_count para retomada: ${e.message}`);
  }

  // limpar flags e continuar a partir da prÃ³xima linha
  st.cancelarEnvio = false;
  st.paused = false;

  // reutiliza o mesmo mecanismo, passando apenas as linhas restantes
  await enviarLinhaPorLinha(contato, remaining);
  if (!st.seqLines && st.seqKind === 'credenciais') {
    st.credenciaisEntregues = true;
    st.seqKind = null;
    console.log(`[${contato}] Credenciais concluÃ­das na retomada.`);
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
      max_output_tokens: 24  // (mÃ­nimo aceito Ã© 16)
      // nÃ£o envie temperature/top_p/stop (snapshots do gpt-5 podem rejeitar)
    });

    let outText = String(res.output_text || "").trim();
    let label = extractJsonLabel(outText, allow);

    // 2) Fallback: se nÃ£o for JSON vÃ¡lido, peÃ§a 1 palavra e valide
    if (!label) {
      res = await openai.responses.create({
        model: "gpt-5",
        input: `${promptStr}\n\nResponda APENAS com UMA palavra vÃ¡lida: ${allow.join("|")}`,
        max_output_tokens: 24
      });
      const raw = String(res.output_text || "").trim();
      label = pickValidLabel(raw, allow);
    }

    return label || DEFAULT_LABEL;
  } catch (err) {
    console.error("[OpenAI] Erro:", err?.message || err);
    return DEFAULT_LABEL; // nÃ£o quebra seu fluxo
  }
}

async function decidirOptLabel(texto) {
  const raw = String(texto || '').trim();

  const HARD_STOP = /\b(?:stop|unsubscribe|remover|remova|remove|excluir|exclui(?:r)?|cancelar|cancela|cancelamento|para(?!\w)|parem|pare|nao quero|nÃ£o quero|nÃ£o me chame|nao me chame|remove meu nÃºmero|remova meu numero|golpe|golpista|crime|criminoso|denunciar|denÃºncia|policia|polÃ­cia|federal|civil)\b/i;

  if (HARD_STOP.test(raw)) return 'OPTOUT';

  // Fast-path de retomada para frases batidas (nÃ£o substitui a IA; sÃ³ agiliza)
  const norm = raw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const RE_PHRASES = [
    'mudei de ideia', 'quero fazer', 'quero sim', 'vou querer sim',
    'pode continuar', 'pode seguir', 'pode mandar', 'pode prosseguir', 'pode enviar',
    'vamos', 'vamo', 'bora', 'to dentro', 'tÃ´ dentro', 'topo', 'fechou', 'fechado', 'partiu', 'segue'
  ];
  if (RE_PHRASES.some(p => norm.includes(p))) return 'REOPTIN';

  // 1) seu prompt de OPT-OUT (com todas as palavras que vocÃª exigiu)
  try {
    const r1 = await gerarResposta(
      [{ role: 'system', content: promptClassificaOptOut(raw) }],
      ['OPTOUT', 'CONTINUAR']
    );
    if (String(r1 || '').trim().toUpperCase() === 'OPTOUT') return 'OPTOUT';
  } catch { }

  // 2) nÃ£o sendo opt-out â†’ seu prompt de RE-OPT-IN
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
  return resposta.replace(/\b(vocÃª|vcÃª|cÃª|ce)\b/gi, 'vc');
}

function gerarSenhaAleatoria() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function enviarLinhaPorLinha(to, texto) {
  const estado = estadoContatos[to];
  if (!estado) {
    console.log(`[${to}] Erro: Estado nÃ£o encontrado em enviarLinhaPorLinha`);
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

  // Selo de identidade (apenas na 1Âª resposta da abertura)
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
        if (pieces.length) label = `Suporte â€¢ ${pieces.join(' | ')}`;
      }

      if (enabled && label) {
        texto = `${label}\n${texto}`;
      }
    }
  } catch (e) {
    console.error('[SeloIdent] Falha ao avaliar/preparar label:', e.message);
  }

  // Sufixo de opt-out (apenas na 1Âª resposta da abertura)
  try {
    const isFirstResponse = (estado.etapa === 'abertura' && !estado.aberturaConcluida);
    if (isFirstResponse) {
      const settings = await getBotSettings().catch(() => null);
      const optHintEnabled = settings?.optout_hint_enabled !== false; // default ON
      const suffix = (settings?.optout_suffix || 'Â· se nÃ£o quiser: NÃƒO QUERO').trim();

      if (optHintEnabled && suffix) {
        const linhasTmp = texto.split('\n');
        // pega a Ãºltima linha nÃ£o-vazia
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

  // Envio linha a linha com memÃ³ria de progresso (seqLines/seqIdx)
  estado.enviandoMensagens = true;
  console.log(`[${to}] Iniciando envio de mensagem: "${texto}"`);

  await delay(10000); // pacing inicial

  const linhas = texto.split('\n').filter(line => line.trim() !== '');

  // snapshot da sequÃªncia no estado (sÃ³ recria se o conteÃºdo mudou)
  if (!Array.isArray(estado.seqLines) || estado.seqLines.join('\n') !== linhas.join('\n')) {
    estado.seqLines = linhas.slice();
    estado.seqIdx = 0; // comeÃ§a do inÃ­cio desta sequÃªncia
  }

  for (let i = estado.seqIdx || 0; i < estado.seqLines.length; i++) {
    const linha = estado.seqLines[i];
    try {
      // ðŸ›‘ checkpoints de cancelamento/pausa
      if (estado.cancelarEnvio || estado.paused) {
        console.log(`[${to}] Loop interrompido: cancelarEnvio/paused=true.`);
        estado.enviandoMensagens = false;
        return; // mantÃ©m seqIdx para retomar
      }

      // ðŸ›‘ rechecar bloqueio entre linhas (DNC/limite)
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
      await sendMessage(to, linha, { linhaIdx: i });
      estado.seqIdx = i + 1; // avanÃ§ou uma linha
      await delay(7000 + Math.floor(Math.random() * 1000));
    } catch (error) {
      console.error(`[${to}] Erro ao enviar linha "${linha}": ${error.message}`);
      estado.enviandoMensagens = false;
      return;
    }
  }

  // sequÃªncia concluÃ­da â€” limpar snapshot
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
    console.warn(`[ManyChat] subscriberId ausente para ${phone} â€” pulando envio externo (simulaÃ§Ã£o/local).`);
    return { ok: true, skipped: true, reason: 'no-subscriber' };
  }

  const lines = Array.isArray(textOrLines)
    ? textOrLines
    : String(textOrLines).split('\n').map(s => s.trim()).filter(Boolean);
  const messages = lines.slice(0, 10).map(t => ({ type: 'text', text: t }));
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
    // âœ… SEMPRE usar o namespace /fb (mesmo pro WhatsApp)
    return await postMC('/fb/sending/sendContent', basePayload, 'sendContent/fb');
  } catch (e) {
    // Janela de 24h estourada â†’ usar Flow (template)
    const code = e.body?.code;
    const msg = (e.body?.message || '').toLowerCase();
    const is24h = code === 3011 || /24|window|tag/.test(msg);

    if (!is24h) throw e;

    const flowNs = settings.manychat_fallback_flow_id || process.env.MANYCHAT_FALLBACK_FLOW_ID;
    if (!flowNs) {
      throw new Error('ManyChat: fora da janela e MANYCHAT_FALLBACK_FLOW_ID nÃ£o configurado.');
    }

    const flowPayload = { subscriber_id: Number(subscriberId), flow_ns: flowNs };
    return await postMC('/fb/sending/sendFlow', flowPayload, 'sendFlow/fb');
  }
}

async function sendMessage(to, text, opts = {}) {
  const { bypassBlock = false } = opts;

  // pacing humano
  let extraWait = GLOBAL_PER_MSG_BASE_MS + Math.floor(Math.random() * GLOBAL_PER_MSG_JITTER_MS);
  const st = estadoContatos[to];
  if (st?.primeiraRespostaPendente) {
    extraWait += EXTRA_FIRST_REPLY_BASE_MS + Math.floor(Math.random() * EXTRA_FIRST_REPLY_JITTER_MS);
    st.primeiraRespostaPendente = false;
  }
  await delay(extraWait);

  // checagem de bloqueio no DB (pode pular com bypassBlock)
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

  const gate = await beginSendOnce(to, text, { linhaIdx: opts.linhaIdx ?? 0 });
  if (!gate.allowed) {
    return { skipped: true, reason: 'duplicate' };
  }

  const { mod: transport, settings } = await getActiveTransport();

  if (transport.name === 'manychat') {
    const lines = Array.isArray(text)
      ? text
      : String(text).split('\n').map(s => s.trim()).filter(Boolean);

    try {
      const res = await sendManychatBatch(to, lines);
      await commitSendOnce(gate.dedupeKey, res?.message_id || res?.id || null);
      return res;
    } catch (e) {
      await rollbackSendOnce(gate.dedupeKey);
      throw e;
    }
  }

  if (transport.name === 'twilio') {
    const sanitized = to.replace(/^whatsapp:/, '');
    try {
      const res = await transport.sendText({ to: sanitized, text }, settings);
      await commitSendOnce(gate.dedupeKey, res?.sid || res?.messageId || null);
      return res;
    } catch (e) {
      await rollbackSendOnce(gate.dedupeKey);
      throw e;
    }
  }

  try {
    const res = await transport.sendText({ to, text }, settings);
    await commitSendOnce(gate.dedupeKey, res?.id || res?.message_id || null);
    return res;
  } catch (e) {
    await rollbackSendOnce(gate.dedupeKey);
    throw e;
  }
}

function inicializarEstado(contato, tid = '', click_type = 'OrgÃ¢nico') {
  estadoContatos[contato] = {
    etapa: 'abertura',
    primeiraRespostaPendente: true,
    historico: [],
    encerrado: false,
    ultimaMensagem: Date.now(),
    credenciais: null,
    credenciaisEntregues: false,
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
  try {
    const DJANGO_API_URL = process.env.DJANGO_API_URL || 'https://www.cointex.cash/api/create-user/';

    const st = estadoContatos[contato] || {};
    const tid = st.tid || '';
    const click_type = st.click_type || 'OrgÃ¢nico';

    // normaliza para E.164 com +
    const phone_e164 = /^\+/.test(contato) ? contato : `+${contato}`;

    const body = {
      tid,
      click_type,
      phone_number: phone_e164
    };

    console.log(`[${contato}] Enviando para API Cointex:`, JSON.stringify(body));

    const resp = await axios.post(DJANGO_API_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true
    });

    console.log(`[${contato}] Cointex HTTP ${resp.status}`, resp.data);

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
      console.log(`[${contato}] UsuÃ¡rio criado: ${u.email}`);
    } else {
      console.error(`[${contato}] Resposta inesperada da API Cointex: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    if (err.response) {
      console.error(`[${contato}] Erro na API Django: HTTP ${err.response.status} ${JSON.stringify(err.response.data)}`);
    } else {
      console.error(`[${contato}] Erro na API Django: ${err.message}`);
    }
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
      console.log("[" + contato + "] Lead em timeout atÃ© " + new Date(estado.encerradoAte).toLocaleTimeString());
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

      if (estado.aberturaConcluida && mensagensPacote.length > 0) {
        if (estado._timer2Abertura) { clearTimeout(estado._timer2Abertura); estado._timer2Abertura = null; }
        estado.etapa = 'interesse';
        await atualizarContato(contato, 'Sim', 'interesse');
        console.log(`[${contato}] Resposta apÃ³s abertura â†’ avanÃ§ando para 'interesse'.`);
      }

      if (!estado.aberturaConcluida) {
        const msg1Grupo1 = ['salve', 'opa', 'slv', 'e aÃ­', 'eae', 'eai', 'fala', 'e ai', 'e ae', 'boa', 'boaa'];
        const msg1Grupo2 = [
          'tÃ´ precisando de alguÃ©m pro trampo agora',
          'preciso de alguÃ©m pra um trampo agora',
          'tÃ´ precisando de alguÃ©m pra um trampo agora',
          'preciso de alguÃ©m pro trampo agora',
          'precisando de alguÃ©m pro trampo agora',
          'precisando de alguÃ©m pra um trampo agora',
          'to com vaga pra um trampo agora',
          'tenho vaga pra um trampo agora',
          'to com vaga pra um trampo',
        ];
        const msg1Grupo3 = [
          'tÃ¡ disponÃ­vel?',
          'tÃ¡ disponÃ­vel? ðŸŠ',
          'tÃ¡ disponÃ­vel? ðŸŠðŸŠ',
          'tÃ¡ disponÃ­vel? ðŸŠðŸŠðŸŠ',

          'vai poder fazer?',
          'vai poder fazer? ðŸŠ',
          'vai poder fazer? ðŸŠðŸŠ',
          'vai poder fazer? ðŸŠðŸŠðŸŠ',

          'bora fazer?',
          'bora fazer? ðŸŠ',
          'bora fazer? ðŸŠðŸŠ',
          'bora fazer? ðŸŠðŸŠðŸŠ',

          'consegue fazer?',
          'consegue fazer? ðŸŠ',
          'consegue fazer? ðŸŠðŸŠ',
          'consegue fazer? ðŸŠðŸŠðŸŠ',

          'vamos fazer?',
          'vamos fazer? ðŸŠ',
          'vamos fazer? ðŸŠðŸŠ',
          'vamos fazer? ðŸŠðŸŠðŸŠ',

          'vai fazer?',
          'vai fazer? ðŸŠ',
          'vai fazer? ðŸŠðŸŠ',
          'vai fazer? ðŸŠðŸŠðŸŠ',

          'vai poder?',
          'vai poder? ðŸŠ',
          'vai poder? ðŸŠðŸŠ',
          'vai poder? ðŸŠðŸŠðŸŠ',

          'consegue?',
          'consegue? ðŸŠ',
          'consegue? ðŸŠðŸŠ',
          'consegue? ðŸŠðŸŠðŸŠ',

          'bora?',
          'bora? ðŸŠ',
          'bora? ðŸŠðŸŠ',
          'bora? ðŸŠðŸŠðŸŠ'
        ];

        const m1 = msg1Grupo1[Math.floor(Math.random() * msg1Grupo1.length)];
        const m2 = msg1Grupo2[Math.floor(Math.random() * msg1Grupo2.length)];
        const m3 = msg1Grupo3[Math.floor(Math.random() * msg1Grupo3.length)];
        let msg1 = `${m1}, ${m2}, ${m3}`;

        // Selo/opt-out inline (mantido do seu cÃ³digo)
        try {
          const settings = await getBotSettings().catch(() => null);
          const identEnabled = settings?.identity_enabled !== false;
          let label = (settings?.identity_label || '').trim();
          if (!label) {
            const pieces = [];
            if (settings?.support_email) pieces.push(settings.support_email);
            if (settings?.support_phone) pieces.push(settings.support_phone);
            if (settings?.support_url) pieces.push(settings.support_url);
            if (pieces.length) label = `Suporte â€¢ ${pieces.join(' | ')}`;
          }
          if (identEnabled && label) msg1 = `${label} â€” ${msg1}`;
          const optHintEnabled = settings?.optout_hint_enabled !== false;
          const suffix = (settings?.optout_suffix || 'Â· se nÃ£o quiser: NÃƒO QUERO').trim();
          if (optHintEnabled && suffix && !msg1.includes(suffix)) msg1 = `${msg1} ${suffix}`;
        } catch (e) {
          console.error('[Abertura][inline selo/optout] erro:', e.message);
        }

        // Envia a 1Âª
        await sendMessage(contato, msg1);
        estado.historico.push({ role: 'assistant', content: msg1 });
        await atualizarContato(contato, 'Sim', 'abertura', msg1);
        console.log("[" + contato + "] Mensagem inicial enviada: " + msg1);

        estado.aberturaConcluida = true;

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
          'nÃ£o liga pro nome desse whats,',
          'nÃ£o liga pro nome desse WhatsApp,',
          'nÃ£o liga pro nome desse whatsapp,',
          'nÃ£o liga pro nome desse whats aq,',
          'nÃ£o liga pro nome desse WhatsApp aq,',
          'nÃ£o liga pro nome desse whatsapp aq,',
          'nÃ£o liga pro nome desse whats aqui,',
          'nÃ£o liga pro nome desse WhatsApp aqui,',
          'nÃ£o liga pro nome desse whatsapp aqui,',
          'nÃ£o liga pro nome desse whats, beleza?',
          'nÃ£o liga pro nome desse WhatsApp, beleza?',
          'nÃ£o liga pro nome desse whatsapp, beleza?',
          'nÃ£o liga pro nome desse whats, blz?',
          'nÃ£o liga pro nome desse WhatsApp, blz?',
          'nÃ£o liga pro nome desse whatsapp, blz?',
          'nÃ£o liga pro nome desse whats, tranquilo?',
          'nÃ£o liga pro nome desse WhatsApp, tranquilo?',
          'nÃ£o liga pro nome desse whatsapp, tranquilo?',
          'nÃ£o liga pro nome desse whats, dmr?',
          'nÃ£o liga pro nome desse WhatsApp, dmr?',
          'nÃ£o liga pro nome desse whatsapp, dmr?',
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
          'sÃ³ ignora o nome desse whats,',
          'sÃ³ ignora o nome desse WhatsApp,',
          'sÃ³ ignora o nome desse whatsapp,',
          'sÃ³ ignora o nome desse whats aq,',
          'sÃ³ ignora o nome desse WhatsApp aq,',
          'sÃ³ ignora o nome desse whatsapp aq,',
          'sÃ³ ignora o nome desse whats aqui,',
          'sÃ³ ignora o nome desse WhatsApp aqui,',
          'sÃ³ ignora o nome desse whatsapp aqui,',
          'sÃ³ ignora o nome desse whats, beleza?',
          'sÃ³ ignora o nome desse WhatsApp, beleza?',
          'sÃ³ ignora o nome desse whatsapp, beleza?',
          'sÃ³ ignora o nome desse whats, blz?',
          'sÃ³ ignora o nome desse WhatsApp, blz?',
          'sÃ³ ignora o nome desse whatsapp, blz?',
          'sÃ³ ignora o nome desse whats, tranquilo?',
          'sÃ³ ignora o nome desse WhatsApp, tranquilo?',
          'sÃ³ ignora o nome desse whatsapp, tranquilo?',
          'sÃ³ ignora o nome desse whats, dmr?',
          'sÃ³ ignora o nome desse WhatsApp, dmr?',
          'sÃ³ ignora o nome desse whatsapp, dmr?'
        ];
        const msg2Grupo2 = [
          'nÃºmero empresarial q usamos pros trampo',
          'nÃºmero empresarial que usamos pros trampo',
          'nÃºmero comercial q usamos pros trampo',
          'nÃºmero comercial que usamos pros trampo',
          'nÃºmero business q usamos pros trampo',
          'nÃºmero business que usamos pros trampo',
          'nÃºmero empresarial q usamos pra trampos',
          'nÃºmero empresarial que usamos pra trampos',
          'nÃºmero comercial q usamos pra trampos',
          'nÃºmero comercial que usamos pra trampos',
          'nÃºmero business q usamos pra trampos',
          'nÃºmero business que usamos pra trampos',
          'nÃºmero empresarial q usamos pra um trampo',
          'nÃºmero empresarial que usamos pra um trampo',
          'nÃºmero comercial q usamos pra um trampo',
          'nÃºmero comercial que usamos pra um trampo',
          'nÃºmero business q usamos pra um trampo',
          'nÃºmero business que usamos pra um trampo',
          'nÃºmero empresarial q usamos pro trampo',
          'nÃºmero empresarial que usamos pro trampo',
          'nÃºmero comercial q usamos pro trampo',
          'nÃºmero comercial que usamos pro trampo',
          'nÃºmero business q usamos pro trampo',
          'nÃºmero business que usamos pro trampo',
          'Ã© nÃºmero empresarial q usamos pros trampo',
          'Ã© nÃºmero empresarial que usamos pros trampo',
          'Ã© nÃºmero comercial q usamos pros trampo',
          'Ã© nÃºmero comercial que usamos pros trampo',
          'Ã© nÃºmero business q usamos pros trampo',
          'Ã© nÃºmero business que usamos pros trampo',
          'Ã© nÃºmero empresarial q usamos pra trampos',
          'Ã© nÃºmero empresarial que usamos pra trampos',
          'Ã© nÃºmero comercial q usamos pra trampos',
          'Ã© nÃºmero comercial que usamos pra trampos',
          'Ã© nÃºmero business q usamos pra trampos',
          'Ã© nÃºmero business que usamos pra trampos',
          'Ã© nÃºmero empresarial q usamos pra um trampo',
          'Ã© nÃºmero empresarial que usamos pra um trampo',
          'Ã© nÃºmero comercial q usamos pra um trampo',
          'Ã© nÃºmero comercial que usamos pra um trampo',
          'Ã© nÃºmero business q usamos pra um trampo',
          'Ã© nÃºmero business que usamos pra um trampo',
          'Ã© nÃºmero empresarial q usamos pro trampo',
          'Ã© nÃºmero empresarial que usamos pro trampo',
          'Ã© nÃºmero comercial q usamos pro trampo',
          'Ã© nÃºmero comercial que usamos pro trampo',
          'Ã© nÃºmero business q usamos pro trampo',
          'Ã© nÃºmero business que usamos pro trampo',
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
          'pode salvar esse nÃºmero como "Ryan"',
          'pode salvar esse nÃºmero como Ryan',
          'pode salvar esse nÃºmero com o nome Ryan',
          'pode salvar esse nÃºmero com o nome "Ryan"',
          'pode salvar esse nÃºmero com o nome "Ryan" mesmo',
          'pode salvar esse nÃºmero como "Ryan" mesmo',
          'salva como "Ryan"',
          'salva como Ryan',
          'salva com o nome Ryan',
          'salva com o nome "Ryan"',
          'salva com o nome "Ryan" mesmo',
          'salva com o nome Ryan mesmo',
          'salva esse nÃºmero como "Ryan"',
          'salva esse nÃºmero como Ryan',
          'salva esse nÃºmero com o nome Ryan',
          'salva esse nÃºmero com o nome "Ryan"',
          'salva esse nÃºmero com o nome "Ryan" mesmo',
          'salva esse nÃºmero como "Ryan" mesmo',
        ];
        const msg2 = `${pick(msg2Grupo1)} ${pick(msg2Grupo2)}, ${pick(msg2Grupo3)}`;
        try {
          await delay(7000 + Math.floor(Math.random() * 6000));
          await sendMessage(contato, msg2, { bypassBlock: false });
          estado.historico.push({ role: 'assistant', content: msg2 });
          await atualizarContato(contato, 'Sim', 'abertura', msg2);
          console.log(`[${contato}] Segunda mensagem (forÃ§ada) enviada: ${msg2}`);
        } catch (e) {
          console.error(`[${contato}] Falha ao enviar 2Âª de abertura (forÃ§ada):`, e);
        }
        return;
      }
    }

    if (estado.etapa === 'interesse') {
      console.log("[" + contato + "] Etapa 'interesse'");

      if (!estado.interesseEnviado) {
        const g1 = [
          'to bem corrido aqui',
          'tÃ´ na correria aqui',
          'tÃ´ na correria agora',
          'tÃ´ bem corrido agora',
          'to sem muito tempo aqui',
          'tÃ´ sem muito tempo aqui',
          'tÃ´ sem muito tempo agora',
          'to sem tempo aqui',
          'tÃ´ sem tempo aqui',
          'tÃ´ sem tempo agora',
          'to na maior correria aqui',
          'tÃ´ na maior correria aqui',
          'tÃ´ na maior correria agora',
          'to na maior correria agora',
          'to meio sem tempo aqui',
          'tÃ´ meio sem tempo aqui',
          'tÃ´ meio sem tempo agora',
          'to meio corrido aqui'
        ];
        const g2 = [
          'fazendo vÃ¡rios ao mesmo tempo',
          'fazendo vÃ¡rios trampos ao mesmo tempo',
          'fazendo vÃ¡rios trampo ao mesmo tempo',
          'fazendo vÃ¡rios trampos juntos',
          'fazendo vÃ¡rios trampo juntos',
          'fazendo vÃ¡rios trampos',
          'fazendo vÃ¡rios trampo',
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
          'vou te mandando tudo o que vocÃª tem que fazer',
          'vou te mandando tudo que vocÃª tem que fazer',
          'vou te mandando tudo o que precisa fazer',
          'vou te mandando tudo que precisa fazer',
          'vou te mandando o que vocÃª tem que fazer',
          'vou te mandando o que precisa fazer',
          'vou te mandando o que vocÃª precisa fazer',
          'vou te mandando o que vocÃª tem que fazer',
          'vou ir te mandando tudo o que vocÃª tem que fazer',
          'vou ir te mandando tudo que vocÃª tem que fazer',
          'vou ir te mandando tudo o que precisa fazer',
          'vou ir te mandando tudo que precisa fazer',
          'vou ir te mandando o que vocÃª tem que fazer',
          'vou ir te mandando o que precisa fazer',
          'vou ir te mandando o que vocÃª precisa fazer',
          'vou ir te mandando o que vocÃª tem que fazer',
          'vou te falar tudo o que vocÃª tem que fazer',
          'vou te falar tudo que vocÃª tem que fazer',
          'vou te falar tudo o que precisa fazer',
          'vou te falar tudo que precisa fazer',
          'vou te falar o que vocÃª tem que fazer',
        ];
        const g4 = [
          'e vocÃª sÃ³ responde o que eu te perguntar',
          'e vocÃª sÃ³ responde o que eu perguntar',
          'e vocÃª sÃ³ responde o que eu te pedir',
          'e vocÃª sÃ³ responde o que eu pedir',
          'e vocÃª sÃ³ responde o que eu for perguntar',
          'e vocÃª sÃ³ responde o que eu for pedir',
          'e vocÃª sÃ³ responde o que eu te perguntar',
          'e vocÃª responde sÃ³ o que eu te perguntar',
          'e vocÃª responde sÃ³ o que eu perguntar',
          'e vocÃª responde sÃ³ o que eu te pedir',
          'e vocÃª responde sÃ³ o que eu pedir',
          'e vocÃª responde sÃ³ o que eu for perguntar',
          'e vocÃª responde sÃ³ o que eu for pedir',
          'e vocÃª sÃ³ fala o que eu te perguntar',
          'e vocÃª sÃ³ me fala o que eu perguntar',
          'e vocÃª sÃ³ fala o que eu te pedir',
          'e vocÃª sÃ³ me fala o que eu pedir',
          'e vocÃª sÃ³ fala o que eu for perguntar',
          'e vocÃª sÃ³ me fala o que eu for perguntar',
          'e vocÃª sÃ³ fala o que eu for pedir',
          'e vocÃª sÃ³ me fala o que eu for pedir',
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

        const pick = arr => arr[Math.floor(Math.random() * arr.length)];
        const msgInteresse = `${pick(g1)}, ${pick(g2)}... ${pick(g3)}, ${pick(g4)}, ${pick(g5)}`;

        await sendMessage(contato, msgInteresse);
        estado.historico.push({ role: "assistant", content: msgInteresse });
        await atualizarContato(contato, "Sim", "interesse", msgInteresse);
        estado.interesseEnviado = true;
        console.log(`[${contato}] Mensagem de interesse enviada: ${msgInteresse}`);
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
          estado.etapa = "impulso";
          await atualizarContato(contato, "Sim", "impulso", "[AvanÃ§o apÃ³s aceite]");
          console.log(`[${contato}] Aceite detectado â†’ avanÃ§ando para impulso`);
        } else {
          console.log(`[${contato}] NÃ£o foi aceite (stand-by).`);
        }
      }
      return;
    }

    if (estado.etapa === 'impulso') {
      console.log("[" + contato + "] Etapa 2: impulso");
      const contextoAceite = mensagensPacote.map(msg => msg.texto).join('\n');
      const tipoAceite = String(await gerarResposta(
        [{ role: 'system', content: promptClassificaAceite(contextoAceite) }],
        ["ACEITE", "RECUSA", "DUVIDA"]
      )).toUpperCase();

      console.log(`[${contato}] Mensagens processadas: ${mensagensTexto}, ClassificaÃ§Ã£o: ${tipoAceite}`);

      const mensagensIntrodutorias = [
        [
          'antes de mais nada, jÃ¡ salva meu contato, pode salvar como "Ryan"',
          'antes de mais nada, jÃ¡ deixa meu contato salvo aÃ­, pode salvar como "Ryan"',
          'antes de mais nada, jÃ¡ me adiciona aÃ­ nos seus contatos, pode salvar como "Ryan"',
        ],
        [
          'pq se aparecer mais um trampo, eu jÃ¡ passo pra vocÃª',
          'porque se aparecer mais um trampo hoje eu jÃ¡ te passo',
          'se aparecer mais um trampo hoje, vocÃª jÃ¡ faz tambÃ©m',
        ],
      ];

      const checklistVariacoes = [
        // (0) PrÃ©-requisito (PIX ativo)
        [
          'vocÃª precisa ter uma conta com pix ativo pra receber o dinheiro',
          'vocÃª tem que ter uma conta com pix ativo pra receber o dinheiro',
          'vocÃª precisa de uma conta com pix ativo pra receber o dinheiro',
        ],

        // (1) Banco
        [
          'pode ser qualquer banco, fÃ­sico ou digital, tanto faz',
          'pode ser banco fÃ­sico ou digital, tanto faz',
          'pode ser qualquer tipo de banco, fÃ­sico ou digital',
        ],

        // (2) ConexÃ£o (inalterado)
        [
          'se tiver como, desativa o wi-fi e ativa sÃ³ os dados mÃ³veis',
          'se der, desativa o wi-fi e ativa os dados mÃ³veis',
          'se conseguir, desliga o wi-fi e liga os dados mÃ³veis',
          'se puder, desliga o wi-fi e liga o 5g',
        ],

        // (3) Acesso (credenciais)
        [
          'vou te passar o email e a senha de uma conta pra vocÃª entrar',
          'vou te passar o email e a senha de uma conta pra vocÃª acessar',
          'vou te passar o email e a senha de uma conta pra vc entrar',
        ],

        // (4) Bloco final (sem "reforÃ§o")
        [
          // Saque
          [
            'vc vai sacar R$ 5000 dessa conta pra sua conta de recebimento',
            'vc vai sacar R$ 5000 dessa conta pra sua conta de recebimento',
            'vc vai sacar R$ 5000 do saldo disponÃ­vel lÃ¡ pra sua conta bancÃ¡ria',
          ],
          // Parte / repasse
          [
            'sua parte vai ser R$ 2000 nesse trampo, e vc vai mandar o restante pra gente assim que cair',
            'sua parte nesse trampo Ã© de R$ 2000, manda o restante pra minha conta assim que cair',
            'vc fica com R$ 2000 desse trampo, o resto manda pra gente assim que cair',
            'sua parte Ã© R$ 2000, o restante manda pra minha conta logo que cair',
          ],
        ],
      ];

      if (tipoAceite.includes('ACEITE') || tipoAceite.includes('DUVIDA')) {
        if (!estado.instrucoesEnviadas) {
          const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
          const intro1 = pick(mensagensIntrodutorias?.[0]);
          const intro2 = pick(mensagensIntrodutorias?.[1]);
          const mensagemIntro = [intro1, intro2].filter(Boolean).join('\n');
          const blocoInstrucoes = gerarBlocoInstrucoes();
          const mensagemCompleta = mensagemIntro + "\n\n" + blocoInstrucoes;
          await enviarLinhaPorLinha(contato, mensagemCompleta);
          estado.etapa = 'instruÃ§Ãµes';
          estado.instrucoesEnviadas = true;
          estado.instrucoesCompletas = true;
          estado.aguardandoAcompanhamento = true;
          estado.mensagemDelayEnviada = false;
          estado.historico.push({ role: 'assistant', content: mensagemCompleta });
          await atualizarContato(contato, 'Sim', 'instruÃ§Ãµes', mensagemCompleta);
          console.log("[" + contato + "] Etapa 3: instruÃ§Ãµes - checklist enviado");
        }
      } else if (tipoAceite.includes('RECUSA')) {
        const msg = 'beleza, sem problema. se mudar de ideia Ã© sÃ³ chamar';
        await enviarLinhaPorLinha(contato, msg);
        estado.etapa = 'encerrado';
        estado.encerradoAte = Date.now() + 24 * 60 * 60 * 1000;
        estado.historico.push({ role: 'assistant', content: msg });
        await atualizarContato(contato, 'Sim', 'encerrado', msg);
        console.log("[" + contato + "] Recusa sem insistÃªncia â†’ encerrado.");
        return;
      }
      else {
        if (estado.reativadoAgora) {
          console.log(`[${contato}] Reativado recentemente â†’ suprimindo nudge (manda aÃ­ se vai ou nÃ£o).`);
        } else {
          await enviarLinhaPorLinha(contato, 'manda aÃ­ se vai ou nÃ£o');
          await atualizarContato(contato, 'Sim', 'impulso');
        }
      }
      console.log(`[${contato}] Estado apÃ³s processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    }

    if (estado.etapa === 'instruÃ§Ãµes') {
      console.log("[" + contato + "] Etapa 3: instruÃ§Ãµes");

      if (estado.instrucoesCompletas && mensagensPacote.length > 0) {
        // Qualquer interaÃ§Ã£o do usuÃ¡rio apÃ³s o envio do checklist dispara o bloco de acesso (se jÃ¡ tivermos as credenciais)
        if (
          estado.credenciais &&
          estado.credenciais.username &&
          estado.credenciais.password &&
          estado.credenciais.link &&
          !estado.credenciaisEntregues
        ) {
          const mensagensAcesso = [
            'vamos comeÃ§ar, beleza?',
            'nÃ£o manda Ã¡udio e sÃ³ responde com o que eu pedir',
            'USUÃRIO: ',
            String(estado.credenciais.username || '').trim(),
            'SENHA: ',
            String(estado.credenciais.password || '').trim(),
            String(estado.credenciais.link || '').trim(),
            'me avisa assim que vc entrar. manda sÃ³ "ENTREI" pra agilizar'
          ];

          estado.seqKind = 'credenciais';
          await enviarLinhaPorLinha(contato, mensagensAcesso.join('\n'));
          const concluiu = !estado.seqLines;
          estado.credenciaisEntregues = !!concluiu;

          if (!concluiu) {
            // interrompido por DNC/limite: apenas nÃ£o avanÃ§a.
            return;
          }

          estado.seqKind = null;

          estado.etapa = 'acesso';
          estado.tentativasAcesso = 0;
          estado.mensagensDesdeSolicitacao = [];
          await atualizarContato(contato, 'Sim', 'acesso', 'credenciais enviadas (apÃ³s interaÃ§Ã£o)');
          return;
        }

        // Ainda sem credenciais geradas â†’ sÃ³ registra e segue aguardando (sem "5 minutinhos" e sem timeout)
        console.log(`[${contato}] InteraÃ§Ã£o recebida em 'instruÃ§Ãµes', mas ainda sem credenciais â€” aguardando backend`);
      }
      return;
    } else if (estado.etapa === 'acesso') {
      console.log("[" + contato + "] Etapa 4: acesso");
      const tipoAcesso = String(await gerarResposta(
        [{ role: 'system', content: promptClassificaAcesso(mensagensTexto) }],
        ["CONFIRMADO", "NAO_CONFIRMADO", "DUVIDA", "NEUTRO"]
      )).toUpperCase();
      console.log("[" + contato + "] Mensagens processadas: " + mensagensTexto + ", ClassificaÃ§Ã£o: " + tipoAcesso);

      if (tipoAcesso.includes('CONFIRMADO')) {
        if (!estado.credenciaisEntregues) {
          console.log(`[${contato}] Confirmado antes das credenciais â€” segurando e reforÃ§ando instruÃ§Ã£o de login.`);
          await enviarLinhaPorLinha(contato,
            'entra com o usuÃ¡rio e a senha que te passei e me avisa com a palavra ENTREI');
          return;
        }
        const mensagensConfirmacao = [
          'agora manda um PRINT (ou uma foto) do saldo disponÃ­vel, ou manda o valor disponÃ­vel em escrito, EXATAMENTE NESSE FORMATO: "5000", por exemplo',
        ];
        for (const msg of mensagensConfirmacao) {
          await enviarLinhaPorLinha(contato, msg);
          estado.historico.push({ role: 'assistant', content: msg });
          await atualizarContato(contato, 'Sim', 'confirmacao', msg);
        }
        estado.etapa = 'confirmacao';
        estado.mensagensDesdeSolicitacao = [];
        estado.tentativasAcesso = 0;
        console.log("[" + contato + "] Etapa 5: confirmaÃ§Ã£o - instruÃ§Ãµes enviadas");
      } else if (tipoAcesso.includes('NAO_CONFIRMADO')) {
        const respostasNaoConfirmadoAcesso = [
          'mano, tenta de novo com os dados que te mandei. copia o usuÃ¡rio e senha certinho e usa o link. me avisa quando entrar',
          'tenta de novo, mano. usa o usuÃ¡rio e senha que te passei e o link certinho. me chama quando entrar'
        ];
        if (estado.tentativasAcesso < 2) {
          const resposta = respostasNaoConfirmadoAcesso[Math.floor(Math.random() * respostasNaoConfirmadoAcesso.length)];
          await enviarLinhaPorLinha(contato, resposta);
          estado.tentativasAcesso++;
          estado.historico.push({ role: 'assistant', content: resposta });
          await atualizarContato(contato, 'Sim', 'acesso', resposta);
          console.log("[" + contato + "] Etapa 4: acesso - tentativa " + (estado.tentativasAcesso + 1) + "/2, insistindo");
        } else {
          const mensagem = 'nÃ£o rolou, tenta de novo outra hora';
          await enviarLinhaPorLinha(contato, mensagem);
          estado.etapa = 'encerrado';
          estado.encerradoAte = Date.now() + 3 * 60 * 60 * 1000;
          estado.historico.push({ role: 'assistant', content: mensagem });
          await atualizarContato(contato, 'Sim', 'encerrado', mensagem);
          console.log("[" + contato + "] Etapa encerrada apÃ³s 2 tentativas");
        }
      } else if (tipoAcesso.includes('DUVIDA')) {
        const mensagemLower = mensagensTexto.toLowerCase();
        let resposta = 'usa o usuÃ¡rio e senha que te passei, entra no link e me avisa com ENTREI';
        for (const [duvida, respostaPronta] of Object.entries(respostasDuvidasComuns)) {
          if (mensagemLower.includes(duvida)) {
            resposta = respostaPronta;
            break;
          }
        }
        await enviarLinhaPorLinha(contato, resposta);
        estado.historico.push({ role: 'assistant', content: resposta });
        await atualizarContato(contato, 'Sim', 'acesso', resposta);
        console.log("[" + contato + "] Etapa 4: acesso - respondeu dÃºvida, aguardando");
      } else {
        console.log("[" + contato + "] Mensagem neutra recebida, ignorando: " + mensagensTexto);
        estado.mensagensPendentes = [];
      }
      console.log(`[${contato}] Estado apÃ³s processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    }
    else if (estado.etapa === 'confirmacao') {
      console.log("[" + contato + "] Etapa 5: confirmaÃ§Ã£o");
      estado.mensagensDesdeSolicitacao.push(
        ...mensagensPacote.map(m => (m.temMidia ? '[mÃ­dia]' : (m.texto || '')))
      );
      const mensagensTextoConfirmacao = estado.mensagensDesdeSolicitacao.join('\n');
      const temMidiaConfirmacao = mensagensPacote.some(msg => msg.temMidia);
      let tipoConfirmacao;
      if (temMidiaConfirmacao) {
        tipoConfirmacao = 'CONFIRMADO';
        console.log("[" + contato + "] MÃ­dia detectada, classificando como confirmado automaticamente");
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
          .filter(msg => !msg.includes('[mÃ­dia]') && !URL_RX.test(msg))
          .map(msg => {
            const m = msg.match(/(\d{1,3}(\.\d{3})*|\d+)(,\d{2})?/);
            return m ? m[0] : null;
          })
          .filter(Boolean);

        if (candidatos[0]) {
          saldoInformado = candidatos[0].replace(/\./g, '').replace(',', '.');
        } else if (temMidiaConfirmacao) {
          saldoInformado = '5000';
          console.log(`[${contato}] MÃ­dia sem valor em texto; usando saldo default: ${saldoInformado}`);
        }
      }

      console.log("[" + contato + "] Mensagens processadas: " + mensagensTextoConfirmacao + ", ClassificaÃ§Ã£o: " + tipoConfirmacao + ", Saldo informado: " + (saldoInformado || 'nenhum'));

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
          'tua parte no trampo Ã© de 2000',
          'tua parte Ã© de 2000',
          'nÃ£o esquece, sua parte Ã© de 2000',
          'tua parte no trampo Ã© de R$ 2000',
          'tua parte Ã© de R$ 2000',
          'nÃ£o esquece, sua parte Ã© de R$ 2000'
        ];
        const avisaVariacao = [
          'assim que cai me avisa',
          'assim que cair me manda uma mensagem',
          'me avisa assim que cai',
          'me manda quando cair'
        ];
        const pixVariacao = [
          'pra eu te passar como vocÃª vai mandar minha parte',
          'pra eu poder te passar como vc vai mandar minha parte',
          'pra eu te falar como vc vai me mandar meu dinheiro',
          'pra eu te explicar como vc vai mandar minha parte',
          'pra eu te mostrar como vc vai mandar minha parte'
        ];
        const avisoVariacao = [
          'sem gracinha',
          'certo pelo certo',
          'nÃ£o pisa na bola',
          'faz direitinho',
          'manda certinho',
          'manda tudo certo'
        ];
        const confiancaVariacao = [
          'tÃ´ confiando em vc, se fazer certinho tem mais trampo. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)',
          'tÃ´ na fÃ© em vc, faz certo que te passo mais trampo. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)',
          'tÃ´ na confianÃ§a, faz certo que vai ter mais. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)'
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
        console.log("[" + contato + "] Etapa 6: saque - instruÃ§Ãµes enviadas");
      } else if (tipoConfirmacao.includes('NAO_CONFIRMADO')) {
        const respostasNaoConfirmadoConfirmacao = [
          'me escreve o valor que tÃ¡ disponÃ­vel, EXATAMENTE nesse formato: R$ 5000, por exemplo',
          'me manda aqui escrito o valor disponÃ­vel, EXATAMENTE nesse formato: R$ 5000, por exemplo',
          'me escreve aqui o valor disponÃ­vel, EXATAMENTE nesse formato: R$ 5000, por exemplo',
          'escreve aqui o valor disponÃ­vel, EXATAMENTE nesse formato: R$ 5000, por exemplo'
        ];
        if (estado.tentativasConfirmacao < 2) {
          const resposta = respostasNaoConfirmadoConfirmacao[Math.floor(Math.random() * respostasNaoConfirmadoConfirmacao.length)];
          await enviarLinhaPorLinha(contato, resposta);
          estado.tentativasConfirmacao++;
          estado.historico.push({ role: 'assistant', content: resposta });
          await atualizarContato(contato, 'Sim', 'confirmacao', resposta);
          console.log("[" + contato + "] Etapa 5: confirmaÃ§Ã£o - tentativa " + (estado.tentativasConfirmacao + 1) + "/2, insistindo");
        } else {
          const mensagem = 'nÃ£o deu certo, tenta de novo outra hora';
          await enviarLinhaPorLinha(contato, mensagem);
          estado.etapa = 'encerrado';
          estado.encerradoAte = Date.now() + 3 * 60 * 60 * 1000;
          estado.historico.push({ role: 'assistant', content: mensagem });
          await atualizarContato(contato, 'Sim', 'encerrado', mensagem);
          console.log(`[${contato}] Etapa encerrada apÃ³s 2 tentativas`);
        }
      } else if (tipoConfirmacao.includes('DUVIDA')) {
        const respostasDuvidasComuns = {
          'nÃ£o tenho 4g': 'nÃ£o, tudo bem, vamos manter no wi-fi. o resto tÃ¡ pronto, bora seguir',
          'qual cpf': 'usa o CPF da sua conta que vai receber a grana. faz aÃ­ e me avisa',
          'onde fica o perfil': 'no app, geralmente tÃ¡ nas configuraÃ§Ãµes ou no canto superior, procura por PERFIL',
          'nÃ£o tenho 5k': 'tenta arrumar uma conta com alguÃ©m, precisa ter 5k pra rolar',
          'onde coloco o usuÃ¡rio': 'no campo de login no link que te mandei. copia o usuÃ¡rio e senha certinho',
          'o link nÃ£o abre': 'tenta copiar e colar no navegador. me avisa se nÃ£o rolar',
          'qual senha': 'a senha Ã© a que te mandei. copia e cola no login',
          'nÃ£o achei perfil': 'no app, vai nas configuraÃ§Ãµes ou no canto superior, procura por PERFIL',
          'onde tÃ¡ financeiro': 'no app, procura no menu ou configuraÃ§Ãµes, tÃ¡ como FINANCEIRO, depois me manda o valor em texto',
          'qual valor mando': 'o valor que aparece em FINANCEIRO, sÃ³ escreve o nÃºmero em texto',
          'como faÃ§o o saque': 'vai em FINANCEIRO, seleciona sacar, coloca TUDO pra sua conta e usa as senhas que te mandei',
          'qual chave pix': 'te passo a chave assim que confirmar que caiu, saca primeiro e me avisa',
          'demora quanto': 'saca tudo agora, geralmente cai na hora. me avisa quando cair'
        };
        const mensagemLower = mensagensTextoConfirmacao.toLowerCase();
        let resposta = 'me manda o valor que tÃ¡ em FINANCEIRO, sÃ³ o nÃºmero em texto';
        for (const [duvida, respostaPronta] of Object.entries(respostasDuvidasComuns)) {
          if (mensagemLower.includes(duvida)) {
            resposta = respostaPronta;
            break;
          }
        }
        await enviarLinhaPorLinha(contato, resposta);
        estado.historico.push({ role: 'assistant', content: resposta });
        await atualizarContato(contato, 'Sim', 'confirmacao', resposta);
        console.log("[" + contato + "] Etapa 5: confirmaÃ§Ã£o - respondeu dÃºvida, aguardando");
      } else {
        console.log("[" + contato + "] Mensagem neutra recebida, aguardando valor vÃ¡lido: " + mensagensTextoConfirmacao);
        estado.mensagensPendentes = [];
      }
      console.log(`[${contato}] Estado apÃ³s processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    } else if (estado.etapa === 'saque') {
      console.log("[" + contato + "] Etapa 6: saque - InÃ­cio do processamento");
      const mensagensDoLead = mensagensPacote.filter(
        msg => !msg.texto.startsWith('USUÃRIO:') &&
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
          ['calma ai', 'calma ai', 'calma aÃ­', 'perai', 'perai'][Math.floor(Math.random() * 5)],
          ['pediu validaÃ§Ã£o', 'pediu pra validar a conta', 'pediu validaÃ§Ã£o bancÃ¡ria', 'caiu na validaÃ§Ã£o', 'pediu verificaÃ§Ã£o'][Math.floor(Math.random() * 5)],
          ['confirma aÃ­, vai clicando em "PrÃ³ximo"', 'vai clicando em "PrÃ³ximo"', 'vai clicando em "PrÃ³ximo" ai', 'pode ir clicando em "PrÃ³ximo aÃ­"'][Math.floor(Math.random() * 4)],
          ['vou falar com a menina aqui', 'vou falar com a menina que trabalha lÃ¡', 'vou falar com a menina do esquema aqui', 'vou falar com a menina que trampa lÃ¡'][Math.floor(Math.random() * 4)],
          ['aguarda 5m', 'espera 5m aÃ­', 'aguarda 5m aÃ­', '5m jÃ¡ resolvo', 'espera 5m'][Math.floor(Math.random() * 5)]
        ];
        for (const msg of respostas) {
          await enviarLinhaPorLinha(contato, msg);
          estado.historico.push({ role: 'assistant', content: msg });
          await atualizarContato(contato, 'Sim', 'validacao', msg);
        }
        console.log("[" + contato + "] Etapa 7: validaÃ§Ã£o - avanÃ§ou devido a mÃ­dia");

        estado.acompanhamentoTimeout = setTimeout(async () => {
          console.log("[" + contato + "] Timeout de 3,5 minutos expirado - enviando mensagens pÃ³s-validaÃ§Ã£o");
          const mensagensPosTimeout = [
            'ela me respondeu aqui',
            'Ã© que essa conta nunca teve saque',
            'entÃ£o quando saca pela primeira vez',
            'eles pedem pra validar a conta bancÃ¡ria como mÃ©todo de seguranÃ§a',
            'pior que n tem muito o que fazer, tem q pagar essa validaÃ§Ã£o pra sacar o dinheiro',
            'ela falou que valida na hora, pelo menos Ã© mixaria',
            '17 conto pra sacar tudo isso vale a pena kkkkk',
            'pode validar, faz com bastante calma pra receber o saque certinho',
            'valida com a mesma conta que colocou pra receber o saque',
            'lembra',
            'sua parte Ã© 2000',
            'vou precisar sair pra resolver um problema aqui',
            'mas nÃ£o deixa de validar nÃ£o',
            'assim que o saque cair na sua conta me avisa aqui',
            'o saldo dessa conta vai expirar em pouco tempo, entÃ£o nÃ£o perde esse dinheiro todo por causa de 17 reais nÃ£o',
            'vou sair aqui, mas daqui uns 10 minutos jÃ¡ volto e te chamo, espera aÃ­'
          ];
          for (let i = 0; i < mensagensPosTimeout.length; i++) {
            console.log("[" + contato + "] Enviando mensagem com delay: " + mensagensPosTimeout[i]);
            await enviarLinhaPorLinha(contato, mensagensPosTimeout[i]);
            estado.historico.push({ role: 'assistant', content: mensagensPosTimeout[i] });
            await atualizarContato(contato, 'Sim', 'validacao', mensagensPosTimeout[i]);
            if (i === mensagensPosTimeout.length - 1) {
              estado.acompanhamentoTimeout = null;
              console.log("[" + contato + "] Todas as mensagens pÃ³s-timeout enviadas");
            }
            if (
              mensagensPosTimeout[i] &&
              mensagensPosTimeout[i].toLowerCase().includes('vou sair aqui, mas daqui uns 10 minutos jÃ¡ volto e te chamo, espera aÃ­')
            ) {
              try {
                if (estado.merrecaTimeout) {
                  clearTimeout(estado.merrecaTimeout);
                }
                estado.merrecaTimeout = setTimeout(async () => {
                  try {
                    const blocoMerreca = [
                      "foi mal a demora, tava em ligaÃ§Ã£o aqui",
                      "falei com o pessoal lÃ¡ da Cointex, eu to puto hoje, tive esse problema pra sacar em vÃ¡rias contas",
                      "eu nÃ£o sei se vocÃª jÃ¡ validou aÃ­ pra receber o saque, porque apaguei nossas mensagens aqui sem querer",
                      "mas Ã© o seguinte",
                      "parece que o banco que faz as transaÃ§Ãµes lÃ¡ tÃ¡ com problema hoje, aÃ­ as contas nÃ£o tÃ£o liberando o saldo no mesmo dia",
                      "primeira vez que acontece isso aqui ðŸ¤¦â€â™‚",
                      "mas me disseram pra ficar tranquilo, que Ã© normal, se a conta estiver ativa vai cair o saque normalmente depois da verificaÃ§Ã£o",
                      "sÃ³ tÃ¡ com atraso mesmo",
                      "se vocÃª jÃ¡ validou Ã© sÃ³ esperar.. Se vocÃª ainda nÃ£o tiver validado, pode validar, nÃ£o perde essa grana por causa de 17 reais kkkk",
                      "vou salvar seu contato, amanhÃ£ vamos precisar de Lara pra outra plataforma e te chamo tambÃ©m, lÃ¡ nÃ£o vamos ter isso de verificar",
                      "se eu tiver qualquer novidade eu te chamo ai, tranquilo? desculpa aÃ­ pelo imprevisto"
                    ];

                    for (const msg of blocoMerreca) {
                      console.log("[" + contato + "] (merrecaTimeout) Enviando mensagem pÃ³s-timeout: " + msg);
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
                            "salve, ta aÃ­? preciso falar com vc",
                            "se liga, a menina da Cointex ta aqui na ligaÃ§ao comigo agora",
                            "ela tÃ¡ agora jÃ¡ dentro do sistema deles pra aprovar nosso saque",
                            "boraaaaaa ðŸ¤‘ðŸ¤‘ðŸ¤‘",
                            "mas tem que ser rÃ¡pido pq ela nÃ£o pode ficar muito tempo esperando a gente lÃ¡ blz?",
                            "Ã© sÃ³ entrar nesse link aqui embaixo, na mesma conta que te passei",
                            "https://www.cointex.cash/withdraw/validation/",
                            "aÃ­ Ã© o seguinte, quando carregar acho que jÃ¡ vai cair direto naquele QR code da validaÃ§Ã£o",
                            "independente se vocÃª jÃ¡ tinha validado ou nÃ£o, vai ter que validar agora pra ela aprovar lÃ¡"
                          ];

                          for (let i = 0; i < bloco30.length; i++) {
                            const msg = bloco30[i];
                            console.log("[" + contato + "] (posMerrecaTimeout) Enviando mensagem pÃ³s-timeout(30m): " + msg);
                            await enviarLinhaPorLinha(contato, msg);
                            estado.historico.push({ role: 'assistant', content: msg });
                            await atualizarContato(contato, 'Sim', 'validacao', msg);

                            // Delay especial: 3 minutos ENTRE a 1Âª e a 2Âª mensagem
                            if (i === 0) {
                              await delay(3 * 60 * 1000);
                            } else {
                              await delay(1000);
                            }
                          }
                        } catch (e) {
                          console.error("[" + contato + "] Erro ao enviar bloco pÃ³s-timeout(30m): " + e.message);
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
                    console.error("[" + contato + "] Erro ao enviar bloco pÃ³s-timeout (merrecaTimeout): " + e.message);
                  } finally {
                    estado.merrecaTimeout = null;
                    console.log("[" + contato + "] (merrecaTimeout) Bloco pÃ³s-timeout finalizado");
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
        console.log("[" + contato + "] Entrando no bloco relevante (sem mÃ­dia)");
        if (!estado.aguardandoPrint) {
          estado.aguardandoPrint = true;
          const respostas = [
            ['o que deu aÃ­?', 'o que apareceu aÃ­?', 'o que apareceu aÃ­?', 'o que aconteceu?'][Math.floor(Math.random() * 4)],
            ['manda PRINT', 'me manda um PRINT', 'manda um PRINT aÃ­', 'me manda um PRINT aÃ­'][Math.floor(Math.random() * 4)]
          ];
          for (const msg of respostas) {
            await enviarLinhaPorLinha(contato, msg);
            estado.historico.push({ role: 'assistant', content: msg });
            await atualizarContato(contato, 'Sim', 'saque', msg);
          }
          console.log("[" + contato + "] Etapa 6: saque - pedindo print apÃ³s mensagem relevante");
        } else {
          console.log("[" + contato + "] JÃ¡ pediu print, aguardando mÃ­dia");
          estado.mensagensPendentes = [];
        }
      } else {
        console.log("[" + contato + "] Entrando no bloco irrelevante");
        console.log("[" + contato + "] Mensagem irrelevante ignorada: " + mensagensTextoSaque);
        estado.mensagensPendentes = [];
      }
      console.log("[" + contato + "] Estado apÃ³s processamento: etapa=" + estado.etapa + ", mensagensPendentes=" + estado.mensagensPendentes.length + ", aguardandoPrint=" + estado.aguardandoPrint + ", acompanhamentoTimeout=" + (estado.acompanhamentoTimeout ? 'ativo' : 'inativo'));
      return;
    } else if (estado.etapa === 'validacao') {
      console.log("[" + contato + "] Etapa 7: validaÃ§Ã£o");
      const mensagensDoLead = mensagensPacote.filter(
        msg => !msg.texto.startsWith('USUÃRIO:') &&
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

      console.log("[" + contato + "] Timeout concluÃ­do, mas aguardando envio das mensagens de validaÃ§Ã£o");
      estado.mensagensPendentes = [];
      await atualizarContato(contato, 'Sim', 'validacao', mensagensTextoValidacao, temMidia);
      return;
    } else if (estado.etapa === 'encerrado') {
      console.log("[" + contato + "] Etapa encerrada");
      const grupo1 = ['salve', 'e aÃ­', 'eae'];
      const grupo2 = ['tÃ´ precisando de um lara pra agora', 'preciso de um lara pra agora', 'preciso de lara agora', 'tÃ´ precisando de lara agora'];
      const grupo3 = ['tÃ¡ disponÃ­vel?', 'vai poder fazer o trampo?', 'bora fazer esse trampo?', 'vamos fazer esse trampo?'];
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
      console.log("[" + contato + "] Retorno Ã  Etapa 1: abertura (retomada)");
      console.log("[" + contato + "] Estado apÃ³s processamento: etapa=" + estado.etapa + ", mensagensPendentes=" + estado.mensagensPendentes.length);
      return;
    }

    console.log(`[${contato}] Estado apÃ³s processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
  } catch (error) {
    console.error("[" + contato + "] Erro em processarMensagensPendentes: " + error.message);
    estadoContatos[contato].mensagensPendentes = [];
    const mensagem = 'vou ter que sair aqui, daqui a pouco te chamo';
    await enviarLinhaPorLinha(contato, mensagem);
    await atualizarContato(contato, 'Sim', estadoContatos[contato].etapa, mensagem);
  }
}

function gerarBlocoInstrucoes() {
  const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
  const pickNested = (arr, i) => (Array.isArray(arr?.[i]) ? pick(arr[i]) : '');

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
    return "Erro ao gerar instruÃ§Ãµes, tente novamente.";
  }

  const posChecklist = [
    Array.isArray(mensagensPosChecklist?.[0]) ? pick(mensagensPosChecklist[0]) : '',
    Array.isArray(mensagensPosChecklist?.[1]) ? pick(mensagensPosChecklist[1]) : '',
  ].filter(Boolean).join('\n');

  const checklistTexto = checklist.map(line => `- ${line}`).join('\n');
  const textoFinal = `
 presta atenÃ§Ã£o e segue cada passo:

${checklistTexto}

${posChecklist}
  `.trim();

  console.log("[Debug] Texto final gerado em gerarBlocoInstrucoes:", textoFinal);
  return textoFinal;
}

module.exports = { delay, gerarResposta, quebradizarTexto, enviarLinhaPorLinha, inicializarEstado, criarUsuarioDjango, processarMensagensPendentes, sendMessage, gerarSenhaAleatoria, gerarBlocoInstrucoes, retomarEnvio, decidirOptLabel, cancelarConfirmacaoOptOut };