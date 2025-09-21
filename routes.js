// routes.js
const path = require('path');
const express = require('express');
const axios = require('axios');
const { pool } = require('./db.js');
const { delay, sendMessage } = require('./bot.js');
const { getBotSettings, updateBotSettings } = require('./db.js');
const estadoContatos = require('./state.js');
const twilio = require('twilio'); // npm i twilio
const qs = require('qs');

const LANDING_URL = 'https://grupo-whatsapp-trampos-lara-2025.onrender.com';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const CONTACT_TOKEN = process.env.CONTACT_TOKEN;
const sentContactByWa = new Set();
const sentContactByClid = new Set();

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

// Palavras/frases de OPT-OUT
const OPTOUT_TOKENS = new Set(['sair', 'parar', 'cancelar', 'remover', 'nao quero']);
const OPTOUT_PHRASES = [
  'nao quero receber',
  'para de enviar',
  'chega',
  'para com isso',
  'tira meu numero',
  'nao quero mais'
];

// Re-opt-in (estrito): "BORA"
const REOPTIN_RX = /^\s*bora\s*$/i;

// Normaliza telefone
function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

// Gera a 1ª resposta do bot (mensagem neutra/placeholder)
// -> personalize o texto conforme o SEU uso legítimo.
function buildOpeningReply() {
  const a = ['Olá!', 'Oi!', 'Tudo certo?'];
  const b = ['Recebi sua mensagem.', 'Estou aqui.'];
  const c = ['Como posso ajudar?'];
  return [a[Math.floor(Math.random()*a.length)], b[Math.floor(Math.random()*b.length)], c[0]].join('\n');
}

