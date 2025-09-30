const path = require('path');
const express = require('express');
const axios = require('axios');
const twilio = require('twilio');
const qs = require('qs');

const { pool } = require('./db.js');
const { delay, sendMessage, retomarEnvio, decidirOptLabel } = require('./bot.js');
const { getBotSettings, updateBotSettings, getContatoByPhone } = require('./db.js');

const LANDING_URL = 'https://grupo-whatsapp-trampos-lara-2025.onrender.com';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const CONTACT_TOKEN = process.env.CONTACT_TOKEN;

const sentContactByWa = new Set();
const sentContactByClid = new Set();

const MAX_OPTOUTS = 3;
const OPTOUT_MSGS = {
  1: 'tranquilo, não vou mais te mandar mensagem. qualquer coisa só chamar',
  2: 'de boa, vou passar o trampo pra outra pessoa e não te chamo mais. não me manda mais mensagem',
};

async function registerOptOut(pool, contato, reasonText = '') {
  const { rows } = await pool.query(
    'SELECT opt_out_count FROM contatos WHERE id = $1 LIMIT 1',
    [contato]
  );
  const next = (rows?.[0]?.opt_out_count || 0) + 1;
  const permanently = next >= MAX_OPTOUTS;

  await pool.query(
    `UPDATE contatos
       SET do_not_contact = TRUE,
           do_not_contact_at = NOW(),
           do_not_contact_reason = $2,
           opt_out_count = $3,
           permanently_blocked = $4
     WHERE id = $1`,
    [contato, String(reasonText).slice(0, 200), next, permanently]
  );

  return { next, permanently };
}

async function clearOptOutIfAllowed(pool, contato) {
  const { rows } = await pool.query(
    'SELECT opt_out_count, permanently_blocked FROM contatos WHERE id = $1 LIMIT 1',
    [contato]
  );
  const c = rows?.[0] || {};
  if (c.permanently_blocked || (c.opt_out_count || 0) >= MAX_OPTOUTS) {
    return { allowed: false };
  }
  await pool.query(
    `UPDATE contatos
        SET do_not_contact = FALSE,
            do_not_contact_at = NULL,
            do_not_contact_reason = NULL
      WHERE id = $1`,
    [contato]
  );
  return { allowed: true };
}

function checkAuth(req, res, next) {
  if (req.session.loggedIn) next();
  else res.redirect('/login');
}

function norm(s = '') {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

// ---------- util: URLs do texto ----------
const URL_RX = /https?:\/\/\S+/gi;
function extractUrlsFromText(text = '') {
  const out = [];
  const s = String(text || '');
  let m;
  while ((m = URL_RX.exec(s)) !== null) out.push(m[0]);
  return Array.from(new Set(out));
}

// ---------- util: coleta “possíveis” URLs no payload sem classificar ----------
function harvestUrlsFromPayload(payload = {}) {
  const urls = new Set();

  const tryPush = (v) => {
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) urls.add(v);
  };

  // campos comuns em webhooks
  tryPush(payload.url);
  tryPush(payload.mediaUrl);
  tryPush(payload.image_url);
  tryPush(payload.file_url);
  tryPush(payload?.payload?.url);
  tryPush(payload?.attachment?.payload?.url);

  // ManyChat costuma enviar attachments em vários formatos
  const attachments =
    payload.attachments ||
    payload?.message?.attachments ||
    payload?.last_message?.attachments ||
    payload?.payload?.attachments ||
    [];

  if (Array.isArray(attachments)) {
    attachments.forEach(a => {
      tryPush(a?.url);
      tryPush(a?.payload?.url);
      tryPush(a?.file_url);
      tryPush(a?.image_url);
    });
  }

  // varrer superficialmente arrays/objetos de 1º nível buscando chaves “url”
  Object.values(payload || {}).forEach(v => {
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        v.forEach(x => {
          tryPush(x?.url);
          tryPush(x?.payload?.url);
        });
      } else {
        tryPush(v?.url);
        tryPush(v?.payload?.url);
      }
    }
  });

  return Array.from(urls);
}

