'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const estadoContatos = require('./state.js');
const { getActiveTransport } = require('./lib/transport');
const { getContatoByPhone } = require('./db');

let log = console;

function safeStr(v) { return (v === null || v === undefined) ? '' : String(v); }
function normalizeContato(raw) { return safeStr(raw).replace(/\D/g, ''); }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const FIRST_REPLY_DELAY_MS = 15000;
const BETWEEN_MIN_MS = 12000;
const BETWEEN_MAX_MS = 16000;
function delayRange(minMs, maxMs) { const d = Math.floor(minMs + Math.random() * (maxMs - minMs)); return delay(d); }

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
      sentHashes: new Set(),
      classificacaoAceite: null,
    };
  } else {
    estadoContatos[key].updatedAt = Date.now();
    if (!Array.isArray(estadoContatos[key].mensagensPendentes)) estadoContatos[key].mensagensPendentes = [];
    if (!Array.isArray(estadoContatos[key].mensagensDesdeSolicitacao)) estadoContatos[key].mensagensDesdeSolicitacao = [];
    if (!(estadoContatos[key].sentHashes instanceof Set)) estadoContatos[key].sentHashes = new Set(Array.isArray(estadoContatos[key].sentHashes) ? estadoContatos[key].sentHashes : []);
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
  if (st.createdUser === 'ok' || st.credenciais) return { ok: true, skipped: true };
  if (st.createdUser === 'pending') return { ok: true, skipped: 'pending' };
  st.createdUser = 'pending';
  const phone = st.contato.startsWith('+') ? st.contato : `+${st.contato}`;
  const payload = { tid: st.tid || '', click_type: st.click_type || 'Orgânico', phone };
  try {
    const resp = await axios.post('https://www.cointex.cash/api/create-user/', payload, { timeout: 15000, validateStatus: () => true });
    if (resp.status >= 200 && resp.status < 300) {
      const user = Array.isArray(resp.data?.users) ? resp.data.users[0] : null;
      if (user?.email && user?.password) st.credenciais = { email: user.email, password: user.password, login_url: user.login_url || '' };
      st.createdUser = 'ok';
      console.log(`[Contato] Cointex criado: ${st.contato} ${st.credenciais?.email || ''}`.trim());
      return { ok: true, status: resp.status, data: resp.data };
    }
    const msg = resp.data?.message || `HTTP ${resp.status}`;
    st.createdUser = undefined;
    console.warn(`[Contato] Cointex ERRO: ${st.contato} ${msg}`);
    throw new Error(msg);
  } catch (err) {
    st.createdUser = undefined;
    console.warn(`[Contato] Cointex ERRO: ${st.contato} ${err.message || err}`);
    throw err;
  }
}

const sentHashesGlobal = new Set();
function hashText(s) { let h = 0, i, chr; const str = String(s); if (str.length === 0) return '0'; for (i = 0; i < str.length; i++) { chr = str.charCodeAt(i); h = ((h << 5) - h) + chr; h |= 0; } return String(h); }
function chooseUnique(generator, st) { const maxTries = 200; for (let i = 0; i < maxTries; i++) { const text = generator(); const h = hashText(text); if (!sentHashesGlobal.has(h) && !st.sentHashes.has(h)) { sentHashesGlobal.add(h); st.sentHashes.add(h); return text; } } return null; }

function stripDiacritics(s) { return s.normalize('NFD').replace(/\p{Diacritic}/gu, ''); }
function normalizeText(s) { return stripDiacritics(String(s || '').toLowerCase()).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); }
function squashRepeats(s) { return s.replace(/(.)\1{2,}/g, '$1$1'); }

