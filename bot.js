'use strict';

const estadoContatos = require('./state.js');

let log = console;

function safeStr(v) { return (v === null || v === undefined) ? '' : String(v); }

function previewText(text, max = 120) {
  const t = safeStr(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function normalizeContato(raw) {
  const n = safeStr(raw).replace(/\D/g, '');
  return n;
}

function ensureEstado(contato) {
  const key = safeStr(contato) || 'desconhecido';
  if (!estadoContatos[key]) {
    estadoContatos[key] = {
      contato: key,
      etapa: 'none',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } else {
    estadoContatos[key].updatedAt = Date.now();
  }
  return estadoContatos[key];
}

function inicializarEstado(contato, overrides = {}) {
  const norm = normalizeContato(contato);
  const estado = ensureEstado(norm);
  if (overrides && typeof overrides === 'object') {
    for (const k of Object.keys(overrides)) estado[k] = overrides[k];
    estado.updatedAt = Date.now();
  }
  return estado;
}

function decidirOptLabel(texto) {
  const t = safeStr(texto).toLowerCase();
  const patterns = [
    /\bpar(a|e)\b/,
    /\bpare\b/,
    /\bchega\b/,
    /\bremover\b/,
    /\bremova\b/,
    /\bnao\s*quero\b/,
    /\bsem\s*mensagem\b/,
    /\bstop\b/,
    /\bcancel(ar)?\b/,
    /\bdesinscrever\b/,
    /\bunsubscribe\b/,
    /\bnao\s*me\s*chame\b/,
    /\bnao\s*mand(a|e)\b/
  ];
  const isOptout = patterns.some(r => r.test(t));
  return isOptout ? 'OPTOUT' : 'NAO_OPTOUT';
}

function normalizeManyChat(body) {
  const payload = body && (body.payload || body);
  const user = payload && (payload.user || payload.contact || payload.subscriber);
  const msg = payload && payload.message;

  const rawPhone = safeStr(user && (user.phone || user.whatsapp || user.msisdn)).replace(/\D/g, '');
  const contato = rawPhone || 'desconhecido';

  const texto =
    safeStr((msg && msg.text) ||
            (msg && msg.input && msg.input.text) ||
            payload.text ||
            payload.message_text ||
            '');

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

function normalizeMetaGraph() {
  return null;
}

async function handleIncomingNormalizedMessage(normalized) {
  if (!normalized) return;
  const { contato, texto, temMidia, ts } = normalized;
  const hasText = !!safeStr(texto);
  const hasMedia = !!temMidia;
  if (!hasText && !hasMedia) return;
  const estado = ensureEstado(contato);
  const pvw = hasText ? `"${previewText(texto)}"` : '';
  const midiaFlag = hasMedia ? ' [MÍDIA]' : '';
  log.info(`[${estado.contato}] etapa=${estado.etapa} in=${pvw}${midiaFlag}`);
  estado.lastIncomingTs = ts;
}

function init(options = {}) {
  if (options.logger) {
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

async function processarMensagensPendentes(contato) {
  ensureEstado(contato);
  return { ok: true, noop: true };
}

module.exports = {
  init,
  handleManyChatWebhook,
  handleIncomingNormalizedMessage,
  processarMensagensPendentes,
  inicializarEstado,
  decidirOptLabel,
  _normalize: {
    manychat: normalizeManyChat,
    meta: normalizeMetaGraph,
  },
  _utils: { ensureEstado, previewText, normalizeContato },
};
