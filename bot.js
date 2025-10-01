'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const estadoContatos = require('./state.js');
const { getActiveTransport } = require('./lib/transport');
const { getContatoByPhone } = require('./db');
const { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia } = require('./prompts');

let log = console;

function safeStr(v) { return (v === null || v === undefined) ? '' : String(v); }
function normalizeContato(raw) { return safeStr(raw).replace(/\D/g, ''); }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const FIRST_REPLY_DELAY_MS = 15000;
const BETWEEN_MIN_MS = 12000;
const BETWEEN_MAX_MS = 16000;
const EXTRA_GLOBAL_DELAY_MIN_MS = 5000;
const EXTRA_GLOBAL_DELAY_MAX_MS = 10000;
function extraGlobalDelay() {
    const d = Math.floor(EXTRA_GLOBAL_DELAY_MIN_MS + Math.random() * (EXTRA_GLOBAL_DELAY_MAX_MS - EXTRA_GLOBAL_DELAY_MIN_MS));
    return delay(d);
}
function delayRange(minMs, maxMs) { const d = Math.floor(minMs + Math.random() * (maxMs - minMs)); return delay(d); }

function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min));
}

function pickLabelFromResponseData(data, allowed) {
    const S = new Set((allowed || []).map(s => String(s).toLowerCase()));
    let label =
        data?.output?.[0]?.content?.[0]?.json?.label ??
        data?.output?.[0]?.content?.[0]?.text ??
        data?.choices?.[0]?.message?.content ??
        data?.result ??
        data?.output_text ??
        (typeof data === 'string' ? data : '');
    if (typeof label === 'string') {
        const raw = label.trim();
        if (raw.startsWith('{') || raw.startsWith('[')) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed.label === 'string') label = parsed.label;
            } catch { }
        }
    }
    if (typeof label === 'string') {
        const rx = new RegExp(`\\b(${Array.from(S).join('|')})\\b`, 'i');
        const m = rx.exec(label.toLowerCase());
        if (m) label = m[1];
    }
    label = String(label || '').trim().toLowerCase();
    return S.has(label) ? label : null;
}

function truncate(s, n = 600) {
    const str = String(s || '');
    return str.length > n ? str.slice(0, n) + '…[truncated]' : str;
}

function extractTextForLog(data) {
    return (
        (typeof data?.output_text === 'string' && data.output_text) ||
        (typeof data?.output?.[0]?.content?.[0]?.text === 'string' && data.output[0].content[0].text) ||
        (typeof data?.choices?.[0]?.message?.content === 'string' && data.choices[0].message.content) ||
        (typeof data?.result === 'string' && data.result) ||
        (typeof data === 'string' ? data : JSON.stringify(data))
    );
}

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
            classesSinceSolicitacao: [],
            lastClassifiedIdx: { interesse: 0, acesso: 0, confirmacao: 0, saque: 0, validacao: 0, conversao: 0 },
            saquePediuPrint: false,
            validacaoAwaitFirstMsg: false,
            validacaoTimeoutUntil: 0,
            conversaoBatch: 0,
            conversaoAwaitMsg: false
        };
    } else {
        const st = estadoContatos[key];
        st.updatedAt = Date.now();
        if (!Array.isArray(st.mensagensPendentes)) st.mensagensPendentes = [];
        if (!Array.isArray(st.mensagensDesdeSolicitacao)) st.mensagensDesdeSolicitacao = [];
        if (!(st.sentHashes instanceof Set)) st.sentHashes = new Set(Array.isArray(st.sentHashes) ? st.sentHashes : []);
        if (!st.lastClassifiedIdx) st.lastClassifiedIdx = { interesse: 0, acesso: 0, confirmacao: 0, saque: 0, validacao: 0, conversao: 0 };
        for (const k of ['interesse', 'acesso', 'confirmacao', 'saque', 'validacao', 'conversao']) {
            if (typeof st.lastClassifiedIdx[k] !== 'number' || st.lastClassifiedIdx[k] < 0) st.lastClassifiedIdx[k] = 0;
        }
        if (typeof st.saquePediuPrint !== 'boolean') st.saquePediuPrint = false;
        if (typeof st.validacaoAwaitFirstMsg !== 'boolean') st.validacaoAwaitFirstMsg = false;
        if (typeof st.validacaoTimeoutUntil !== 'number') st.validacaoTimeoutUntil = 0;

        if (typeof st.conversaoBatch !== 'number') st.conversaoBatch = 0;
        if (typeof st.conversaoAwaitMsg !== 'boolean') st.conversaoAwaitMsg = false;
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
  const URL = 'https://www.cointex.cash/api/create-user/';

  const tryOnce = async () =>
    axios.post(URL, payload, { timeout: 15000, validateStatus: () => true });

  try {
    let resp = await tryOnce();

    // Retry único para erros transitórios de infra / rate limit
    if (resp.status >= 500 || resp.status === 429) {
      const jitter = 1200 + Math.floor(Math.random() * 400); // 1.2s–1.6s
      console.warn(`[Contato] Cointex retry agendado em ${jitter}ms: ${st.contato} HTTP ${resp.status}`);
      await delay(jitter);
      resp = await tryOnce();
    }

    const okHttp = resp.status >= 200 && resp.status < 300;
    const okBody = !resp.data?.status || resp.data?.status === 'success';

    if (okHttp && okBody) {
      const user = Array.isArray(resp.data?.users) ? resp.data.users[0] : null;
      if (user?.email && user?.password) {
        st.credenciais = {
          email: user.email,
          password: user.password,
          login_url: user.login_url || ''
        };
      }
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

async function sendImage(contato, imageUrl, caption) {
  await extraGlobalDelay();
  const url = safeStr(imageUrl).trim();
  if (!url) return { ok: false, reason: 'empty-image-url' };

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
        console.log(`[${contato}] envio=fail provider=manychat reason=no-subscriber-id image="${url}"`);
        return { ok: false, reason: 'no-subscriber-id' };
      }

      if (typeof mod.sendImage === 'function') {
        await mod.sendImage({ subscriberId, imageUrl: url, caption }, settings);
        console.log(`[${contato}] envio=ok provider=manychat image="${url}"`);
        return { ok: true, provider };
      } else {
        console.log(`[${contato}] envio=fail provider=manychat reason=no-sendImage image="${url}"`);
        return { ok: false, reason: 'no-sendImage' };
      }
    }

    console.log(`[${contato}] envio=fail provider=${provider} reason=unsupported image="${url}"`);
    return { ok: false, reason: 'unsupported' };
  } catch (e) {
    console.log(`[${contato}] envio=fail provider=unknown reason="${e.message}" image="${url}"`);
    return { ok: false, error: e.message };
  }
}