async function bootstrapFromManychat(
  phone,
  subscriberId,
  inicializarEstado,
  salvarContato,
  criarUsuarioDjango,
  estado,
  initialTid = '',
  initialClickType = 'Orgânico'
) {
  const idContato = phone || `mc:${subscriberId}`;

  if (!estado[idContato]) {
    inicializarEstado(idContato, initialTid, initialClickType);
  } else {
    const st = estado[idContato];
    if (!st.tid && initialTid) {
      st.tid = initialTid;
      st.click_type = initialClickType || 'Orgânico';
    }
  }

  const stNow = estado[idContato] || {};
  await salvarContato(
    idContato,
    null,
    null,
    stNow.tid || initialTid || '',
    stNow.click_type || initialClickType || 'Orgânico'
  ).catch(() => {});

  const alreadyHasCreds = !!(stNow && stNow.credenciais);
  if (phone && !alreadyHasCreds) {
    try {
      await criarUsuarioDjango(idContato);
    } catch (e) {
      console.error(`[${idContato}] criarUsuarioDjango erro:`, e?.response?.data || e.message);
    }
  }

  return idContato;
}

const OPTOUT_TOKENS = new Set(['sair', 'parar', 'cancelar', 'remover', 'nao quero']);
const OPTOUT_PHRASES = [
  'nao quero receber',
  'para de enviar',
  'chega',
  'para com isso',
  'tira meu numero',
  'nao quero mais',
];