function setupRoutes(app, pathModule, processarMensagensPendentes, inicializarEstado, criarUsuarioDjango, salvarContato, VERIFY_TOKEN, estado) {
  // static
  app.use('/public', express.static(pathModule.join(__dirname, 'public')));

  // ---- Auth & Admin ----
  app.get('/login', (req, res) => {
    res.sendFile(pathModule.join(__dirname, 'public', 'login.html'));
  });

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

  app.get('/dashboard', checkAuth, (req, res) => {
    res.sendFile(pathModule.join(__dirname, 'public', 'dashboard.html'));
  });

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
        manychat_webhook_secret: (req.body.manychat_webhook_secret || '').trim()
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
      const messagesReceivedRes = await client.query('SELECT SUM(jsonb_array_length(historico)) AS total FROM contatos');
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
        stages
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
        req.params.id
      ]);

      const historico = historicoRes.rows[0]?.historico || [];
      const interacoes = interacoesRes.rows[0]?.historico_interacoes || [];

      const allMessages = [
        ...historico.map((msg) => ({ ...msg, role: 'received' })),
        ...interacoes.map((msg) => ({ ...msg, role: 'sent' }))
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
          if (change.field === 'messages') {
            const value = change.value;
            if (value.messages && value.messages.length > 0) {
              const msg = value.messages[0];
              const contato = msg.from;

              if (contato === PHONE_NUMBER_ID) {
                console.log(`[Webhook] Ignorando eco de mensagem enviada pelo bot (ID: ${msg.id})`);
                res.sendStatus(200);
                return;
              }

              let texto = msg.type === 'text' ? msg.text.body.trim() : '[mídia]';
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
                  display_phone_number: value?.metadata?.display_phone_number || ''
                };
                try {
                  const resp = await axios.post(`${LANDING_URL}/api/capi/contact`, contactPayload, {
                    headers: {
                      'Content-Type': 'application/json',
                      'X-Contact-Token': CONTACT_TOKEN
                    },
                    validateStatus: () => true
                  });
                  if (is_ctwa && clid) sentContactByClid.add(clid);
                  else sentContactByWa.add(wa_id);
                  if (estado[contato]) estado[contato].capiContactSent = true;
                  console.log(
                    `[Webhook] Contact -> distribuidor status=${resp.status} deduped=${resp.data?.deduped ? 'yes' : 'no'} event_id=${resp.data?.event_id || ''}`
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
                console.log(`[${contato}] Aguardando ${Math.round(delayAleatorio / 1000)} segundos antes de processar a mensagem`);
                await delay(delayAleatorio);
                console.log(`[${contato}] Processando mensagem após atraso`);
                await processarMensagensPendentes(contato);
              }
            }
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

      const from = (req.body.From || '').replace(/^whatsapp:/, ''); // +5511...
      const to = (req.body.To || '').replace(/^whatsapp:/, '');
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

app.post('/webhook/manychat', express.json(), async (req, res) => {
  // 0) valida segredo
  const settings = await getBotSettings().catch(() => ({}));
  const secret = process.env.MANYCHAT_WEBHOOK_SECRET || settings.manychat_webhook_secret;
  if (secret && req.get('X-MC-Secret') !== secret) {
    return res.sendStatus(401);
  }

  // 1) logs + extração segura
  const payload = req.body || {};
  console.log('[ManyChat] Headers:', {
    ua: req.get('User-Agent') || req.get('user-agent'),
    contentType: req.get('Content-Type') || req.get('content-type'),
    secretPresent: !!req.get('X-MC-Secret')
  });
  console.log('[ManyChat] Raw payload:', JSON.stringify(payload));

  const subscriberId = payload.subscriber_id || payload?.contact?.id || null;
  const textIn = (payload.text || payload.last_text_input || '').trim();

  const full = payload.full_contact || {};
  const rawPhone =
    payload?.user?.phone ||
    payload?.contact?.phone ||
    (full?.whatsapp && full.whatsapp.id) ||
    full?.phone ||
    payload?.phone ||
    '';
  const phone = onlyDigits(rawPhone);

  const lastType = (payload.last_reply_type || '').toString().toLowerCase();
  const temMidia = !!(lastType && lastType !== 'text');

  // se vierem placeholders, avisa (não bloqueia)
  if (
    JSON.stringify(payload).includes('{{') ||
    JSON.stringify(payload).includes('}}')
  ) {
    console.warn('[ManyChat] Aviso: placeholders {{...}} detectados no payload');
  }

  // 2) sanity checks mínimos
  if (!phone) {
    console.warn('[ManyChat] Telefone ausente. Cancelando processamento.');
    return res.status(200).json({ ok: true });
  }

  // 3) vincula subscriber_id ao contato (quando existir)
  if (subscriberId) {
    try {
      await pool.query(
        'UPDATE contatos SET manychat_subscriber_id = $2 WHERE id = $1',
        [phone, subscriberId]
      );
      console.log('[ManyChat] subscriber_id vinculado ao contato', { phone, subscriberId });
    } catch (e) {
      console.warn('[ManyChat] Falha ao vincular subscriber_id:', e.message);
    }
  }

  // 4) define se é a "primeira resposta" (sem estado prévio OU ainda em abertura sem ter respondido)
  const st = estadoContatos[phone];
  const isFirst = !st || (st.etapa === 'abertura' && !st.aberturaConcluida);

  // 5) inicializa estado e persiste contato (não bloqueante)
  if (!st) {
    try {
      inicializarEstado(phone, '', 'Manychat'); // tid vazio, click_type Manychat
      await salvarContato(phone, null, textIn || (temMidia ? '[mídia]' : ''), '', 'Manychat');
    } catch (e) {
      console.warn(`[${phone}] Falha ao inicializar/salvar contato:`, e.message);
    }
  } else {
    try {
      await salvarContato(phone, null, textIn || (temMidia ? '[mídia]' : ''), st.tid || '', 'Manychat');
    } catch (e) {
      console.warn(`[${phone}] Falha ao salvar contato existente:`, e.message);
    }
  }

  // 6) SE for a primeira resposta, devolve **Dynamic Block v2** já com a mensagem
  if (isFirst) {
    const reply = buildOpeningReply(); // personalize conforme seu caso DE USO LEGAL

    // marca no estado para não tentar re-enviar essa "abertura" depois
    try {
      const state = (estadoContatos[phone] ||= {});
      state.aberturaConcluida = true;
      state.historico = state.historico || [];
      state.historico.push({ role: 'assistant', content: reply });
      await salvarContato(phone, null, reply, '', 'Manychat');
      console.log(`[${phone}] Respondendo via Dynamic Block v2 (primeira mensagem)`);
    } catch (e) {
      console.warn(`[${phone}] Falha ao atualizar estado/DB após primeira resposta:`, e.message);
    }

    // retorna bloco dinâmico (até 10 mensagens)
    const messages = reply
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 10)
      .map(t => ({ type: 'text', text: t }));

    return res.status(200).json({
      version: 'v2',
      content: { messages }
    });
  }

  // 7) caso contrário, ACK imediato e processa pipeline em background
  res.status(200).json({ ok: true });

  (async () => {
    try {
      const state = (estadoContatos[phone] ||= {
        etapa: 'abertura',
        historico: [],
        encerrado: false,
        ultimaMensagem: Date.now(),
        credenciais: null,
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
        tid: '',
        click_type: 'Manychat',
        capiContactSent: false
      });

      state.mensagensPendentes.push({ texto: textIn || (temMidia ? '[mídia]' : ''), temMidia });
      if (textIn && !state.mensagensDesdeSolicitacao.includes(textIn)) {
        state.mensagensDesdeSolicitacao.push(textIn);
      }
      state.ultimaMensagem = Date.now();

      if (state.enviandoMensagens) {
        console.log(`[${phone}] (Manychat) Mensagem acumulada, aguardando processamento`);
        return;
      }

      // mantém seu pacing atual
      const delayAleatorio = 10000 + Math.random() * 5000;
      console.log(`[${phone}] (Manychat) Aguardando ${Math.round(delayAleatorio / 1000)}s antes de processar`);
      await delay(delayAleatorio);

      await processarMensagensPendentes(phone);
    } catch (e) {
      console.error('[ManyChat webhook bg] erro:', e);
    }
  })();
});

}

module.exports = { checkAuth, setupRoutes };