const sentHashesGlobal = new Set();
function hashText(s) { let h = 0, i, chr; const str = String(s); if (str.length === 0) return '0'; for (i = 0; i < str.length; i++) { chr = str.charCodeAt(i); h = ((h << 5) - h) + chr; h |= 0; } return String(h); }
function chooseUnique(generator, st) { const maxTries = 200; for (let i = 0; i < maxTries; i++) { const text = generator(); const h = hashText(text); if (!sentHashesGlobal.has(h) && !st.sentHashes.has(h)) { sentHashesGlobal.add(h); st.sentHashes.add(h); return text; } } return null; }

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
                    let raw = fs.readFileSync(aberturaPath, 'utf8');
                    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
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
            st.lastClassifiedIdx.interesse = 0;

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
            st.lastClassifiedIdx.interesse = 0;
            st.etapa = 'interesse:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'interesse:wait') {
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.interesse || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }
            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;

            let classes = [];
            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                const prompt = promptClassificaAceite(msg);

                let msgClass = 'duvida';
                if (apiKey) {
                    const allowed = ['aceite', 'recusa', 'duvida'];
                    const structuredPrompt = `${prompt}\n\nOutput only this valid JSON format with double quotes around keys and values, nothing else: {"label": "aceite"} or {"label": "recusa"} or {"label": "duvida"}`;

                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
                                'https://api.openai.com/v1/responses',
                                {
                                    model: 'gpt-5',
                                    input: structuredPrompt,
                                    max_output_tokens: maxTok,
                                    reasoning: { effort: 'low' }
                                },
                                {
                                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                                    timeout: 15000,
                                    validateStatus: () => true
                                }
                            );
                        } catch {
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
                        if (!rawText) rawText = extractTextForLog(data);
                        rawText = String(rawText || '').trim();
                        let picked = null;
                        if (rawText) {
                            try {
                                const parsed = JSON.parse(rawText);
                                if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                            } catch {
                                const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                                if (m && m[1]) picked = m[1].toLowerCase().trim();
                            }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, allowed);
                        return { status: r.status, picked };
                    };

                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) {
                            resp = await callOnce(256);
                        }
                        if (resp.status >= 200 && resp.status < 300 && resp.picked) {
                            msgClass = resp.picked;
                        }
                    } catch { }
                }
                classes.push(msgClass);
            }

            st.lastClassifiedIdx.interesse = total;

            let classe = 'duvida';
            const nonDuvida = classes.filter(c => c !== 'duvida');
            classe = nonDuvida.length > 0 ? nonDuvida[nonDuvida.length - 1] : 'duvida';

            st.classificacaoAceite = classe;
            st.mensagensPendentes = [];
            if (classe === 'aceite') {
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.interesse = 0;
                st.etapa = 'instrucoes:send';
            } else {
                return { ok: true, classe };
            }

        }

        if (st.etapa === 'instrucoes:send') {
            const instrucoesPath = path.join(__dirname, 'content', 'instrucoes.json');
            let instrucoesData = null;
            const loadInstrucoes = () => {
                if (instrucoesData) return instrucoesData;
                try {
                    let raw = fs.readFileSync(instrucoesPath, 'utf8');
                    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                    const parsed = JSON.parse(raw);
                    if (
                        !parsed?.msg1?.grupo1?.length || !parsed?.msg1?.grupo2?.length || !parsed?.msg1?.grupo3?.length ||
                        !parsed?.pontos?.p1?.g1?.length || !parsed?.pontos?.p1?.g2?.length || !parsed?.pontos?.p1?.g3?.length ||
                        !parsed?.pontos?.p2?.g1?.length || !parsed?.pontos?.p2?.g2?.length || !parsed?.pontos?.p2?.g3?.length ||
                        !parsed?.pontos?.p3?.g1?.length || !parsed?.pontos?.p3?.g2?.length || !parsed?.pontos?.p3?.g3?.length ||
                        !parsed?.pontos?.p4?.g1?.length || !parsed?.pontos?.p4?.g2?.length || !parsed?.pontos?.p4?.g3?.length ||
                        !parsed?.msg3?.grupo1?.length || !parsed?.msg3?.grupo2?.length
                    ) throw new Error('content/instrucoes.json incompleto');
                    instrucoesData = parsed;
                } catch {
                    instrucoesData = {
                        msg1: {
                            grupo1: ["salvou o contato", "salvou o número"],
                            grupo2: ["salva ai que se aparecer outro trampo eu te chamo tambem", "salva aí que se aparecer outro trampo eu te chamo também"],
                            grupo3: ["vou te mandar o passo a passo do que precisa pra fazer certinho", "vou te mandar o passo a passo do que precisa pra fazer direitinho"]
                        },
                        pontos: {
                            p1: { g1: ["você precisa de uma conta com pix ativo pra receber", "você precisa ter uma conta com pix ativo pra receber"], g2: ["pode ser qualquer banco", "pode ser qlqr banco"], g3: ["so nao da certo se for o SICOOB", "só não dá certo se for o SICOOB"] },
                            p2: { g1: ["se tiver dados moveis", "se tiver dados móveis"], g2: ["desativa o wi-fi", "desliga o wi-fi"], g3: ["mas se nao tiver deixa no wifi mesmo", "mas se não tiver deixa no wifi mesmo"] },
                            p3: { g1: ["vou passar o email e a senha de uma conta pra você acessar", "vou passar o e-mail e a senha de uma conta pra você acessar"], g2: ["lá vai ter um saldo disponível", "lá vai ter um saldo disponivel"], g3: ["é só você transferir pra sua conta, mais nada", "é só vc transferir pra sua conta, mais nada"] },
                            p4: { g1: ["sua parte vai ser 2000", "você vai receber 2000"], g2: ["o restante manda pra minha conta logo que cair", "o restante você manda pra minha conta logo que cair"], g3: ["eu vou te passar a chave pix depois", "depois eu te passo a chave pix"] }
                        },
                        msg3: { grupo1: ["é tranquilinho", "é tranquilo"], grupo2: ["a gente vai fazendo parte por parte pra nao ter erro blz", "a gente vai fazendo parte por parte pra não ter erro blz"] }
                    };
                }
                return instrucoesData;
            };

            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

            const composeMsg1 = () => {
                const c = loadInstrucoes();
                const g1 = pick(c.msg1.grupo1);
                const g2 = pick(c.msg1.grupo2);
                const g3 = pick(c.msg1.grupo3);
                return `${g1}? ${g2}… ${g3}:`;
            };

            const composeMsg2 = () => {
                const c = loadInstrucoes();

                const p1 = `• ${pick(c.pontos.p1.g1)}, ${pick(c.pontos.p1.g2)}, ${pick(c.pontos.p1.g3)}`;
                const p2 = `• ${pick(c.pontos.p2.g1)}, ${pick(c.pontos.p2.g2)}, ${pick(c.pontos.p2.g3)}`;
                const p3 = `• ${pick(c.pontos.p3.g1)}, ${pick(c.pontos.p3.g2)}, ${pick(c.pontos.p3.g3)}`;
                const p4 = `• ${pick(c.pontos.p4.g1)}, ${pick(c.pontos.p4.g2)}, ${pick(c.pontos.p4.g3)}`;

                let out = [p1, '', p2, '', p3, '', p4].join('\n');
                out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

                return out;
            };

            const composeMsg3 = () => {
                const c = loadInstrucoes();
                const g1 = pick(c.msg3.grupo1);
                const g2 = pick(c.msg3.grupo2);
                return `${g1}… ${g2}?`;
            };

            const m1 = composeMsg1();
            const m2 = composeMsg2();
            const m3 = composeMsg3();

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m1) await sendMessage(st.contato, m1);

            await delayRange(20000, 30000);

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m2) await sendMessage(st.contato, m2);

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m3) await sendMessage(st.contato, m3);

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.acesso = 0;
            st.lastClassifiedIdx.confirmacao = 0;
            st.lastClassifiedIdx.saque = 0;

            st.etapa = 'instrucoes:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'instrucoes:wait') {
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.acesso || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }

            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;

            let classes = [];
            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                const prompt = promptClassificaAceite(msg);

                let msgClass = 'duvida';
                if (apiKey) {
                    const allowed = ['aceite', 'recusa', 'duvida'];
                    const structuredPrompt = `${prompt}\n\nOutput only this valid JSON format with double quotes around keys and values, nothing else: {"label": "aceite"} or {"label": "recusa"} or {"label": "duvida"}`;

                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
                                'https://api.openai.com/v1/responses',
                                {
                                    model: 'gpt-5',
                                    input: structuredPrompt,
                                    max_output_tokens: maxTok,
                                    reasoning: { effort: 'low' }
                                },
                                {
                                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                                    timeout: 15000,
                                    validateStatus: () => true
                                }
                            );
                        } catch {
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
                        if (!rawText) rawText = extractTextForLog(data);
                        rawText = String(rawText || '').trim();
                        let picked = null;
                        if (rawText) {
                            try {
                                const parsed = JSON.parse(rawText);
                                if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                            } catch {
                                const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                                if (m && m[1]) picked = m[1].toLowerCase().trim();
                            }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, allowed);
                        return { status: r.status, picked };
                    };

                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) {
                            resp = await callOnce(256);
                        }
                        if (resp.status >= 200 && resp.status < 300 && resp.picked) {
                            msgClass = resp.picked;
                        }
                    } catch { }
                }
                classes.push(msgClass);
            }

            st.lastClassifiedIdx.acesso = total;

            let classe = 'duvida';
            const nonDuvida = classes.filter(c => c !== 'duvida');
            classe = nonDuvida.length > 0 ? nonDuvida[nonDuvida.length - 1] : 'duvida';

            st.classificacaoAceite = classe;

            if (classe === 'aceite') {
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.interesse = 0;
                st.lastClassifiedIdx.acesso = 0;
                st.lastClassifiedIdx.confirmacao = 0;
                st.lastClassifiedIdx.saque = 0;

                st.etapa = 'acesso:send';
                console.log(`[${st.contato}] etapa->${st.etapa}`);
            } else {
                st.mensagensPendentes = [];
                return { ok: true, classe };
            }
        }

        if (st.etapa === 'acesso:send') {
            const acessoPath = path.join(__dirname, 'content', 'acesso.json');
            let acessoData = null;

            const loadAcesso = () => {
                if (acessoData) return acessoData;
                try {
                    let raw = fs.readFileSync(acessoPath, 'utf8');
                    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                    const parsed = JSON.parse(raw);
                    if (
                        !parsed?.msg1?.bloco1A?.length ||
                        !parsed?.msg1?.bloco2A?.length ||
                        !parsed?.msg1?.bloco3A?.length ||
                        !parsed?.msg3?.bloco1C?.length ||
                        !parsed?.msg3?.bloco2C?.length ||
                        !parsed?.msg3?.bloco3C?.length
                    ) throw new Error('content/acesso.json incompleto');
                    acessoData = parsed;
                } catch {
                    acessoData = {
                        msg1: {
                            bloco1A: ["vou mandar o e-mail e a senha da conta"],
                            bloco2A: ["só copia e cola pra não errar"],
                            bloco3A: ["E-mail"]
                        },
                        msg3: {
                            bloco1C: ["entra nesse link"],
                            bloco2C: ["entra na conta mas nao mexe em nada ainda"],
                            bloco3C: ["assim que conseguir acessar me manda um \"ENTREI\""]
                        }
                    };
                }
                return acessoData;
            };

            const pick = (arr) => Array.isArray(arr) && arr.length
                ? arr[Math.floor(Math.random() * arr.length)]
                : '';

            if (!st.credenciais?.email || !st.credenciais?.password || !st.credenciais?.login_url) {
                try {
                    await criarUsuarioDjango(st.contato);
                } catch (e) {
                    console.warn(`[${st.contato}] criarUsuarioDjango falhou: ${e?.message || e}`);
                }
            }

            const cred = (st.credenciais && typeof st.credenciais === 'object') ? st.credenciais : {};
            const email = safeStr(cred.email).trim();
            const senha = safeStr(cred.password).trim();
            const link = safeStr(cred.login_url).trim();

            if (!email || !senha || !link) {
                console.warn(`[${st.contato}] Credenciais incompletas; abortando acesso:send. email=${!!email} senha=${!!senha} link=${!!link}`);
                st.mensagensPendentes = [];
                return { ok: false, reason: 'missing-credentials' };
            }

            const c = loadAcesso();

            const msg1 = [
                `${pick(c.msg1.bloco1A)}, ${pick(c.msg1.bloco2A)}:`,
                '',
                `${pick(c.msg1.bloco3A)}:`,
                email,
                '',
                'Senha:'
            ].join('\n');

            const msg2 = String(senha);

            const msg3 = [
                `${pick(c.msg3.bloco1C)}:`,
                '',
                link,
                '',
                `${pick(c.msg3.bloco2C)}, ${pick(c.msg3.bloco3C)}`
            ].join('\n');

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (msg1) await sendMessage(st.contato, msg1);

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (msg2) await sendMessage(st.contato, msg2);

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (msg3) await sendMessage(st.contato, msg3);

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.acesso = 0;

            st.etapa = 'acesso:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'acesso:wait') {
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.acesso || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }

            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;

            const allowed = ['confirmado', 'nao_confirmado', 'duvida', 'neutro'];
            let classes = [];

            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                let msgClass = 'neutro';

                if (apiKey) {
                    const structuredPrompt =
                        `${promptClassificaAcesso(msg)}\n\n` +
                        `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
                        `{"label": "confirmado"} or {"label": "nao_confirmado"} or {"label": "duvida"} or {"label": "neutro"}`;

                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
                                'https://api.openai.com/v1/responses',
                                {
                                    model: 'gpt-5',
                                    input: structuredPrompt,
                                    max_output_tokens: maxTok,
                                    reasoning: { effort: 'low' }
                                },
                                {
                                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                                    timeout: 15000,
                                    validateStatus: () => true
                                }
                            );
                        } catch {
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
                        if (!rawText) rawText = extractTextForLog(data);
                        rawText = String(rawText || '').trim();

                        let picked = null;
                        if (rawText) {
                            try {
                                const parsed = JSON.parse(rawText);
                                if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                            } catch {
                                const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                                if (m && m[1]) picked = m[1].toLowerCase().trim();
                            }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, allowed);
                        return { status: r.status, picked };
                    };

                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) {
                            resp = await callOnce(256);
                        }
                        if (resp.status >= 200 && resp.status < 300 && resp.picked) {
                            msgClass = resp.picked;
                        }
                    } catch { }
                }

                classes.push(msgClass);
            }

            st.lastClassifiedIdx.acesso = total;
            st.mensagensPendentes = [];

            if (classes.includes('confirmado')) {
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.acesso = 0;

                st.etapa = 'confirmacao:send';
                console.log(`[${st.contato}] etapa->${st.etapa}`);
            } else {
                const ultima = classes[classes.length - 1] || 'neutro';
                return { ok: true, classe: ultima };
            }
        }
        if (st.etapa === 'confirmacao:send') {
            const confirmacaoPath = path.join(__dirname, 'content', 'confirmacao.json');
            let confirmacaoData = null;

            const loadConfirmacao = () => {
                if (confirmacaoData) return confirmacaoData;
                try {
                    let raw = fs.readFileSync(confirmacaoPath, 'utf8');
                    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                    const parsed = JSON.parse(raw);
                    if (
                        !parsed?.msg1?.bloco1?.length ||
                        !parsed?.msg1?.bloco2?.length ||
                        !parsed?.msg1?.bloco3?.length
                    ) throw new Error('content/confirmacao.json incompleto');
                    confirmacaoData = parsed;
                } catch {
                    confirmacaoData = {
                        msg1: {
                            bloco1: ['boa', 'boaa', 'boaaa', 'beleza', 'belezaa', 'belezaaa', 'tranquilo', 'isso aí'],
                            bloco2: [
                                'agora manda um PRINT mostrando o saldo disponível',
                                'agora manda um PRINT mostrando o saldo disponível aí',
                                'agora me manda um PRINT mostrando o saldo disponível nessa conta',
                                'agora me manda um PRINT mostrando o saldo'
                            ],
                            bloco3: [
                                'ou escreve aqui quanto que tem disponível',
                                'ou me escreve o valor',
                                'ou manda o valor em escrito',
                                'ou me fala o valor disponível'
                            ]
                        }
                    };
                }
                return confirmacaoData;
            };

            const pick = (arr) => Array.isArray(arr) && arr.length
                ? arr[Math.floor(Math.random() * arr.length)]
                : '';

            const composeConfirmacaoMsg = () => {
                const c = loadConfirmacao();
                const b1 = pick(c.msg1.bloco1);
                const b2 = pick(c.msg1.bloco2);
                const b3 = pick(c.msg1.bloco3);
                return `${b1}, ${b2}, ${b3}`;
            };

            const m = chooseUnique(composeConfirmacaoMsg, st) || composeConfirmacaoMsg();

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m) await sendMessage(st.contato, m);

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.confirmacao = 0;

            st.etapa = 'confirmacao:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'confirmacao:wait') {
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.confirmacao || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }

            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;

            const looksLikeMediaUrl = (s) => {
                const n = String(s || '');
                return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
                    || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
            };

            let confirmado = false;

            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                if (looksLikeMediaUrl(msg)) { confirmado = true; break; }
            }

            if (!confirmado && apiKey) {
                const allowed = ['confirmado', 'nao_confirmado', 'duvida', 'neutro'];

                const contexto = novasMsgs.map(s => safeStr(s)).join(' | ');
                const structuredPrompt =
                    `${promptClassificaConfirmacao(contexto)}\n\n` +
                    `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
                    `{"label": "confirmado"} or {"label": "nao_confirmado"} or {"label": "duvida"} or {"label": "neutro"}`;

                const callOnce = async (maxTok) => {
                    let r;
                    try {
                        r = await axios.post(
                            'https://api.openai.com/v1/responses',
                            {
                                model: 'gpt-5',
                                input: structuredPrompt,
                                max_output_tokens: maxTok,
                                reasoning: { effort: 'low' }
                            },
                            {
                                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                                timeout: 15000,
                                validateStatus: () => true
                            }
                        );
                    } catch {
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
                    if (!rawText) rawText = extractTextForLog(data);
                    rawText = String(rawText || '').trim();

                    let picked = null;
                    if (rawText) {
                        try {
                            const parsed = JSON.parse(rawText);
                            if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                        } catch {
                            const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                            if (m && m[1]) picked = m[1].toLowerCase().trim();
                        }
                    }
                    if (!picked) picked = pickLabelFromResponseData(data, allowed);
                    return { status: r.status, picked };
                };

                try {
                    let resp = await callOnce(64);
                    if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) {
                        resp = await callOnce(256);
                    }
                    confirmado = (resp.status >= 200 && resp.status < 300 && resp.picked === 'confirmado');
                } catch { }
            }

            st.lastClassifiedIdx.confirmacao = total;
            st.mensagensPendentes = [];

            if (confirmado) {
                st.mensagensDesdeSolicitacao = [];
                st.lastClassifiedIdx.saque = 0;
                st.etapa = 'saque:send';
                console.log(`[${st.contato}] etapa->${st.etapa}`);
            } else {
                return { ok: true, classe: 'standby' };
            }
        }

        if (st.etapa === 'saque:send') {
            const saquePath = path.join(__dirname, 'content', 'saque.json');
            let saqueData = null;

            function gerarSenhaAleatoria() {
                return String(Math.floor(1000 + Math.random() * 9000));
            }

            const loadSaque = () => {
                if (saqueData) return saqueData;
                try {
                    let raw = fs.readFileSync(saquePath, 'utf8');
                    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                    const parsed = JSON.parse(raw);
                    if (
                        !parsed?.msg1?.m1b1?.length || !parsed?.msg1?.m1b2?.length || !parsed?.msg1?.m1b3?.length ||
                        !parsed?.msg1?.m1b4?.length || !parsed?.msg1?.m1b5?.length || !parsed?.msg1?.m1b6?.length ||
                        !parsed?.msg2?.m2b1?.length || !parsed?.msg2?.m2b2?.length ||
                        !parsed?.msg3?.m3b1?.length || !parsed?.msg3?.m3b2?.length || !parsed?.msg3?.m3b3?.length ||
                        !parsed?.msg3?.m3b4?.length || !parsed?.msg3?.m3b5?.length || !parsed?.msg3?.m3b6?.length
                    ) throw new Error('content/saque.json incompleto');
                    saqueData = parsed;
                } catch {
                    // fallback com os mesmos blocos que você especificou
                    saqueData = { /* será carregado do arquivo; fallback omitido para brevidade */ };
                }
                return saqueData;
            };

            const pick = (arr) => Array.isArray(arr) && arr.length
                ? arr[Math.floor(Math.random() * arr.length)]
                : '';

            const composeMsg1 = () => {
                const c = loadSaque();
                const m = c.msg1;
                return `${pick(m.m1b1)} ${pick(m.m1b2)}: ${pick(m.m1b3)}, ${pick(m.m1b4)}… ${pick(m.m1b5)}, ${pick(m.m1b6)}`;
            };

            const composeMsg2 = () => {
                const c = loadSaque();
                const m = c.msg2;
                const s1 = gerarSenhaAleatoria();
                const s2 = '8293';
                const s3 = gerarSenhaAleatoria();
                const header = `${pick(m.m2b1)}, ${pick(m.m2b2)}:`;
                return `${header}\n\n${s1}\n${s2}\n${s3}`;
            };

            const composeMsg3 = () => {
                const c = loadSaque();
                const m = c.msg3;
                return `${pick(m.m3b1)}, ${pick(m.m3b2)}… ${pick(m.m3b3)}! ${pick(m.m3b4)}, ${pick(m.m3b5)}, ${pick(m.m3b6)}`;
            };

            const m1 = chooseUnique(composeMsg1, st) || composeMsg1();
            const m2 = chooseUnique(composeMsg2, st) || composeMsg2();
            const m3 = chooseUnique(composeMsg3, st) || composeMsg3();

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m1) await sendMessage(st.contato, m1);

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m2) await sendMessage(st.contato, m2);

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m3) await sendMessage(st.contato, m3);

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.saque = 0;

            st.saquePediuPrint = false;
            st.etapa = 'saque:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }
        if (st.etapa === 'saque:wait') {
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            const total = st.mensagensDesdeSolicitacao.length;
            const startIdx = Math.max(0, st.lastClassifiedIdx?.saque || 0);
            if (startIdx >= total) {
                st.mensagensPendentes = [];
                return { ok: true, noop: 'no-new-messages' };
            }

            const novasMsgs = st.mensagensDesdeSolicitacao.slice(startIdx);
            const apiKey = process.env.OPENAI_API_KEY;

            const looksLikeMediaUrl = (s) => {
                const n = String(s || '');
                return /(manybot-files\.s3|mmg\.whatsapp\.net|cdn\.whatsapp\.net|amazonaws\.com).*\/(original|file)_/i.test(n)
                    || /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?$/i.test(n);
            };

            let temImagem = false;
            for (const raw of novasMsgs) {
                const msg = safeStr(raw).trim();
                if (looksLikeMediaUrl(msg)) { temImagem = true; break; }
            }

            if (temImagem) {
                st.lastClassifiedIdx.saque = total;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.saquePediuPrint = false;
                st.etapa = 'validacao:send';
                console.log(`[${st.contato}] etapa->${st.etapa}`);
            } else {
                let relevante = false;
                if (apiKey) {
                    const allowed = ['relevante', 'irrelevante'];
                    const contexto = novasMsgs.map(s => safeStr(s)).join(' | ');
                    const structuredPrompt =
                        `${promptClassificaRelevancia(contexto, false)}\n\n` +
                        `Output only this valid JSON format with double quotes around keys and values, nothing else: ` +
                        `{"label": "relevante"} or {"label": "irrelevante"}`;

                    const callOnce = async (maxTok) => {
                        let r;
                        try {
                            r = await axios.post(
                                'https://api.openai.com/v1/responses',
                                {
                                    model: 'gpt-5',
                                    input: structuredPrompt,
                                    max_output_tokens: maxTok,
                                    reasoning: { effort: 'low' }
                                },
                                {
                                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                                    timeout: 15000,
                                    validateStatus: () => true
                                }
                            );
                        } catch {
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
                        if (!rawText) rawText = extractTextForLog(data);
                        rawText = String(rawText || '').trim();

                        let picked = null;
                        if (rawText) {
                            try {
                                const parsed = JSON.parse(rawText);
                                if (parsed && typeof parsed.label === 'string') picked = parsed.label.toLowerCase().trim();
                            } catch {
                                const m = rawText.match(/(?:"label"|label)\s*:\s*"([^"]+)"/i);
                                if (m && m[1]) picked = m[1].toLowerCase().trim();
                            }
                        }
                        if (!picked) picked = pickLabelFromResponseData(data, allowed);
                        return { status: r.status, picked };
                    };

                    try {
                        let resp = await callOnce(64);
                        if (!(resp.status >= 200 && resp.status < 300 && resp.picked)) resp = await callOnce(256);
                        relevante = (resp.status >= 200 && resp.status < 300 && resp.picked === 'relevante');
                    } catch { }
                }

                st.lastClassifiedIdx.saque = total;
                st.mensagensPendentes = [];

                if (relevante) {
                    const saquePath = path.join(__dirname, 'content', 'saque.json');
                    let saqueMsgPrint = null;
                    try {
                        let raw = fs.readFileSync(saquePath, 'utf8');
                        raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed?.msgprint) && parsed.msgprint.length > 0) {
                            saqueMsgPrint = parsed.msgprint;
                        }
                    } catch { }
                    if (!Array.isArray(saqueMsgPrint) || saqueMsgPrint.length === 0) {
                        saqueMsgPrint = [
                            'o que aconteceu aí? me manda um PRINT ou uma foto da tela',
                            'o que apareceu na tela? me manda um PRINT'
                        ];
                    }

                    if (!st.saquePediuPrint) {
                        const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                        const composeMsgPrint = () => pick(saqueMsgPrint);
                        const m = chooseUnique(composeMsgPrint, st) || composeMsgPrint();

                        await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                        if (m) await sendMessage(st.contato, m);
                        st.saquePediuPrint = true;
                        return { ok: true, classe: 'relevante' };
                    }

                    return { ok: true, classe: 'aguardando_imagem' };
                }

                return { ok: true, classe: 'irrelevante' };
            }
        }

        if (st.etapa === 'validacao:send') {
            const validacaoPath = path.join(__dirname, 'content', 'validacao.json');
            let validacaoData = null;

            const loadValidacao = () => {
                if (validacaoData) return validacaoData;
                try {
                    let raw = fs.readFileSync(validacaoPath, 'utf8');
                    raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                    const parsed = JSON.parse(raw);
                    if (
                        !parsed?.msg1?.msg1b1?.length ||
                        !parsed?.msg1?.msg1b2?.length ||
                        !parsed?.msg1?.msg1b3?.length ||
                        !parsed?.msg2?.msg2b1?.length ||
                        !parsed?.msg2?.msg2b2?.length ||
                        !parsed?.msg2?.msg2b3?.length ||
                        !parsed?.msg2?.msg2b4?.length
                    ) throw new Error('content/validacao.json incompleto');
                    validacaoData = parsed;
                } catch {
                    validacaoData = {
                        msg1: {
                            msg1b1: ['ok', 'certo', 'beleza'],
                            msg1b2: ['precisou de validação'],
                            msg1b3: ['confirme na tela e avance pelo botão PRÓXIMO']
                        },
                        msg2: {
                            msg2b1: ['vou acionar o suporte'],
                            msg2b2: ['tenho contato direto e sabem o procedimento'],
                            msg2b3: ['em poucos minutos resolvemos'],
                            msg2b4: ['aguarda um instante que já retorno']
                        }
                    };
                }
                return validacaoData;
            };

            const pick = (arr) => Array.isArray(arr) && arr.length
                ? arr[Math.floor(Math.random() * arr.length)]
                : '';

            const composeMsg1 = () => {
                const c = loadValidacao();
                return `${pick(c.msg1.msg1b1)}, ${pick(c.msg1.msg1b2)}. ${pick(c.msg1.msg1b3)}`;
            };

            const composeMsg2 = () => {
                const c = loadValidacao();
                return `${pick(c.msg2.msg2b1)}, ${pick(c.msg2.msg2b2)}. ${pick(c.msg2.msg2b3)}, ${pick(c.msg2.msg2b4)}?`;
            };

            const m1 = chooseUnique(composeMsg1, st) || composeMsg1();
            const m2 = chooseUnique(composeMsg2, st) || composeMsg2();

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m1) await sendMessage(st.contato, m1);

            await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
            if (m2) await sendMessage(st.contato, m2);

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.validacao = 0;

            st.validacaoAwaitFirstMsg = true;
            st.validacaoTimeoutUntil = 0;

            st.etapa = 'validacao:wait';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
            return { ok: true };
        }

        if (st.etapa === 'validacao:wait') {
            if (st.mensagensPendentes.length === 0) return { ok: true, noop: 'waiting-user' };

            if (st.validacaoAwaitFirstMsg && st.validacaoTimeoutUntil === 0) {
                const FOUR = 4 * 60 * 1000;
                const SIX = 6 * 60 * 1000;
                const rnd = randomInt(FOUR, SIX + 1);
                st.validacaoTimeoutUntil = Date.now() + rnd;
                st.validacaoAwaitFirstMsg = false;

                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];

                if (st.validacaoTimer) { try { clearTimeout(st.validacaoTimer); } catch { } }
                st.validacaoTimer = setTimeout(async () => {
                    try {
                        await processarMensagensPendentes(contato);
                    } catch (e) {
                        console.warn(`[${st.contato}] validacaoTimer erro: ${e?.message || e}`);
                    }
                }, rnd + 100);

                st.etapa = 'validacao:cooldown';
                console.log(`[${st.contato}] etapa->${st.etapa} t+${Math.round(rnd / 1000)}s`);
                return { ok: true, started: rnd };
            }

            st.mensagensPendentes = [];
            return { ok: true, noop: 'await-first-message' };
        }
        if (st.etapa === 'validacao:cooldown') {
            const now = Date.now();

            if (st.validacaoTimeoutUntil > 0 && now < st.validacaoTimeoutUntil) {
                if (st.mensagensPendentes.length > 0) {
                    st.mensagensPendentes = [];
                    st.mensagensDesdeSolicitacao = [];
                }
                return { ok: true, noop: 'cooldown' };
            }

            st.validacaoTimeoutUntil = 0;
            st.validacaoAwaitFirstMsg = false;

            if (st.validacaoTimer) { try { clearTimeout(st.validacaoTimer); } catch { } st.validacaoTimer = null; }

            st.mensagensPendentes = [];
            st.mensagensDesdeSolicitacao = [];
            st.lastClassifiedIdx.validacao = 0;

            st.conversaoBatch = 0;
            st.conversaoAwaitMsg = false;
            if (!st.lastClassifiedIdx) st.lastClassifiedIdx = {};
            st.lastClassifiedIdx.conversao = 0;

            st.etapa = 'conversao:send';
            console.log(`[${st.contato}] etapa->${st.etapa}`);
        }
        if (st.etapa === 'conversao:send') {
            let conversao = null;
            try {
                let raw = fs.readFileSync(path.join(__dirname, 'content', 'conversao.json'), 'utf8');
                raw = raw.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
                const parsed = JSON.parse(raw);
                if (!parsed?.msg1?.msg1b1?.length || !parsed?.msg1?.msg1b2?.length) throw new Error('conversao.msg1 incompleto');
                if (!parsed?.msg3?.msg3b1?.length || !parsed?.msg3?.msg3b2?.length || !parsed?.msg3?.msg3b3?.length) throw new Error('conversao.msg3 incompleto');

                if (!parsed?.msg4?.msg4b1?.length || !parsed?.msg4?.msg4b2?.length || !parsed?.msg4?.msg4b3?.length ||
                    !parsed?.msg4?.msg4b4?.length || !parsed?.msg4?.msg4b5?.length || !parsed?.msg4?.msg4b6?.length || !parsed?.msg4?.msg4b7?.length) {
                    throw new Error('conversao.msg4 incompleto');
                }
                if (!parsed?.msg5?.msg5b1?.length || !parsed?.msg5?.msg5b2?.length) throw new Error('conversao.msg5 incompleto');
                if (!parsed?.msg6?.msg6b1?.length || !parsed?.msg6?.msg6b2?.length || !parsed?.msg6?.msg6b3?.length) throw new Error('conversao.msg6 incompleto');
                if (!parsed?.msg7?.msg7b1?.length || !parsed?.msg7?.msg7b2?.length || !parsed?.msg7?.msg7b3?.length || !parsed?.msg7?.msg7b4?.length || !parsed?.msg7?.msg7b5?.length) throw new Error('conversao.msg7 incompleto');
                if (!parsed?.msg8?.msg8b1?.length || !parsed?.msg8?.msg8b2?.length || !parsed?.msg8?.msg8b3?.length || !parsed?.msg8?.msg8b4?.length) throw new Error('conversao.msg8 incompleto');
                if (!parsed?.msg9?.msg9b1?.length || !parsed?.msg9?.msg9b2?.length || !parsed?.msg9?.msg9b3?.length || !parsed?.msg9?.msg9b4?.length || !parsed?.msg9?.msg9b5?.length || !parsed?.msg9?.msg9b6?.length || !parsed?.msg9?.msg9b7?.length) throw new Error('conversao.msg9 incompleto');

                conversao = parsed;
            } catch (e) {
                console.warn(`[Conversao] Falha ao ler conversao.json: ${e?.message || e}`);
                conversao = {
                    msg1: { msg1b1: ['voltei'], msg1b2: ['já tive uma resposta'] },
                    msg2: { images: [] },
                    msg3: { msg3b1: ['me responderam isso'], msg3b2: ['é pq a plataforma é gringa'], msg3b3: ['essa validação é por causa da transferencia internacional'] },
                    msg4: { msg4b1: ['pior que nao tem muito o que fazer'], msg4b2: ['é a única forma de sacar dinheiro de lá pro brasil'], msg4b3: ['pelo menos nao pedem documento'], msg4b4: ['é só a taxa de 3 dólares mesmo'], msg4b5: ['o câmbio que pesa'], msg4b6: ['3 dólares já dá 17 reais 🤦🏽'], msg4b7: ['ainda bem que não é 10 dólares kkkk'] },
                    msg5: { msg5b1: ['acho que nem preciso falar isso'], msg5b2: ['mas você não acha que eu ia te dar um golpe de 17 reais né'] },
                    msg6: { msg6b1: ['e não esquece'], msg6b2: ['ela disse na mensagem que tem que validar pela mesma conta que voce vai receber o pix'], msg6b3: ['se não n valida'] },
                    msg7: { msg7b1: ['não consigo te mandar o valor da taxa'], msg7b2: ['eu não posso ter vinculo com sua conta'], msg7b3: ['por isso que tô atrás de lara kkkkkk'], msg7b4: ['quando você for mandar minha parte'], msg7b5: ['eu te passo o copia e cola da minha carteira cripto'] },
                    msg8: { msg8b1: ['sei que as vezes esse valor tá em falta'], msg8b2: ['mas se for o caso, não deixa de sacar por causa disso'], msg8b3: ['pede um pix emprestado aí rapidinho'], msg8b4: ['depois vc devolve o dobro pra pessoa'] },
                    msg9: { msg9b1: ['confia que o trampo é garantido'], msg9b2: ['não perde por causa de 17 reais'], msg9b3: ['pode ficar com 2.500 pelo imprevisto beleza'], msg9b4: ['e te chamo pros próximos trampos'], msg9b5: ['vou resolver um assunto aqui'], msg9b6: ['vou ficar offline por meia hora'], msg9b7: ['assim que eu voltar já te chamo'] }
                };
            }

            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

            if (st.conversaoBatch === 0) {
                const m1 = `${pick(conversao.msg1.msg1b1)}, ${pick(conversao.msg1.msg1b2)}`;
                const img = Array.isArray(conversao?.msg2?.images) && conversao.msg2.images.length ? pick(conversao.msg2.images) : '';
                const m3 = `${pick(conversao.msg3.msg3b1)}, ${pick(conversao.msg3.msg3b2)}, ${pick(conversao.msg3.msg3b3)}`;

                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                if (m1) await sendMessage(st.contato, m1);

                if (img) {
                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    await sendImage(st.contato, img);
                }

                await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                if (m3) await sendMessage(st.contato, m3);

                st.conversaoBatch = 1;
                st.conversaoAwaitMsg = true;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                return { ok: true, batch: 1 };
            }

            if (st.conversaoAwaitMsg) {
                const temMsg =
                    (Array.isArray(st.mensagensPendentes) && st.mensagensPendentes.length > 0) ||
                    (Array.isArray(st.mensagensDesdeSolicitacao) && st.mensagensDesdeSolicitacao.length > (st.lastClassifiedIdx?.conversao || 0));

                if (!temMsg) {
                    st.mensagensPendentes = [];
                    return { ok: true, noop: 'await-user-message' };
                }

                st.lastClassifiedIdx.conversao = st.mensagensDesdeSolicitacao.length;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];

                if (st.conversaoBatch === 1) {
                    const m4 = `${pick(conversao.msg4.msg4b1)}. ${pick(conversao.msg4.msg4b2)}. ${pick(conversao.msg4.msg4b3)}. ${pick(conversao.msg4.msg4b4)}. ${pick(conversao.msg4.msg4b5)}. ${pick(conversao.msg4.msg4b6)} ${pick(conversao.msg4.msg4b7)}`;
                    const m5 = `${pick(conversao.msg5.msg5b1)}, ${pick(conversao.msg5.msg5b2)}?`;
                    const m6 = `${pick(conversao.msg6.msg6b1)}, ${pick(conversao.msg6.msg6b2)}, ${pick(conversao.msg6.msg6b3)}`;

                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m4) await sendMessage(st.contato, m4);

                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m5) await sendMessage(st.contato, m5);

                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m6) await sendMessage(st.contato, m6);

                    st.conversaoBatch = 2;
                    st.conversaoAwaitMsg = true;
                    return { ok: true, batch: 2 };
                }

                if (st.conversaoBatch === 2) {
                    const m7 = `${pick(conversao.msg7.msg7b1)}, ${pick(conversao.msg7.msg7b2)}. ${pick(conversao.msg7.msg7b3)}. ${pick(conversao.msg7.msg7b4)}, ${pick(conversao.msg7.msg7b5)}`;
                    const m8 = `${pick(conversao.msg8.msg8b1)}, ${pick(conversao.msg8.msg8b2)}, ${pick(conversao.msg8.msg8b3)}, ${pick(conversao.msg8.msg8b4)}`;
                    const m9 = `${pick(conversao.msg9.msg9b1)}, ${pick(conversao.msg9.msg9b2)}. ${pick(conversao.msg9.msg9b3)}, ${pick(conversao.msg9.msg9b4)}. ${pick(conversao.msg9.msg9b5)}, ${pick(conversao.msg9.msg9b6)}. ${pick(conversao.msg9.msg9b7)}`;

                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m7) await sendMessage(st.contato, m7);

                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m8) await sendMessage(st.contato, m8);

                    await delayRange(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
                    if (m9) await sendMessage(st.contato, m9);

                    st.conversaoBatch = 3;
                    st.conversaoAwaitMsg = false;

                    st.mensagensPendentes = [];
                    st.mensagensDesdeSolicitacao = [];
                    st.lastClassifiedIdx.conversao = 0;

                    st.etapa = 'conversao:wait';
                    console.log(`[${st.contato}] etapa->${st.etapa}`);
                    return { ok: true, batch: 3, done: true };
                }
            }

            if (st.conversaoBatch >= 3) {
                st.conversaoAwaitMsg = false;
                st.mensagensPendentes = [];
                st.mensagensDesdeSolicitacao = [];
                st.etapa = 'conversao:wait';
                console.log(`[${st.contato}] etapa->${st.etapa}`);
                return { ok: true, coerced: 'conversao:wait' };
            }

            return { ok: true };
        }
        if (st.etapa === 'conversao:wait') {
            st.mensagensPendentes = [];
            return { ok: true, noop: 'idle' };
        }
    } finally {
        st.enviandoMensagens = false;
    }

}

