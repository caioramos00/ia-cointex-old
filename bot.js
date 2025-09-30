'use strict';

const axios = require('axios');
const estadoContatos = require('./state.js');

let log = console;

function safeStr(v) { return (v === null || v === undefined) ? '' : String(v); }
function previewText(text, max = 120) { const t = safeStr(text).replace(/\s+/g, ' ').trim(); return t ? (t.length > max ? t.slice(0, max - 1) + '…' : t) : ''; }
function normalizeContato(raw) { return safeStr(raw).replace(/\D/g, ''); }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function ensureEstado(contato) {
  const key = safeStr(contato) || 'desconhecido';
  if (!estadoContatos[key]) {
    estadoContatos[key] = {
      contato: key,
      etapa: 'none',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mensagensPendentes: [],
      mensagensDesdeSolicitacao: [],
      enviandoMensagens: false,
      tid: '',
      click_type: 'Orgânico',
    };
  } else {
    estadoContatos[key].updatedAt = Date.now();
    if (!Array.isArray(estadoContatos[key].mensagensPendentes)) estadoContatos[key].mensagensPendentes = [];
    if (!Array.isArray(estadoContatos[key].mensagensDesdeSolicitacao)) estadoContatos[key].mensagensDesdeSolicitacao = [];
  }
  return estadoContatos[key];
}

function inicializarEstado(contato, maybeTid, maybeClickType) {
  const st = ensureEstado(contato);
  if (typeof maybeTid === 'string') st.tid = maybeTid || st.tid || '';
  if (typeof maybeClickType === 'string') st.click_type = maybeClickType || st.click_type || 'Orgânico';
  return st;
}

function decidirOptLabel(texto) {
  const t = safeStr(texto).toLowerCase();
  const out = [
    /\bpar(a|e)\b/, /\bpare\b/, /\bchega\b/, /\bremover\b/, /\bremova\b/,
    /\bnao\s*quero\b/, /\bsem\s*mensagem\b/, /\bstop\b/, /\bcancel(ar)?\b/,
    /\bdesinscrever\b/, /\bunsubscribe\b/, /\bnao\s*me\s*chame\b/, /\bnao\s*mand(a|e)\b/
  ].some(r => r.test(t));
  return out ? 'OPTOUT' : 'NAO_OPTOUT';
}

async function criarUsuarioDjango(contato) {
  const st = ensureEstado(contato);
  if (st.credenciais) return { ok: true, skipped: true };
  const phone = st.contato.startsWith('+') ? st.contato : `+${st.contato}`;
  const payload = { tid: st.tid || '', click_type: st.click_type || 'Orgânico', phone };
  const resp = await axios.post('https://www.cointex.cash/api/create-user/', payload, { timeout: 15000, validateStatus: () => true });
  if (resp.status >= 200 && resp.status < 300) {
    const user = Array.isArray(resp.data?.users) ? resp.data.users[0] : null;
    if (user?.email && user?.password) st.credenciais = { email: user.email, password: user.password, login_url: user.login_url || '' };
    return { ok: true, status: resp.status, data: resp.data };
  }
  const msg = resp.data?.message || `HTTP ${resp.status}`;
  throw new Error(msg);
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
    if (typeof info === 'function' && typeof warn === 'function' && typeof error === 'function') log = options.logger;
  }
  return { ok: true };
}

async function handleManyChatWebhook(body) { return { ok: true }; }
async function processarMensagensPendentes(contato) { ensureEstado(contato); return { ok: true, noop: true }; }
async function sendMessage(contato, texto) { console.log(`[${contato}] OUT: "${safeStr(texto)}"`); return { ok: true }; }
async function retomarEnvio(contato) { console.log(`[${contato}] retomarEnvio()`); return { ok: true }; }

module.exports = {
  init,
  handleManyChatWebhook,
  handleIncomingNormalizedMessage,
  processarMensagensPendentes,
  inicializarEstado,
  decidirOptLabel,
  criarUsuarioDjango,
  delay,
  sendMessage,
  retomarEnvio,
  _utils: { ensureEstado, previewText, normalizeContato },
};