function setupRoutes(
  app,
  pathModule,
  processarMensagensPendentes,
  inicializarEstado,
  criarUsuarioDjango,
  salvarContato,
  VERIFY_TOKEN,
  estado
) {
  // static
  app.use('/public', express.static(pathModule.join(__dirname, 'public')));

  // ---- Auth & Admin ----
  app.get('/login', (req, res) => res.sendFile(pathModule.join(__dirname, 'public', 'login.html')));
  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'ncfp' && password === '8065537Ncfp@') {
      req.session.loggedIn = true;
      res.redirect('/dashboard');
    } else {
      res.send('Login inválido. <a href="/login">Tente novamente</a>');
    }
  });
  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });
  app.get('/dashboard', checkAuth, (req, res) =>
    res.sendFile(pathModule.join(__dirname, 'public', 'dashboard.html'))
  );

  app.get('/admin/settings', checkAuth, async (req, res) => {
    try {
      const settings = await getBotSettings({ bypassCache: true });
      res.render('settings.ejs', { settings, ok: req.query.ok === '1' });
    } catch (e) {
      console.error('[AdminSettings][GET]', e.message);
      res.status(500).send('Erro ao carregar configurações.');
    }
  });

  app.post('/admin/settings', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const payload = {
        identity_enabled: req.body.identity_enabled === 'on',
        identity_label: (req.body.identity_label || '').trim(),
        support_email: (req.body.support_email || '').trim(),
        support_phone: (req.body.support_phone || '').trim(),
        support_url: (req.body.support_url || '').trim(),
        optout_hint_enabled: req.body.optout_hint_enabled === 'on',
        optout_suffix: (req.body.optout_suffix || '').trim(),

        message_provider: (req.body.message_provider || 'meta').toLowerCase(),

        twilio_account_sid: (req.body.twilio_account_sid || '').trim(),
        twilio_auth_token: (req.body.twilio_auth_token || '').trim(),
        twilio_messaging_service_sid: (req.body.twilio_messaging_service_sid || '').trim(),
        twilio_from: (req.body.twilio_from || '').trim(),

        manychat_api_token: (req.body.manychat_api_token || '').trim(),
        manychat_fallback_flow_id: (req.body.manychat_fallback_flow_id || '').trim(),
        manychat_webhook_secret: (req.body.manychat_webhook_secret || '').trim(),
      };

      await updateBotSettings(payload);
      res.redirect('/admin/settings?ok=1');
    } catch (e) {
      console.error('[AdminSettings][POST] erro:', e);
      res.status(500).send('Erro ao salvar configurações');
    }
  });

  // ---- Metrics & Data APIs ----
  app.get('/api/metrics', checkAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const activeRes = await client.query(
        "SELECT COUNT(*) FROM contatos WHERE status = 'ativo' AND ultima_interacao > NOW() - INTERVAL '10 minutes'"
      );
      const totalContatosRes = await client.query('SELECT COUNT(*) FROM contatos');
      const messagesReceivedRes = await client.query(
        'SELECT SUM(jsonb_array_length(historico)) AS total FROM contatos'
      );
      const messagesSentRes = await client.query(
        'SELECT SUM(jsonb_array_length(historico_interacoes)) AS total FROM contatos'
      );
      const stagesRes = await client.query('SELECT etapa_atual, COUNT(*) FROM contatos GROUP BY etapa_atual');

      const active = activeRes.rows[0].count || 0;
      const totalContatos = totalContatosRes.rows[0].count || 0;
      const messagesReceived = messagesReceivedRes.rows[0].total || 0;
      const messagesSent = messagesSentRes.rows[0].total || 0;
      const stages = stagesRes.rows.reduce((acc, row) => ({ ...acc, [row.etapa_atual]: row.count }), {});

      res.json({
        activeConversations: active,
        totalContatos: totalContatos,
        messagesReceived: messagesReceived,
        messagesSent: messagesSent,
        stages,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.get('/api/contatos', checkAuth, async (req, res) => {
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const client = await pool.connect();
    try {
      const resQuery = await client.query(
        'SELECT id, etapa_atual, ultima_interacao FROM contatos ORDER BY ultima_interacao DESC LIMIT $1 OFFSET $2',
        [limit, page * limit]
      );
      res.json(resQuery.rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.get('/api/chat/:id', checkAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const historicoRes = await client.query('SELECT historico FROM contatos WHERE id = $1', [req.params.id]);
      const interacoesRes = await client.query('SELECT historico_interacoes FROM contatos WHERE id = $1', [
        req.params.id,
      ]);

      const historico = historicoRes.rows[0]?.historico || [];
      const interacoes = interacoesRes.rows[0]?.historico_interacoes || [];

      const allMessages = [
        ...historico.map((msg) => ({ ...msg, role: 'received' })),
        ...interacoes.map((msg) => ({ ...msg, role: 'sent' })),
      ];
      allMessages.sort((a, b) => new Date(a.data) - new Date(b.data));

      res.json(allMessages);
    } catch (error) {
      res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // ---- Meta Webhook (Cloud API) ----
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verificado com sucesso');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  app.post('/webhook', async (req, res) => {
    const body = req.body;
    console.log(`[Webhook] Payload completo recebido: ${JSON.stringify(body, null, 2)}`);

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field !== 'messages') continue;

          const value = change.value;
          if (!value.messages || !value.messages.length) continue;

          const msg = value.messages[0];
          const contato = msg.from;

          if (contato === PHONE_NUMBER_ID) {
            console.log(`[Webhook] Ignorando eco de mensagem enviada pelo bot (ID: ${msg.id})`);
            res.sendStatus(200);
            return;
          }

          // Texto puro quando existir; caso contrário, deixamos vazio e marcamos mídia pelo PRÓPRIO provider
          const isProviderMedia = msg.type !== 'text';
          const texto = msg.type === 'text' ? (msg.text.body || '').trim() : '';
          console.log(`[${contato}] Recebido (Meta): "${texto || '[mídia]'}" | type=${msg.type}`);

          // ======= OPT-OUT / RE-OPT-IN =======
          try {
            const { rows: flags } = await pool.query(
              'SELECT do_not_contact, opt_out_count, permanently_blocked FROM contatos WHERE id = $1 LIMIT 1',
              [contato]
            );
            const f = flags?.[0] || {};
            if (f.permanently_blocked || (f.opt_out_count || 0) >= MAX_OPTOUTS) {
              return res.sendStatus(200);
            }

            const label = await decidirOptLabel(texto);

            if (label === 'OPTOUT') {
              const { next, permanently } = await registerOptOut(pool, contato, texto);
              console.log(`[${contato}] OPT-OUT #${next} ${permanently ? '(permanente)' : ''} por: "${texto}"`);
              if (!permanently) {
                await delay(10000 + Math.floor(Math.random() * 5000));
                await sendMessage(contato, OPTOUT_MSGS[next] || OPTOUT_MSGS[2], { bypassBlock: true });
              }
              return res.sendStatus(200);
            }

            if (label === 'REOPTIN' && f.do_not_contact) {
              const { allowed } = await clearOptOutIfAllowed(pool, contato);
              if (!allowed) return res.sendStatus(200);
              console.log(`[${contato}] Re-opt-in (classificador) — retomando sequência se houver.`);
              if (typeof retomarEnvio === 'function') {
                await retomarEnvio(contato);
              }
              return res.sendStatus(200);
            }
          } catch (e) {
            console.error(`[${contato}] Falha no fluxo opt-out/retomada: ${e.message}`);
          }
          // ======= FIM OPT-OUT / RE-OPT-IN =======

          let tid = '';
          let click_type = 'Orgânico';
          let is_ctwa = false;

          const referral = msg.referral || {};
          if (referral.source_type === 'ad') {
            tid = referral.ctwa_clid || '';
            click_type = 'CTWA';
            is_ctwa = true;
            console.log(`[Webhook] CTWA detectado para ${contato}: ctwa_clid=${tid}`);
          }

          if (!is_ctwa && texto) {
            const tidMatch = texto.match(/\[TID:\s*([A-Za-z0-9_-]{6,64})\]/i);
            if (tidMatch && tidMatch[1]) {
              tid = tidMatch[1];
              click_type = 'Landing';
            }
          }

          if (!is_ctwa && texto && !tid) {
            const stripInvis = (s) =>
              String(s || '')
                .normalize('NFKC')
                .replace(/[\u200B-\u200F\uFEFF\u202A-\u202E]/g, '');
            const t = stripInvis(texto);
            const firstLine = (t.split(/\r?\n/)[0] || '').trim();
            const m2 = /^[a-f0-9]{16}$/i.exec(firstLine);
            if (m2) {
              tid = m2[0];
              click_type = 'Landing';
            }
          }

          if (is_ctwa) {
            try {
              const forward_url = `${LANDING_URL}/ctwa/intake`;
              await axios.post(forward_url, body);
              console.log(`[Webhook] Forwarded CTWA data para landing: ${forward_url}`);
            } catch (error) {
              console.error(`[Webhook] Failed to forward CTWA data para landing: ${error.message}`);
            }
          }

          const wa_id = (value?.contacts && value.contacts[0]?.wa_id) || msg.from || '';
          const profile_name = (value?.contacts && value.contacts[0]?.profile?.name) || '';
          const clid = is_ctwa ? referral.ctwa_clid || '' : '';

          const shouldSendContact =
            (is_ctwa && clid && !sentContactByClid.has(clid)) ||
            (!is_ctwa && !sentContactByWa.has(wa_id) && !(estado[contato]?.capiContactSent));

          if (shouldSendContact) {
            const contactPayload = {
              wa_id,
              tid,
              ctwa_clid: clid,
              event_time: Number(msg.timestamp) || undefined,
              wamid: msg.id || '',
              profile_name,
              phone_number_id: value?.metadata?.phone_number_id || '',
              display_phone_number: value?.metadata?.display_phone_number || '',
            };
            try {
              const resp = await axios.post(`${LANDING_URL}/api/capi/contact`, contactPayload, {
                headers: {
                  'Content-Type': 'application/json',
                  'X-Contact-Token': CONTACT_TOKEN,
                },
                validateStatus: () => true,
              });
              if (is_ctwa && clid) sentContactByClid.add(clid);
              else sentContactByWa.add(wa_id);
              if (estado[contato]) estado[contato].capiContactSent = true;
              console.log(
                `[Webhook] Contact -> distribuidor status=${resp.status} deduped=${resp.data?.deduped ? 'yes' : 'no'
                } event_id=${resp.data?.event_id || ''}`
              );
            } catch (err) {
              console.error('[Webhook] Falha ao enviar Contact ao distribuidor:', err.message);
            }
          } else {
            console.log(`[Webhook] Contact suprimido (dedupe): wa_id=${wa_id} ctwa_clid=${clid || '-'}`);
          }

          // Estado & fila — sem classificar aqui
          if (!estado[contato]) {
            inicializarEstado(contato, tid, click_type);
            await criarUsuarioDjango(contato);
            await salvarContato(contato, null, texto || (isProviderMedia ? '[mídia]' : ''), tid, click_type);
            console.log(`[${contato}] Etapa 1: abertura`);
          } else {
            await salvarContato(contato, null, texto || (isProviderMedia ? '[mídia]' : ''), tid, click_type);
          }

          const st = estado[contato];
          const urlsFromText = extractUrlsFromText(texto);
          st.mensagensPendentes.push({
            texto: texto || (isProviderMedia ? '[mídia]' : ''),
            temMidia: isProviderMedia,          // SINAL DO PROVEDOR (sem heurística)
            hasMedia: isProviderMedia,          // idem
            type: msg.type || '',
            urls: urlsFromText,                 // metadado (bot.js decide se é “mídia” útil)
          });
          if (texto && !st.mensagensDesdeSolicitacao.includes(texto)) st.mensagensDesdeSolicitacao.push(texto);
          st.ultimaMensagem = Date.now();

          if (st.enviandoMensagens) {
            console.log(`[${contato}] Mensagem acumulada, aguardando processamento`);
          } else {
            const delayAleatorio = 10000 + Math.random() * 5000;
            console.log(
              `[${contato}] Aguardando ${Math.round(delayAleatorio / 1000)} segundos antes de processar a mensagem`
            );
            await delay(delayAleatorio);
            console.log(`[${contato}] Processando mensagem após atraso`);
            await processarMensagensPendentes(contato);
          }
        }
      }
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  });

  // ---- Twilio Webhook (entrada) ----
  app.post('/webhook/twilio', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const signature = req.get('X-Twilio-Signature') || req.get('x-twilio-signature');
      const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

      const isValid = twilio.validateRequest(authToken, signature, url, req.body);
      if (!isValid) return res.sendStatus(403);

      const from = (req.body.From || '').replace(/^whatsapp:/, '');
      const text = (req.body.Body || '').trim();

      // Sinal do próprio Twilio
      const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;
      const mediaUrls = [];
      for (let i = 0; i < numMedia; i++) {
        const u = req.body[`MediaUrl${i}`];
        if (u) mediaUrls.push(u);
      }

      if (!estado[from]) {
        inicializarEstado(from, '', 'Twilio');
        await criarUsuarioDjango(from);
        await salvarContato(from, null, text || (numMedia > 0 ? '[mídia]' : ''), '', 'Twilio');
      } else {
        await salvarContato(from, null, text || (numMedia > 0 ? '[mídia]' : ''), '', 'Twilio');
      }

      const st = estado[from];
      st.mensagensPendentes.push({
        texto: text || (numMedia > 0 ? '[mídia]' : ''),
        temMidia: numMedia > 0,     // SINAL DO PROVEDOR
        hasMedia: numMedia > 0,
        type: numMedia > 0 ? 'media' : 'text',
        urls: mediaUrls,            // metadado bruto (bot.js decide)
      });
      if (text && !st.mensagensDesdeSolicitacao.includes(text)) st.mensagensDesdeSolicitacao.push(text);
      st.ultimaMensagem = Date.now();

      if (st.enviandoMensagens) {
        console.log(`[${from}] (Twilio) Mensagem acumulada, aguardando processamento`);
      } else {
        const delayAleatorio = 10000 + Math.random() * 5000;
        console.log(`[${from}] (Twilio) Aguardando ${Math.round(delayAleatorio / 1000)}s antes de processar`);
        await delay(delayAleatorio);
        await processarMensagensPendentes(from);
      }

      res.sendStatus(200);
    } catch (e) {
      console.error('[TwilioWebhook] Erro:', e.message);
      res.sendStatus(500);
    }
  });

  /**
   * MANYCHAT - Dynamic Content v2 (primeira resposta)
   * Não finaliza a abertura aqui; o bot faz via processarMensagensPendentes.
   */
  app.post('/manychat/reply', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      console.log('[ManyChat/DC] Raw payload:', JSON.stringify(body));

      const subscriberId =
        body.subscriber_id ||
        body?.contact?.id ||
        body?.contact?.subscriber_id ||
        body?.user?.id ||
        null;

      const rawPhone =
        body?.user?.phone ||
        body?.contact?.phone ||
        body?.contact?.wa_id ||
        (body?.full_contact?.whatsapp && body.full_contact.whatsapp.id) ||
        body?.phone ||
        '';
      const phone = onlyDigits(rawPhone);

      if (!phone && !subscriberId) {
        console.warn('[ManyChat/DC] Sem phone/subscriber_id. Retornando 204.');
        return res.status(204).end();
      }

      const idContato = await bootstrapFromManychat(
        phone,
        subscriberId,
        inicializarEstado,
        salvarContato,
        criarUsuarioDjango,
        estado
      );

      if (subscriberId && phone) {
        try {
          await pool.query('UPDATE contatos SET manychat_subscriber_id = $2 WHERE id = $1', [phone, subscriberId]);
          console.log('[ManyChat/DC] subscriber_id vinculado ao contato', { phone, subscriberId });
        } catch (e) {
          console.warn('[ManyChat/DC] Falha ao vincular subscriber_id:', e.message);
        }
      }

      const ack = 'ok, já te respondo aqui';
      const messages = [{ type: 'text', text: ack }];

      return res.status(200).json({
        version: 'v2',
        content: { type: 'whatsapp', messages },
      });
    } catch (e) {
      console.error('[ManyChat/DC] Erro:', e);
      return res.status(200).json({
        version: 'v2',
        content: { type: 'whatsapp', messages: [{ type: 'text', text: 'deu ruim aqui, tenta de novo rapidinho' }] },
      });
    }
  });

  // === ManyChat → seu webhook de entrada ===
  app.post('/webhook/manychat', express.json(), async (req, res) => {
    // ===== utilitários de log =====
    const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase(); // debug|info|warn|error
    const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
    const want = ORDER[LOG_LEVEL] || 20;
    const log = (level, msg, data) => {
      const need = ORDER[level] || 20;
      if (need < want) return;
      if (data) console[level === 'debug' ? 'log' : level](`[ManyChat] ${reqId} ${msg}`, data);
      else console[level === 'debug' ? 'log' : level](`[ManyChat] ${reqId} ${msg}`);
    };
    const mask = (s, keepStart = 2, keepEnd = 2) => {
      if (!s) return '';
      const str = String(s);
      if (str.length <= keepStart + keepEnd) return '*'.repeat(str.length);
      return str.slice(0, keepStart) + '*'.repeat(Math.max(0, str.length - keepStart - keepEnd)) + str.slice(-keepEnd);
    };
    const trunc = (s, n = 120) => {
      const str = String(s || '');
      return str.length <= n ? str : str.slice(0, n) + '…';
    };
    const reqId = `mc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    // headers
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString();
    const method = req.method;
    const path = req.originalUrl || req.url;
    const ua = req.get('User-Agent') || req.get('user-agent') || '';
    const ct = req.get('Content-Type') || req.get('content-type') || '';
    log('info', `hit ${method} ${path}`, { ip, ua: trunc(ua, 80), contentType: ct });

    // 0) Segurança
    const settings = await getBotSettings().catch(() => ({}));
    const secretConfigured = process.env.MANYCHAT_WEBHOOK_SECRET || settings.manychat_webhook_secret || '';
    const headerSecret = req.get('X-MC-Secret') || '';
    if (!secretConfigured) {
      log('warn', 'Webhook sem secret configurado (MANYCHAT_WEBHOOK_SECRET ausente).');
    } else {
      const match = headerSecret && headerSecret === secretConfigured;
      log('debug', 'Auth check', {
        headerPresent: !!headerSecret,
        headerLen: headerSecret ? headerSecret.length : 0,
        secretConfigured: !!secretConfigured,
        headerMask: mask(headerSecret, 1, 1),
        configuredMask: mask(secretConfigured, 1, 1),
        match
      });
      if (!match) {
        log('warn', 'Auth FAIL: X-MC-Secret ausente/incorreto — 401.');
        return res.sendStatus(401);
      }
    }

    // 1) Payload
    const payload = req.body || {};
    log('debug', 'Payload bruto', payload);

    // 2) Campos
    const subscriberId = payload.subscriber_id || payload?.contact?.id || null;

    const textInRaw = payload.text || payload.last_text_input || '';
    const textIn = typeof textInRaw === 'string' ? textInRaw.trim() : '';

    const full = payload.full_contact || {};
    let rawPhone = '';
    let phoneSrc = '';
    const phoneCandidates = [
      ['payload.user.phone', payload?.user?.phone],
      ['payload.contact.phone', payload?.contact?.phone],
      ['payload.contact.wa_id', payload?.contact?.wa_id],
      ['full_contact.whatsapp.id', (full?.whatsapp && full.whatsapp.id)],
      ['full_contact.phone', full?.phone],
      ['payload.phone', payload?.phone],
    ];
    for (const [src, val] of phoneCandidates) {
      if (val) { rawPhone = val; phoneSrc = src; break; }
    }
    const phone = onlyDigits(rawPhone);

    // NÃO classificar mídia aqui — só metadados crus
    const declaredType =
      payload.last_reply_type ||
      payload.last_input_type ||
      payload?.message?.type ||
      payload?.last_message?.type ||
      '';

    const urlsFromText = extractUrlsFromText(textIn);
    const urlsFromPayload = harvestUrlsFromPayload(payload);
    const allUrls = Array.from(new Set([...urlsFromText, ...urlsFromPayload]));

    log('info', 'Extracted fields', {
      subscriberId,
      phoneSrc,
      phoneMask: mask(phone),
      hasText: !!textIn,
      textPreview: trunc(textIn, 100),
      declaredType,
      urlCount: allUrls.length
    });

    if (!phone) {
      log('warn', 'Telefone ausente após extração — ignorando evento.');
      return res.status(200).json({ ok: true, ignored: 'no-phone' });
    }

    // 3) TID / origem
    let detectedTid = '';
    let detectedClickType = 'Orgânico';

    const tidMatch = (textIn || '').match(/\[TID:\s*([A-Za-z0-9_-]{6,64})\]/i);
    if (tidMatch && tidMatch[1]) {
      detectedTid = tidMatch[1];
      detectedClickType = 'Landing';
    }

    if (!detectedTid && textIn) {
      const stripInvis = (s) =>
        String(s || '')
          .normalize('NFKC')
          .replace(/[\u200B-\u200F\uFEFF\u202A-\u202E]/g, '');
      const t = stripInvis(textIn);
      const firstLine = (t.split(/\r?\n/)[0] || '').trim();
      const m2 = /^[a-f0-9]{16}$/i.exec(firstLine);
      if (m2) {
        detectedTid = m2[0];
        detectedClickType = 'Landing';
      }
    }

    // 4) Preservar DB
    let finalTid = detectedTid;
    let finalClickType = detectedClickType;
    try {
      const existing = await getContatoByPhone(phone);
      if (existing) {
        log('debug', 'Contato existente no DB', {
          existingTid: existing.tid || '',
          existingClickType: existing.click_type || ''
        });
        if (existing.tid) finalTid = existing.tid;
        if (existing.click_type && existing.click_type !== 'Orgânico') {
          finalClickType = existing.click_type;
        } else {
          finalClickType = finalTid ? 'Landing' : 'Orgânico';
        }
      }
    } catch (e) {
      log('warn', 'getContatoByPhone falhou; seguindo com detectados', { err: e.message });
    }

    log('info', 'Origem consolidada', { tid: finalTid || '', clickType: finalClickType });

    // 5) Bootstrap
    let idContato = '';
    try {
      idContato = await bootstrapFromManychat(
        phone,
        subscriberId,
        inicializarEstado,
        salvarContato,
        criarUsuarioDjango,
        estado,
        finalTid,
        finalClickType
      );
      log('debug', 'Bootstrap concluído', { idContato });
    } catch (e) {
      log('error', 'Erro no bootstrapFromManychat', { err: e.message });
    }

    // 6) Vincular subscriber_id
    if (subscriberId && phone) {
      try {
        const r = await pool.query(
          'UPDATE contatos SET manychat_subscriber_id = $2 WHERE id = $1',
          [phone, subscriberId]
        );
        log('debug', 'Vinculação subscriber_id → contato', { phoneMask: mask(phone), subscriberId, rowCount: r.rowCount });
      } catch (e) {
        log('error', 'Falha ao vincular subscriber_id', { err: e.message });
      }
    }

    // 7) Histórico (sem decidir mídia aqui)
    const textoRecebido = textIn || '';
    const st = estado[idContato] || {};
    try {
      await salvarContato(
        idContato,
        null,
        textoRecebido,
        st.tid || finalTid || '',
        st.click_type || finalClickType || 'Orgânico'
      );
      log('debug', 'Contato salvo/atualizado', { idContato, hasText: !!textoRecebido });
    } catch (e) {
      log('error', 'Erro ao salvarContato', { err: e.message });
    }

    // 7A) Opt-out / Re-opt-in
    try {
      const { rows: flags } = await pool.query(
        'SELECT do_not_contact, opt_out_count, permanently_blocked FROM contatos WHERE id = $1 LIMIT 1',
        [phone]
      );
      const f = flags?.[0] || {};
      if (f.permanently_blocked || (f.opt_out_count || 0) >= MAX_OPTOUTS) {
        return res.json({ ok: true, ignored: 'permanently_blocked' });
      }

      const label = await decidirOptLabel(textIn || '');

      if (label === 'OPTOUT') {
        const { next, permanently } = await registerOptOut(pool, phone, textIn || '');
        console.log(`[${phone}] OPT-OUT #${next} ${permanently ? '(permanente)' : ''} por: "${textIn}"`);
        if (!permanently) {
          await delay(10000 + Math.floor(Math.random() * 5000));
          await sendMessage(phone, OPTOUT_MSGS[next] || OPTOUT_MSGS[2], { bypassBlock: true });
        }
        return res.json({ ok: true });
      }

      if (label === 'REOPTIN' && f.do_not_contact) {
        await pool.query(
          `UPDATE contatos
         SET do_not_contact = FALSE,
             do_not_contact_at = NULL,
             do_not_contact_reason = NULL
       WHERE id = $1`,
          [phone]
        );
        console.log(`[${phone}] Re-opt-in (classificador) — retomando sequência.`);
        await retomarEnvio(phone);
      }

      const n = norm(textIn || '');
      const isToken = OPTOUT_TOKENS.has(n);
      const isPhrase = OPTOUT_PHRASES.some(p => n.includes(p));
      if (isToken || isPhrase) {
        const { next, permanently } = await registerOptOut(pool, phone, textIn || '');
        console.log(`[${phone}] OPT-OUT #${next} ${permanently ? '(permanente)' : ''} por: "${textIn}"`);
        if (!permanently) {
          await delay(10000 + Math.floor(Math.random() * 5000));
          await sendMessage(phone, OPTOUT_MSGS[next] || OPTOUT_MSGS[2], { bypassBlock: true });
        }
        return res.json({ ok: true });
      }
    } catch (e) {
      console.error(`[${phone}] Falha no fluxo opt-out/retomada: ${e.message}`);
    }

    // 8) Enfileirar (metadados crus; bot.js decide)
    if (!estado[idContato]) estado[idContato] = { mensagensPendentes: [], mensagensDesdeSolicitacao: [] };
    const stNow = estado[idContato];

    stNow.mensagensPendentes.push({
      texto: textoRecebido,
      temMidia: false,        // NÃO decidimos aqui
      hasMedia: false,        // idem
      type: declaredType || (textoRecebido ? 'text' : ''), // hint
      urls: allUrls,          // matéria-prima p/ bot.js
      // attachments: payload.attachments || payload?.last_message?.attachments || []
    });

    if (textoRecebido && !stNow.mensagensDesdeSolicitacao.includes(textoRecebido)) {
      stNow.mensagensDesdeSolicitacao.push(textoRecebido);
    }
    stNow.ultimaMensagem = Date.now();

    log('info', 'Mensagem enfileirada (sem classificar)', {
      idContato,
      queueSize: stNow.mensagensPendentes.length,
      urlCount: allUrls.length,
      declaredType
    });

    // 9) Processamento
    setTimeout(async () => {
      const delayAleatorio = 10000 + Math.random() * 5000;
      log('debug', `Processamento agendado em ~${Math.round(delayAleatorio / 1000)}s`, { idContato });
      try {
        await delay(delayAleatorio);
        await processarMensagensPendentes(idContato);
        log('debug', 'processarMensagensPendentes concluído', { idContato });
      } catch (e) {
        log('error', 'Erro no processamento assíncrono', { err: e.message });
      }
    }, 0);

    return res.status(200).json({ ok: true, reqId });
  });
}

module.exports = { checkAuth, setupRoutes };
