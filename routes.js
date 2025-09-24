// routes.js
const path = require('path');
const express = require('express');
const axios = require('axios');
const twilio = require('twilio'); // npm i twilio
const qs = require('qs');

const { pool } = require('./db.js');
const { delay, sendMessage } = require('./bot.js');
const { getBotSettings, updateBotSettings, getContatoByPhone } = require('./db.js');

const LANDING_URL = 'https://grupo-whatsapp-trampos-lara-2025.onrender.com';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const CONTACT_TOKEN = process.env.CONTACT_TOKEN;

const sentContactByWa = new Set();
const sentContactByClid = new Set();

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase(); // debug|info|warn|error
const isDebug = () => LOG_LEVEL === 'debug';

function maskPhone(p) {
  const s = String(p || '');
  if (s.length < 6) return '***';
  return s.slice(0, 2) + '*****' + s.slice(-2);
}
function mcLog(level, msg, data) {
  const lv = level.toLowerCase();
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((order[lv] || 20) < (order[LOG_LEVEL] || 20)) return;
  if (data) console[lv === 'debug' ? 'log' : lv](`[ManyChat] ${msg}`, data);
  else console[lv === 'debug' ? 'log' : lv](`[ManyChat] ${msg}`);
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

const URL_RX = /https?:\/\/\S+/i;
const IMG_EXT_RX = /\.(jpg|jpeg|png|webp|gif|heic|heif|bmp|tif|tiff)(\?|#|$)/i;
const IMG_HOST_HINTS = ['manybot-files.s3', 'manibot-files.s3', 'manychat'];

function extractFirstUrl(s = '') {
  const m = String(s || '').match(URL_RX);
  return m ? m[0] : '';
}

function isLikelyMediaUrl(s = '') {
  const url = String(s || '').trim();

  // tem que se parecer com uma URL "pura"
  if (!/^https?:\/\/\S+$/i.test(url)) return false;

  // extensões comuns de mídia/arquivo
  if (/\.(jpe?g|png|gif|webp|bmp|heic|heif|mp4|mov|m4v|avi|mkv|mp3|m4a|ogg|wav|opus|pdf|docx?|xlsx?|pptx?)($|\?)/i.test(url)) {
    return true;
  }

  // hosts comuns do ManyChat/WhatsApp/CDNs (heurística)
  const knownHosts = [
    'manybot-files.s3.',   // ManyChat S3
    'cdn.manychat.com',    // (exemplo)
    'mmg.whatsapp.net',    // WA media
    'lookaside.fbsbx.com', // proxys do Meta
  ];
  try {
    const { host } = new URL(url);
    if (knownHosts.some(h => host.includes(h))) return true;
  } catch (_) { }

  return false;
}

async function bootstrapFromManychat(
  phone,
  subscriberId,
  inicializarEstado,
  salvarContato,
  criarUsuarioDjango,
  estado,
  // ▼ NOVO: valores decididos antes no handler
  initialTid = '',
  initialClickType = 'Orgânico'
) {
  const idContato = phone || `mc:${subscriberId}`;

  if (!estado[idContato]) {
    // Primeiro contato: inicia já com TID/click_type corretos
    inicializarEstado(idContato, initialTid, initialClickType);
  } else {
    // Contato já existe em memória: só preenche se estiver vazio
    const st = estado[idContato];
    if (!st.tid && initialTid) {
      st.tid = initialTid;
      st.click_type = initialClickType || 'Orgânico';
    }
  }

  // garante registro do contato sem sobrescrever com valores errados
  const stNow = estado[idContato] || {};
  await salvarContato(
    idContato,
    null,
    null,
    stNow.tid || initialTid || '',
    stNow.click_type || initialClickType || 'Orgânico'
  ).catch(() => { });

  // cria usuário no Django apenas se ainda não existir no estado
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

// Re-opt-in (estrito): "BORA"
const REOPTIN_RX = /^\s*bora\s*$/i;

// 1ª resposta (neutra e curtinha)
function buildOpeningReply() {
  const a = ['eae', 'salve', 'oi'];
  const b = ['recebi sua msg', 'tô aqui', 'fala comigo'];
  const c = ['me diz rapidão o que cê precisa'];
  return [a[Math.floor(Math.random() * a.length)], b[Math.floor(Math.random() * b.length)], c[0]].join('\n');
}

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

        // provider + credenciais
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

          const texto = msg.type === 'text' ? (msg.text.body || '').trim() : '[mídia]';
          const temMidia = msg.type !== 'text';
          console.log(`[${contato}] Recebido: "${texto}"`);

          // ======= OPT-OUT / RE-OPT-IN =======
          try {
            const n = norm(texto);

            // 1) Re-opt-in
            const { rows: flags } = await pool.query(
              'SELECT do_not_contact FROM contatos WHERE id = $1 LIMIT 1',
              [contato]
            );
            if (flags[0]?.do_not_contact) {
              if (REOPTIN_RX.test(texto)) {
                await pool.query(
                  `UPDATE contatos
                     SET do_not_contact = FALSE,
                         do_not_contact_at = NULL,
                         do_not_contact_reason = NULL
                   WHERE id = $1`,
                  [contato]
                );
                console.log(`[${contato}] Re-opt-in por "BORA"`);
                await sendMessage(contato, 'fechou, voltamos então. bora.');
              } else {
                await sendMessage(contato, 'vc tinha parado as msgs. se quiser retomar, manda "BORA".');
                return res.sendStatus(200);
              }
            }

            // 2) Opt-out
            const isToken = OPTOUT_TOKENS.has(n);
            const isPhrase = OPTOUT_PHRASES.some((p) => n.includes(p));
            if (isToken || isPhrase) {
              await pool.query(
                `UPDATE contatos
                   SET do_not_contact = TRUE,
                       do_not_contact_at = NOW(),
                       do_not_contact_reason = $2
                 WHERE id = $1`,
                [contato, texto.slice(0, 200)]
              );
              console.log(`[${contato}] OPT-OUT ativado por: "${texto}"`);
              await sendMessage(
                contato,
                'tranquilo, vamos parar então, vou passar o trampo pra outra pessoa. se mudar de ideia só mandar um "BORA" aí que voltamos a fazer'
              );
              return res.sendStatus(200);
            }
          } catch (e) {
            console.error(`[${contato}] Falha no fluxo opt-in/out: ${e.message}`);
          }
          // ======= FIM OPT-OUT / RE-OPT-IN =======

          let tid = '';
          let click_type = 'Orgânico';
          let is_ctwa = false;

          // Detecta CTWA
          const referral = msg.referral || {};
          if (referral.source_type === 'ad') {
            tid = referral.ctwa_clid || '';
            click_type = 'CTWA';
            is_ctwa = true;
            console.log(`[Webhook] CTWA detectado para ${contato}: ctwa_clid=${tid}`);
          }

          // Landing TID
          if (!is_ctwa && msg.type === 'text') {
            const tidMatch = texto.match(/\[TID:\s*([\w]+)\]/i);
            if (tidMatch && tidMatch[1]) {
              tid = tidMatch[1];
              click_type = 'Landing';
              console.log(`[Webhook] Landing detectada para ${contato}: TID=${tid}`);
            }
          }

          // Forward CTWA
          if (is_ctwa) {
            try {
              const forward_url = `${LANDING_URL}/ctwa/intake`;
              await axios.post(forward_url, body);
              console.log(`[Webhook] Forwarded CTWA data para landing: ${forward_url}`);
            } catch (error) {
              console.error(`[Webhook] Failed to forward CTWA data para landing: ${error.message}`);
            }
          }

          // Contact event (dedupe)
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

          // Estado & fila
          if (!estado[contato]) {
            inicializarEstado(contato, tid, click_type);
            await criarUsuarioDjango(contato);
            await salvarContato(contato, null, texto, tid, click_type);
            console.log(`[${contato}] Etapa 1: abertura`);
          } else {
            await salvarContato(contato, null, texto, tid, click_type);
          }

          const st = estado[contato];
          st.mensagensPendentes.push({ texto, temMidia });
          if (!st.mensagensDesdeSolicitacao.includes(texto)) st.mensagensDesdeSolicitacao.push(texto);
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
      const temMidia = false; // TODO: tratar mídia Twilio

      if (!estado[from]) {
        inicializarEstado(from, '', 'Twilio');
        await criarUsuarioDjango(from);
        await salvarContato(from, null, text, '', 'Twilio');
      } else {
        await salvarContato(from, null, text, '', 'Twilio');
      }
      const st = estado[from];
      st.mensagensPendentes.push({ texto: text || '[mídia]', temMidia });
      if (!st.mensagensDesdeSolicitacao.includes(text)) st.mensagensDesdeSolicitacao.push(text);
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
   * Use este endpoint no bloco: WhatsApp → Conteúdo Dinâmico
   *
   * Importante: NÃO marcamos 'aberturaConcluida' aqui para que o bot envie
   * as mensagens variáveis da abertura normalmente via processarMensagensPendentes.
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

      // Inicializa/amarra estado e cria usuário (sem concluir abertura!)
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

      // Resposta mínima só para satisfazer o DC v2 (o bot mandará a abertura real)
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

app.post('/webhook/manychat', express.json(), async (req, res) => {
  // ===== utilitários de log (verbose c/ níveis e reqId) =====
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

  // ===== headers básicos + rede =====
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString();
  const method = req.method;
  const path = req.originalUrl || req.url;
  const ua = req.get('User-Agent') || req.get('user-agent') || '';
  const ct = req.get('Content-Type') || req.get('content-type') || '';
  log('info', `hit ${method} ${path}`, { ip, ua: trunc(ua, 80), contentType: ct });

  // ===== 0) Segurança do webhook (log antes do 401) =====
  const settings = await getBotSettings().catch(() => ({}));
  const secretConfigured = process.env.MANYCHAT_WEBHOOK_SECRET || settings.manychat_webhook_secret || '';
  const headerSecret = req.get('X-MC-Secret') || '';
  if (!secretConfigured) {
    log('warn', 'Webhook sem secret configurado (MANYCHAT_WEBHOOK_SECRET ou settings.manychat_webhook_secret ausente).');
  } else {
    const match = headerSecret && headerSecret === secretConfigured;
    log('debug', 'Auth check', {
      headerPresent: !!headerSecret,
      headerLen: headerSecret ? headerSecret.length : 0,
      secretConfigured: !!secretConfigured,
      // nunca logar o valor bruto: mostramos só máscara e se bateu
      headerMask: mask(headerSecret, 1, 1),
      configuredMask: mask(secretConfigured, 1, 1),
      match
    });
    if (!match) {
      log('warn', 'Auth FAIL: X-MC-Secret ausente/incorreto — retornando 401.');
      return res.sendStatus(401);
    }
  }

  // ===== 1) Payload bruto (apenas em debug) =====
  const payload = req.body || {};
  log('debug', 'Payload bruto', payload);

  // ===== 2) Extração flexível de campos (com logs) =====
  const subscriberId = payload.subscriber_id || payload?.contact?.id || null;

  const textInRaw = payload.text || payload.last_text_input || '';
  const textIn = typeof textInRaw === 'string' ? textInRaw.trim() : '';

  // rastrear de onde veio o telefone
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

  // Mídia: heurística por URL (sem last_reply_type)
  const temMidia = isLikelyMediaUrl(textIn);

  log('info', 'Extracted fields', {
    subscriberId,
    phoneSrc,
    phoneMask: mask(phone),
    hasText: !!textIn,
    textPreview: trunc(textIn, 100),
    hasMedia: temMidia
  });

  if (!phone) {
    log('warn', 'Telefone ausente após extração — ignorando evento.');
    return res.status(200).json({ ok: true, ignored: 'no-phone' });
  }

  // ===== 3) DETECÇÃO de TID e click_type (espelha fluxo Cloud API) =====
  let detectedTid = '';
  let detectedClickType = 'Orgânico';

  const tidMatch = (textIn || '').match(/\[TID:\s*([\w-]+)\]/i);
  if (tidMatch && tidMatch[1]) {
    detectedTid = tidMatch[1];
    detectedClickType = 'Landing';
    log('info', 'TID detectado via texto', { tid: detectedTid });
  }

  if (!detectedTid) {
    const mcTid = payload?.clid || payload?.tid || payload?.meta?.tid || payload?.meta?.clid;
    if (mcTid) {
      detectedTid = String(mcTid);
      detectedClickType = 'Landing';
      log('info', 'TID detectado via payload', { tid: detectedTid });
    }
  }

  // ===== 4) Preservar o que já existe no DB (com logs) =====
  let finalTid = detectedTid;
  let finalClickType = detectedClickType; // 'Landing' se achou TID; senão 'Orgânico'
  try {
    const existing = await getContatoByPhone(phone);
    if (existing) {
      log('debug', 'Contato existente no DB', {
        existingTid: existing.tid || '',
        existingClickType: existing.click_type || ''
      });
      if (existing.tid) finalTid = existing.tid; // preserva TID já salvo
      if (existing.click_type && existing.click_type !== 'Orgânico') {
        finalClickType = existing.click_type; // preserva click_type específico (CTWA/Landing)
      } else {
        finalClickType = finalTid ? 'Landing' : 'Orgânico';
      }
    }
  } catch (e) {
    log('warn', 'getContatoByPhone falhou; seguindo com detectados', { err: e.message });
  }

  log('info', 'Origem consolidada', { tid: finalTid || '', clickType: finalClickType });

  // ===== 5) Bootstrap (estado + contato + criação de usuário) =====
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
    // ainda assim damos ACK para não gerar retries infinitos no provedor
  }

  // ===== 6) Vincular subscriber_id (com logs de resultado) =====
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

  // ===== 7) Salvar histórico (preservando TID/click_type corretos) =====
  const textoRecebido = (temMidia && !textIn) ? '[mídia]' : textIn;
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

  // ===== 8) Fila/estado de mensagens =====
  if (!estado[idContato]) estado[idContato] = { mensagensPendentes: [], mensagensDesdeSolicitacao: [] };
  const stNow = estado[idContato];
  stNow.mensagensPendentes.push({ texto: textoRecebido, temMidia });
  if (textoRecebido && !stNow.mensagensDesdeSolicitacao.includes(textoRecebido)) {
    stNow.mensagensDesdeSolicitacao.push(textoRecebido);
  }
  stNow.ultimaMensagem = Date.now();

  log('info', 'Mensagem enfileirada', {
    idContato,
    queueSize: stNow.mensagensPendentes.length,
    hasMedia: temMidia
  });

  // ===== 9) Disparo do processamento assíncrono =====
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

  // ===== 10) ACK imediato =====
  return res.status(200).json({ ok: true, reqId });
});


}

module.exports = { checkAuth, setupRoutes };