function classifyAceiteFromContext(contextoRaw) {
  const ctx = squashRepeats(normalizeText(contextoRaw || ''));
  if (!ctx) return 'duvida';
  const tokens = ctx.split(/\s+/);
  const has = (rx) => rx.test(ctx);

  const aceiteTerms = [
    /\bsi+m+\b/, /\bss+\b/, /\bclaro\b/, /\bcerto\b/, /\bfechad[oa]\b/, /\bfechou\b/,
    /\bbora\b/, /\b(vamo|vamos|vambora)\b/, /\bpartiu\b/, /\bpra cima\b/,
    /\bto? (dentro|on)\b/, /\bt[oô] dentro\b/, /\bt[oô] on\b/,
    /\bok(ay|ey)?\b/, /\bblz\b/, /\bbele(z|s)a?\b/, /\bshow\b/, /\bsuave\b/, /\bfirmeza|fmz\b/,
    /\bpode ser\b/, /\bpode pa\b/, /\bpdp\b/, /\bdemoro(u)?\b/, /\bcuida\b/, /\bagora\b/
  ];
  const negTerms = [/\bnao?\b/, /\bn\b/, /\bnegativo\b/, /\bnunca\b/, /\bnop(e)?\b/];
  const duvidaTerms = [/\bcomo\b/, /\bfunciona\b/, /\bseguro\b/, /\bque trampo\b/, /\bqual\b/, /\bonde\b/, /\bquando\b/, /\blink\b/, /\bajuda\b/, /\bduvida\b/, /\b?\b/];

  const indicesAceite = [];
  aceiteTerms.forEach(rx => { let m; const r = new RegExp(rx, 'g'); while ((m = r.exec(ctx)) !== null) indicesAceite.push(m.index); });

  if (indicesAceite.length) {
    let hasNegNear = false;
    negTerms.forEach(nrx => {
      let m; const r = new RegExp(nrx, 'g');
      while ((m = r.exec(ctx)) !== null) {
        const before = ctx.slice(0, m.index).split(/\s+/).length;
        indicesAceite.forEach(ai => {
          const aBefore = ctx.slice(0, ai).split(/\s+/).length;
          const dist = Math.abs(before - aBefore);
          if (dist <= 3) hasNegNear = true;
        });
      }
    });
    if (hasNegNear) return 'recusa';
    return 'aceite';
  }

  if (duvidaTerms.some(rx => has(rx))) return 'duvida';
  if (negTerms.some(rx => has(rx))) return 'recusa';
  return 'duvida';
}

