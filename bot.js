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
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
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
            sentHashes: new Set(),
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

const aberturaPath = path.join(__dirname, 'content', 'abertura.json');
let aberturaCache = null;

function loadAbertura() {
    if (aberturaCache) return aberturaCache;
    try {
        const raw = fs.readFileSync(aberturaPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed?.msg1?.grupo1?.length || !parsed?.msg1?.grupo2?.length || !parsed?.msg1?.grupo3?.length) {
            throw new Error('content/abertura.json incompleto: msg1.* ausente');
        }
        if (!parsed?.msg2?.grupo1?.length || !parsed?.msg2?.grupo2?.length || !parsed?.msg2?.grupo3?.length) {
            throw new Error('content/abertura.json incompleto: msg2.* ausente');
        }
        aberturaCache = parsed;
        return aberturaCache;
    } catch (e) {
        aberturaCache = {
            msg1: { grupo1: ['salve'], grupo2: ['tô precisando de alguém pro trampo agora'], grupo3: ['tá disponível?'] },
            msg2: { grupo1: ['nem liga pro nome desse whats,'], grupo2: ['número empresarial q usamos pros trampo'], grupo3: ['pode salvar como "Ryan"'] }
        };
        return aberturaCache;
    }
}

const sentHashesGlobal = new Set();
function hashText(s) {
    let h = 0, i, chr;
    const str = String(s);
    if (str.length === 0) return '0';
    for (i = 0; i < str.length; i++) {
        chr = str.charCodeAt(i);
        h = ((h << 5) - h) + chr;
        h |= 0;
    }
    return String(h);
}

function pick(arr) { return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : ''; }

function composeAberturaMsg1() {
    const c = loadAbertura();
    const g1 = pick(c?.msg1?.grupo1);
    const g2 = pick(c?.msg1?.grupo2);
    const g3 = pick(c?.msg1?.grupo3);
    return [g1, g2, g3].filter(Boolean).join(', ');
}

function composeAberturaMsg2() {
    const c = loadAbertura();
    const g1 = pick(c?.msg2?.grupo1);
    const g2 = pick(c?.msg2?.grupo2);
    const g3 = pick(c?.msg2?.grupo3);
    const head = [g1, g2].filter(Boolean).join(' ');
    return [head, g3].filter(Boolean).join(', ');
}

function chooseUnique(generator, st) {
    const maxTries = 200;
    for (let i = 0; i < maxTries; i++) {
        const text = generator();
        const h = hashText(text);
        if (!sentHashesGlobal.has(h) && !st.sentHashes.has(h)) {
            sentHashesGlobal.add(h);
            st.sentHashes.add(h);
            return text;
        }
    }
    return null;
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
            // primeira resposta do contato: aguardar 15s apenas uma vez
            if (!st.firstReplyDone) {
                await delay(15000);
                st.firstReplyDone = true;
            }

            let m1 = chooseUnique(composeAberturaMsg1, st);
            let m2 = chooseUnique(composeAberturaMsg2, st);

            if (!m1) { m1 = composeAberturaMsg1(); }
            if (!m2) { m2 = composeAberturaMsg2(); }

            if (m1) await sendMessage(st.contato, m1);

            // delay padrão entre mensagens: 12s–16s (aleatório)
            await delay(randInt(12000, 16000));

            if (m2) await sendMessage(st.contato, m2);

            st.etapa = 'abertura:done';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
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
        console.warn(`[${contato}] envio=fail provider=manychat reason=no-subscriber-id msg="${msg}"`);
        return { ok: false, reason: 'no-subscriber-id' };
      }

      await mod.sendText({ subscriberId, text: msg }, settings);
      console.log(`[${contato}] envio=ok provider=manychat msg="${msg}"`);
      return { ok: true, provider };
    }

    if (provider === 'meta') {
      console.warn(`[${contato}] envio=fail provider=meta reason=not-implemented msg="${msg}"`);
      return { ok: false, reason: 'meta-not-implemented' };
    }

    console.warn(`[${contato}] envio=fail provider=${provider} reason=unknown-provider msg="${msg}"`);
    return { ok: false, reason: 'unknown-provider' };
  } catch (e) {
    console.error(`[${contato}] envio=error provider=unknown err="${e.message}" msg="${msg}"`);
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