async function sendMessage(contato, texto) {
    await extraGlobalDelay();
    const msg = safeStr(texto);
    try {
        const { mod, settings } = await getActiveTransport();
        const provider = mod?.name || 'unknown';

        if (provider === 'manychat') {
            let subscriberId = null;
            try {
                const c = await getContatoByPhone(contato);
                subscriberId = c?.manychat_subscriber_id || c?.subscriber_id || null;
            } catch { }
            if (!subscriberId) {
                const st = ensureEstado(contato);
                if (st.manychat_subscriber_id) subscriberId = st.manychat_subscriber_id;
            }
            if (!subscriberId) {
                console.log(`[${contato}] envio=fail provider=manychat reason=no-subscriber-id msg="${msg}"`);
                return { ok: false, reason: 'no-subscriber-id' };
            }

            let finalText = String(msg ?? '')
                .replace(/\r\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            await mod.sendText({ subscriberId, text: finalText }, settings);

            console.log(`[${contato}] envio=ok provider=manychat msg="${finalText}"`);
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

const KNOWN_ETAPAS = new Set([
  'none',
  'abertura:wait',
  'interesse:wait',
  'instrucoes:send',
  'instrucoes:wait',
  'acesso:send',
  'acesso:wait',
  'confirmacao:send',
  'confirmacao:wait',
  'saque:send',
  'saque:wait',
  'validacao:send',
  'validacao:wait',
  'validacao:cooldown',
  'conversao:send',
  'conversao:wait',
]);

function _resetRuntime(st, opts = {}) {
  st.enviandoMensagens = false;
  st.mensagensPendentes = [];
  st.mensagensDesdeSolicitacao = [];
  st.sentHashes = st.sentHashes instanceof Set ? st.sentHashes : new Set();

  st.lastClassifiedIdx = {
    interesse: 0, acesso: 0, confirmacao: 0, saque: 0, validacao: 0, conversao: 0
  };

  st.saquePediuPrint = false;

  if (st.validacaoTimer) { try { clearTimeout(st.validacaoTimer); } catch {} }
  st.validacaoTimer = null;
  st.validacaoAwaitFirstMsg = false;
  st.validacaoTimeoutUntil = 0;

  st.conversaoBatch = 0;
  st.conversaoAwaitMsg = false;

  if (opts.clearCredenciais) st.credenciais = undefined;
  if (opts.seedCredenciais && typeof opts.seedCredenciais === 'object') {
    st.credenciais = {
      email: String(opts.seedCredenciais.email || ''),
      password: String(opts.seedCredenciais.password || ''),
      login_url: String(opts.seedCredenciais.login_url || ''),
    };
  }
  if (opts.manychat_subscriber_id != null) {
    const idNum = Number(opts.manychat_subscriber_id);
    st.manychat_subscriber_id = Number.isFinite(idNum) ? idNum : undefined;
  }

  st.updatedAt = Date.now();
}

async function setEtapa(contato, etapa, opts = {}) {
  const target = String(etapa || '').trim();
  if (!KNOWN_ETAPAS.has(target)) {
    throw new Error(`etapa inválida: "${target}"`);
  }
  const st = ensureEstado(contato);

  _resetRuntime(st, opts);
  st.etapa = target;

  if (opts.autoCreateUser && !st.credenciais &&
      (target.startsWith('acesso:') ||
       target.startsWith('confirmacao:') ||
       target.startsWith('saque:') ||
       target.startsWith('validacao:') ||
       target.startsWith('conversao:'))) {
    try {
      await criarUsuarioDjango(contato);
    } catch (e) {
      console.warn(`[${st.contato}] setEtapa:autoCreateUser falhou: ${e?.message || e}`);
    }
  }

  return { ok: true, contato: st.contato, etapa: st.etapa };
}

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
    sendImage,
    retomarEnvio,
    setEtapa,
    _utils: { ensureEstado, normalizeContato },
};