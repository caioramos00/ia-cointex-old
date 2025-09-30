// bot.js — v0 (apenas receber e logar mensagens)
// CommonJS, estado in-memory, ManyChat ativo, Meta Graph stub, sem Twilio

'use strict';

/**
 * Dependências existentes no projeto
 * (mantemos a estrutura atual; não usamos OpenAI/prompts por enquanto)
 */
const estadoContatos = require('./state.js');
// const { getActiveTransport } = require('./lib/transport'); // manter se precisar depois
// const { atualizarContato, getBotSettings, pool } = require('./db.js'); // futuro

/**
 * Logger simples (console por padrão), com opção de injeção via init()
 */
let log = console;

/**
 * Estado mínimo por contato.
 * Mantemos in-memory conforme pedido. Sem FSM por enquanto.
 */
function ensureEstado(contato) {
  if (!estadoContatos[contato]) {
    estadoContatos[contato] = {
      contato,
      etapa: 'none',           // sem etapas no v0
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } else {
    estadoContatos[contato].updatedAt = Date.now();
  }
  return estadoContatos[contato];
}

/**
 * Utilidades
 */
function safeStr(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function previewText(text, max = 120) {
  const t = safeStr(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Normalizadores de entrada
 * - ManyChat (ativo)
 * - Meta Graph (stub, não usado agora)
 */

/**
 * Normaliza payload do ManyChat para um shape único:
 * {
 *   contato: '55XXXXXXXXXXX',
 *   texto: 'mensagem do usuário',
 *   temMidia: boolean,
 *   midias: [ { url, type } ],
 *   ts: epoch_ms,
 *   origem: 'manychat',
 *   messageId: string|undefined,
 * }
 */
function normalizeManyChat(body) {
  const payload = body && (body.payload || body); // alguns setups enviam direto em .payload
  const user = payload && (payload.user || payload.contact || payload.subscriber);
  const msg = payload && payload.message;

  // telefone em números (BR geralmente começa com 55)
  const rawPhone = safeStr(user && (user.phone || user.whatsapp || user.msisdn)).replace(/\D/g, '');
  const contato = rawPhone || 'desconhecido';

  // texto (várias variações comuns do ManyChat)
  const texto =
    safeStr((msg && msg.text) ||
            (msg && msg.input && msg.input.text) ||
            payload.text ||
            payload.message_text ||
            '');

  // mídia (attachment único ou array)
  const attachments = [];
  const att = msg && (msg.attachment || msg.attachments);
  if (att) {
    if (Array.isArray(att)) {
      for (const a of att) {
        const type = a && a.type;
        const url =
          (a && a.payload && a.payload.url) ||
          (a && a.url) ||
          (a && a.payload && a.payload.src) ||
          '';
        if (url) attachments.push({ url, type: safeStr(type || 'media') });
      }
    } else {
      const type = att && att.type;
      const url =
        (att && att.payload && att.payload.url) ||
        (att && att.url) ||
        (att && att.payload && att.payload.src) ||
        '';
      if (url) attachments.push({ url, type: safeStr(type || 'media') });
    }
  }
  const temMidia = attachments.length > 0;

  const ts =
    Number(payload && (payload.sent_at || payload.timestamp)) ||
    Date.now();

  const messageId =
    safeStr(payload && (payload.message_id || payload.mid || payload.id)) || undefined;

  return {
    contato,
    texto,
    temMidia,
    midias: attachments,
    ts,
    origem: 'manychat',
    messageId
  };
}

/**
 * Stub do Meta Graph (não utilizado agora, mas mantido no código)
 */
function normalizeMetaGraph(body) {
  // TODO: implementar quando ativarmos o conector
  return null;
}

/**
 * Handler genérico para uma mensagem já normalizada.
 * - garante estado
 * - LOGA apenas a mensagem recebida (como pedido)
 */
async function handleIncomingNormalizedMessage(normalized) {
  if (!normalized) return;

  const { contato, texto, temMidia, ts } = normalized;

  // Ignora eventos sem texto e sem mídia
  const hasText = !!safeStr(texto);
  const hasMedia = !!temMidia;
  if (!hasText && !hasMedia) return;

  const estado = ensureEstado(contato);

  // Log **apenas** da mensagem recebida do usuário, no formato solicitado
  const pvw = hasText ? `"${previewText(texto)}"` : '';
  const midiaFlag = hasMedia ? ' [MÍDIA]' : '';
  log.info(`[${contato}] etapa=${estado.etapa} in=${pvw}${midiaFlag}`);

  // Atualiza último ts visto (útil para futuras lógicas)
  estado.lastIncomingTs = ts;
}

/**
 * Handlers públicos
 * - init: permite trocar logger se quiser
 * - handleManyChatWebhook: recebe o body do webhook e processa
 * - processarMensagensPendentes: alias de compat (no-op por enquanto)
 */
function init(options = {}) {
  if (options.logger) {
    // Precisa suportar info/warn/error
    const { info, warn, error } = options.logger;
    if (typeof info === 'function' && typeof warn === 'function' && typeof error === 'function') {
      log = options.logger;
    }
  }
  return { ok: true };
}

async function handleManyChatWebhook(body) {
  try {
    const normalized = normalizeManyChat(body);
    await handleIncomingNormalizedMessage(normalized);
    return { ok: true };
  } catch (err) {
    log.error(`[manychat] erro ao processar webhook: ${err && err.message}`);
    return { ok: false, error: err && err.message };
  }
}

// Alias de compatibilidade: alguns trechos antigos podem chamar isso.
// No v0 não há fila/envio, então apenas garante estado e retorna.
async function processarMensagensPendentes(contato) {
  ensureEstado(contato);
  return { ok: true, noop: true };
}

/**
 * Exports
 */
module.exports = {
  init,
  handleManyChatWebhook,
  handleIncomingNormalizedMessage,
  processarMensagensPendentes, // compat no-op
  // stubs/normalizadores expostos se precisar testar
  _normalize: {
    manychat: normalizeManyChat,
    meta: normalizeMetaGraph,
  },
  _utils: { ensureEstado, previewText },
};