async function handleIncomingNormalizedMessage(normalized) {
  if (!normalized) return;
  const { contato, texto, temMidia, ts } = normalized;
  const hasText = !!safeStr(texto);
  const hasMedia = !!temMidia;
  if (!hasText && !hasMedia) return;
  const estado = ensureEstado(contato);
  const msg = hasText ? safeStr(texto).trim() : '[mídia]';
  log.info(`[${estado.contato}] ${msg}`);
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

async function processarMensagensPendentes(contato) {
  const st = ensureEstado(contato);
  if (st.enviandoMensagens) return { ok: true, skipped: 'busy' };
  st.enviandoMensagens = true;
  try {
    console.log(`[${st.contato}] etapa=${st.etapa} pendentes=${st.mensagensPendentes.length}`);

    if (st.etapa === 'none') {
      const aberturaPath = path.join(__dirname, 'content', 'abertura.json');
      let aberturaData = null;
      const loadAbertura = () => {
        if (aberturaData) return aberturaData;
        try {
          const raw = fs.readFileSync(aberturaPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (!parsed?.msg1?.grupo1?.length || !parsed?.msg1?.grupo2?.length || !parsed?.msg1?.grupo3?.length) throw new Error('content/abertura.json incompleto: msg1.* ausente');
          if (!parsed?.msg2?.grupo1?.length || !parsed?.msg2?.grupo2?.length || !parsed?.msg2?.grupo3?.length) throw new Error('content/abertura.json incompleto: msg2.* ausente');
          aberturaData = parsed;
        } catch {
          aberturaData = { msg1: { grupo1: ['salve'], grupo2: ['tô precisando de alguém pro trampo agora'], grupo3: ['tá disponível?'] }, msg2: { grupo1: ['nem liga pro nome desse whats,'], grupo2: ['número empresarial q usamos pros trampo'], grupo3: ['pode salvar como "Ryan"'] } };
        }
        return aberturaData;
      };
      const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
      const composeAberturaMsg1 = () => { const c = loadAbertura(); const g1 = pick(c.msg1.grupo1); const g2 = pick(c.msg1.grupo2); const g3 = pick(c.msg1.grupo3); return [g1, g2, g3].filter(Boolean).join(', '); };
      const composeAberturaMsg2 = () => { const c = loadAbertura(); const g1 = pick(c.msg2.grupo1); const g2 = pick(c.msg2.grupo2); const g3 = pick(c.msg2.grupo3); const head = [g1, g2].filter(Boolean).join(' '); return [head, g3].filter(Boolean).join(', '); };

      await delay(FIRST_REPLY_DELAY_MS);

      let m1 = chooseUnique(composeAberturaMsg1, st) || composeAberturaMsg1();
      let m2 = chooseUnique(composeAberturaMsg2, st) || composeAberturaMsg2();

      if (m1) await sendMessage(st.contato, m1);
      await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
      if (m2) await sendMessage(st.contato, m2);

      st.mensagensPendentes = [];
      st.mensagensDesdeSolicitacao = [];
      st.etapa = 'abertura:wait';
      console.log(`[${st.contato}] etapa->${st.etapa}`);
      return { ok: true };
    }

    if (st.etapa === 'abertura:wait') {
      if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

      const interessePath = path.join(__dirname, 'content', 'interesse.json');
      let interesseData = null;
      const loadInteresse = () => {
        if (interesseData) return interesseData;
        try {
          const raw = fs.readFileSync(interessePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (!parsed?.msg?.g1?.length || !parsed?.msg?.g2?.length || !parsed?.msg?.g3?.length || !parsed?.msg?.g4?.length || !parsed?.msg?.g5?.length) throw new Error('content/interesse.json incompleto');
          interesseData = parsed;
        } catch {
          interesseData = { msg: { g1: ['tô na correria aqui'], g2: ['fazendo vários ao mesmo tempo'], g3: ['vou te mandando tudo o que você tem que fazer'], g4: ['e você só responde o que eu te perguntar'], g5: ['beleza?'] } };
        }
        return interesseData;
      };
      const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
      const composeInteresseMsg = () => { const c = loadInteresse(); const g1 = pick(c.msg.g1); const g2 = pick(c.msg.g2); const g3 = pick(c.msg.g3); const g4 = pick(c.msg.g4); const g5 = pick(c.msg.g5); return `${[g1, g2].filter(Boolean).join(', ')}... ${g3}, ${g4}, ${g5}`.replace(/\s+,/g, ','); };

      const mi = chooseUnique(composeInteresseMsg, st) || composeInteresseMsg();
      await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
      if (mi) await sendMessage(st.contato, mi);

      st.mensagensPendentes = [];
      st.mensagensDesdeSolicitacao = [];
      st.etapa = 'interesse:wait';
      console.log(`[${st.contato}] etapa->${st.etapa}`);
      return { ok: true };
    }

    if (st.etapa === 'interesse:wait') {
      if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };
      const contexto = (st.mensagensDesdeSolicitacao || []).join('\n').trim();
      const classe = classifyAceiteFromContext(contexto);
      st.classificacaoAceite = classe;
      console.log(`[${st.contato}] interesse.class=${classe} ctx="${contexto}"`);
      st.mensagensPendentes = [];
      st.mensagensDesdeSolicitacao = [];
      st.etapa = 'interesse:classified';
      console.log(`[${st.contato}] etapa->${st.etapa}`);
      return { ok: true, classe };
    }

    st.mensagensPendentes = [];
    return { ok: true };
  } finally {
    st.enviandoMensagens = false;
  }
}

async function sendMessage(contato, texto) {
  const msg = safeStr(texto);
  try {
    const { mod, settings } = await getActiveTransport();
    const provider = mod?.name || 'unknown';

    if (provider === 'manychat') {
      let subscriberId = null;
      try {
        const c = await getContatoByPhone(contato);
        subscriberId = c?.manychat_subscriber_id || c?.subscriber_id || null;
      } catch {}
      if (!subscriberId) {
        const st = ensureEstado(contato);
        if (st.manychat_subscriber_id) subscriberId = st.manychat_subscriber_id;
      }
      if (!subscriberId) {
        console.log(`[${contato}] envio=fail provider=manychat reason=no-subscriber-id msg="${msg}"`);
        return { ok: false, reason: 'no-subscriber-id' };
      }
      await mod.sendText({ subscriberId, text: msg }, settings);
      console.log(`[${contato}] envio=ok provider=manychat msg="${msg}"`);
      return { ok: true, provider };
    }

    console.log(`[${contato}] envio=fail provider=${provider} reason=unsupported msg="${msg}"`);
    return { ok: false, reason: 'unsupported' };
  } catch (e) {
    console.log(`[${contato}] envio=fail provider=unknown reason="${e.message}" msg="${msg}"`);
    return { ok: false, error: e.message };
  }
}

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
  _utils: { ensureEstado, normalizeContato },
};
