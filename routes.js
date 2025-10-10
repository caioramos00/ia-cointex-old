const express = require('express');
const axios = require('axios');

const { pool } = require('./db.js');
const { delay } = require('./bot.js');
const { getBotSettings, updateBotSettings, getContatoByPhone } = require('./db.js');
const { setEtapa } = require('./stateManager.js');
const { ensureEstado } = require('./stateManager.js');
const { handleIncomingNormalizedMessage } = require('./bot.js');  // Adicione isso

const LANDING_URL = 'https://grupo-whatsapp-trampos-lara-2025.onrender.com';

const sentContactByWa = new Set();
const sentContactByClid = new Set();

function checkAuth(req, res, next) {
  if (req.session.loggedIn) next();
  else res.redirect('/login');
}

function safeStr(v) { return (v === null || v === undefined) ? '' : String(v); }
function normalizeContato(raw) { return safeStr(raw).replace(/\D/g, ''); }

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

const URL_RX = /https?:\/\/\S+/gi;
function extractUrlsFromText(text = '') {
  const out = [];
  const s = String(text || '');
  let m;
  while ((m = URL_RX.exec(s)) !== null) out.push(m[0]);
  return Array.from(new Set(out));
}

function harvestUrlsFromPayload(payload = {}) {
  const urls = new Set();

  const tryPush = (v) => {
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) urls.add(v);
  };

  tryPush(payload.url);
  tryPush(payload.mediaUrl);
  tryPush(payload.image_url);
  tryPush(payload.file_url);
  tryPush(payload?.payload?.url);
  tryPush(payload?.attachment?.payload?.url);

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
  estado,
  initialTid = '',
  initialClickType = 'Orgânico'
) {
  const idContato = phone || `mc:${subscriberId}`;
  const wasNew = !estado[idContato];

  if (wasNew) {
    if (typeof inicializarEstado === 'function') {
      inicializarEstado(idContato, initialTid, initialClickType);
    } else {
      estado[idContato] = {
        contato: idContato,
        tid: initialTid || '',
        click_type: initialClickType || 'Orgânico',
        mensagensPendentes: [],
        mensagensDesdeSolicitacao: [],
      };
    }
  } else {
    const st = estado[idContato];
    if (!st.tid && initialTid) {
      st.tid = initialTid;
      st.click_type = initialClickType || 'Orgânico';
    }
  }

  return idContato;
}


function setupRoutes(
  app,
  pathModule,
  processarMensagensPendentes,
  inicializarEstado,
  salvarContato,
  VERIFY_TOKEN,
  estado
) {
  if (typeof processarMensagensPendentes !== 'function') {
    try { processarMensagensPendentes = require('./bot.js').processarMensagensPendentes; } catch { }
  }
  if (typeof inicializarEstado === 'function') {
    try { inicializarEstado = require('./bot.js').inicializarEstado; } catch { }
  }
  app.use('/public', express.static(pathModule.join(__dirname, 'public')));

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

        message_provider: (req.body.message_provider || 'meta').toLowerCase(),

        twilio_account_sid: (req.body.twilio_account_sid || '').trim(),
        twilio_auth_token: (req.body.twilio_auth_token || '').trim(),
        twilio_messaging_service_sid: (req.body.twilio_messaging_service_sid || '').trim(),
        twilio_from: (req.body.twilio_from || '').trim(),

        manychat_api_token: (req.body.manychat_api_token || '').trim(),
        manychat_fallback_flow_id: (req.body.manychat_fallback_flow_id || '').trim(),
        manychat_webhook_secret: (req.body.manychat_webhook_secret || '').trim(),

        meta_access_token: (req.body.meta_access_token || '').trim(),
        meta_phone_number_id: (req.body.meta_phone_number_id || '').trim(),
        contact_token: (req.body.contact_token || '').trim(),
      };

      await updateBotSettings(payload);
      res.redirect('/admin/settings?ok=1');
    } catch (e) {
      console.error('[AdminSettings][POST] erro:', e);
      res.status(500).send('Erro ao salvar configurações');
    }
  });

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

  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
    else res.sendStatus(403);
  });

  app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const settings = await getBotSettings();
      const phoneNumberId = settings.meta_phone_number_id;
      const contactToken = settings.contact_token;
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field !== 'messages') continue;
          const value = change.value;
          if (!value.messages || !value.messages.length) continue;
          const msg = value.messages[0];
          const contato = msg.from;
          if (contato === phoneNumberId) { res.sendStatus(200); return; }
          const isProviderMedia = msg.type !== 'text';
          const texto = msg.type === 'text' ? (msg.text.body || '').trim() : '';
          console.log(`[${contato}] ${texto || '[mídia]'}`);
          let tid = '';
          let click_type = 'Orgânico';
          let is_ctwa = false;
          const referral = msg.referral || {};
          if (referral.source_type === 'ad') {
            tid = referral.ctwa_clid || '';
            click_type = 'CTWA';
            is_ctwa = true;
          }
          const wa_id = (value?.contacts && value.contacts[0]?.wa_id) || msg.from || '';
          const profile_name = (value?.contacts && value.contacts[0]?.profile?.name) || '';
          const clid = is_ctwa ? referral.ctwa_clid || '' : '';
          const shouldSendContact =
            (is_ctwa && clid && !sentContactByClid.has(clid)) ||
            (!is_ctwa && !sentContactByWa.has(wa_id) && !(estado[contato]?.capiContactSent));
          if (shouldSendContact) {
            const contactPayload = {
              wa_id, tid, ctwa_clid: clid,
              event_time: Number(msg.timestamp) || undefined,
              wamid: msg.id || '',
              profile_name,
              phone_number_id: value?.metadata?.phone_number_id || '',
              display_phone_number: value?.metadata?.display_phone_number || '',
            };
            try {
              const resp = await axios.post(`${LANDING_URL}/api/capi/contact`, contactPayload, {
                headers: { 'Content-Type': 'application/json', 'X-Contact-Token': contactToken },
                validateStatus: () => true,
              });
              if (is_ctwa && clid) sentContactByClid.add(clid);
              else sentContactByWa.add(wa_id);
              if (estado[contato]) estado[contato].capiContactSent = true;
            } catch { }
          }
          if (!estado[contato]) {
            inicializarEstado(contato, tid, click_type);
            await salvarContato(contato, null, texto || (isProviderMedia ? '[mídia]' : ''), tid, click_type);
          } else {
            await salvarContato(contato, null, texto || (isProviderMedia ? '[mídia]' : ''), tid, click_type);
          }
          await handleIncomingNormalizedMessage({ // Adicione isso
            contato,
            texto,
            temMidia: isProviderMedia,
            ts: Number(msg.timestamp) || Date.now()
          });
          const st = estado[contato];
          const urlsFromText = extractUrlsFromText(texto);
          st.ultimaMensagem = Date.now();
          const delayAleatorio = 10000 + Math.random() * 5000;
          await delay(delayAleatorio);
          await processarMensagensPendentes(contato);
        }
      }
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  });

  const processingDebounce = new Map();

  app.post('/webhook/manychat', express.json(), async (req, res) => {
    const settings = await getBotSettings().catch(() => ({}));
    const secretConfigured = process.env.MANYCHAT_WEBHOOK_SECRET || settings.manychat_webhook_secret || '';
    const headerSecret = req.get('X-MC-Secret') || '';
    if (secretConfigured && headerSecret !== secretConfigured) {
      return res.sendStatus(401);
    }

    const payload = req.body || {};
    const subscriberId = payload.subscriber_id || payload?.contact?.id || null;
    const textInRaw = payload.text || payload.last_text_input || '';
    const textIn = typeof textInRaw === 'string' ? textInRaw.trim() : '';

    const full = payload.full_contact || {};
    let rawPhone = '';
    const phoneCandidates = [
      payload?.user?.phone,
      payload?.contact?.phone,
      payload?.contact?.wa_id,
      (full?.whatsapp && full.whatsapp.id),
      full?.phone,
      payload?.phone,
    ].filter(Boolean);
    rawPhone = phoneCandidates[0] || '';
    const phone = onlyDigits(rawPhone);

    const declaredType =
      payload.last_reply_type ||
      payload.last_input_type ||
      payload?.message?.type ||
      payload?.last_message?.type ||
      '';

    if (!phone) return res.status(200).json({ ok: true, ignored: 'no-phone' });

    console.log(`[${phone}] Mensagem recebida: ${textIn || '[mídia]'}`);

    if (subscriberId && phone) {
      try {
        await pool.query(
          'UPDATE contatos SET manychat_subscriber_id = $2 WHERE id = $1',
          [phone, subscriberId]
        );
        const st = ensureEstado(phone);
        st.manychat_subscriber_id = String(subscriberId);
      } catch (e) {
        console.warn(`[${phone}] Falha ao vincular subscriber_id: ${e.message}`);
      }
    }

    let finalTid = '';
    let finalClickType = 'Orgânico';
    try {
      const existing = await getContatoByPhone(phone);
      if (existing) {
        if (existing.tid) finalTid = existing.tid;
        if (existing.click_type && existing.click_type !== 'Orgânico') finalClickType = existing.click_type;
        else finalClickType = finalTid ? 'Landing' : 'Orgânico';
      }
    } catch { }

    let idContato = '';
    try {
      idContato = await bootstrapFromManychat(
        phone,
        subscriberId,
        inicializarEstado,
        estado,
        finalTid,
        finalClickType
      );
    } catch { }
    if (!idContato) {
      idContato = phone;
      if (idContato && !estado[idContato]) {
        if (typeof inicializarEstado === 'function') inicializarEstado(idContato, finalTid, finalClickType);
        else estado[idContato] = { contato: idContato, tid: finalTid || '', click_type: finalClickType || 'Orgânico', mensagensPendentes: [], mensagensDesdeSolicitacao: [] };
      }
    }

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
    } catch { }

    const urlsFromText = extractUrlsFromText(textoRecebido);
    const urlsFromPayload = harvestUrlsFromPayload(payload);
    const allUrls = Array.from(new Set([...urlsFromText, ...urlsFromPayload]));

    if (!estado[idContato]) {
      inicializarEstado(idContato, finalTid, finalClickType);
    }
    await handleIncomingNormalizedMessage({ // Adicione isso
      contato: idContato,
      texto: textoRecebido,
      temMidia: declaredType !== 'text',  // Ajuste baseado no declaredType
      ts: Date.now()
    });
    const stNow = estado[idContato];
    stNow.ultimaMensagem = Date.now();

    if (processingDebounce.has(idContato)) { clearTimeout(processingDebounce.get(idContato)); }
    const timer = setTimeout(async () => {
      try { await processarMensagensPendentes(idContato); } catch { } finally { processingDebounce.delete(idContato); }
    }, 5000);
    processingDebounce.set(idContato, timer);

    return res.status(200).json({ ok: true });
  });

  app.post('/webhook/confirm-image-sent', express.json(), async (req, res) => {
    // Log detalhado do body recebido (EXATAMENTE como vem do ManyChat)
    console.log(`[ConfirmImage] Received full request: Method=${req.method}, Headers=${JSON.stringify(req.headers, null, 2)}, Body=${JSON.stringify(req.body, null, 2)}`);

    res.status(200).json({ ok: true });  // Responda logo

    const { contact, status, image_url } = req.body;  // Ou 'contato' se for mismatch
    const normalized = normalizeContato(contact);  // Ajuste para 'contato' se necessário

    if (!normalized || normalized.length < 10 || (image_url && image_url.includes('{{'))) {
      console.error(`[ConfirmImage] Invalid body (unresolved variables?): ${JSON.stringify(req.body, null, 2)}`);
      return;
    }

    if (status === 'sent') {
      console.log(`[${normalized}] Imagem confirmada: ${image_url}`);
      await processarMensagensPendentes(normalized);
    }
  });

  app.post('/admin/set-etapa', checkAuth, express.json(), express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const contato = (req.body.contato || req.query.contato || '').replace(/\D/g, '');
      const etapa = (req.body.etapa || req.query.etapa || '').trim();

      if (!contato) return res.status(400).json({ ok: false, error: 'contato obrigatório' });
      if (!etapa) return res.status(400).json({ ok: false, error: 'etapa obrigatória' });

      const opts = {
        autoCreateUser: req.body.autoCreateUser === '1' || req.query.autoCreateUser === '1',
        clearCredenciais: req.body.clearCredenciais === '1' || req.query.clearCredenciais === '1',
      };

      if (req.body.seedEmail || req.body.seedPassword || req.body.seedLoginUrl) {
        opts.seedCredenciais = {
          email: req.body.seedEmail || '',
          password: req.body.seedPassword || '',
          login_url: req.body.seedLoginUrl || '',
        };
      }

      const out = await setEtapa(contato, etapa, opts);

      try {
        await pool.query('UPDATE contatos SET etapa_atual = $2 WHERE id = $1', [contato, etapa]);
      } catch (e) {
        console.warn(`[SetEtapa] falha ao atualizar DB: ${e.message}`);
      }

      const runNow = req.body.run === '1' || req.query.run === '1';
      if (runNow && typeof processarMensagensPendentes === 'function') {
        await processarMensagensPendentes(contato);
      }

      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });
  app.post('/admin/test-image', checkAuth, express.json(), async (req, res) => {
    try {
      const { phone, url, caption } = req.body || {};
      const id = onlyDigits(phone);
      if (!id || !url) return res.status(400).json({ ok: false, error: 'Informe phone e url' });

      if (!estado[id]) inicializarEstado(id, '', 'Orgânico');

      const { sendImage } = require('./bot.js');
      const r = await sendImage(id, url, caption, { alsoSendAsFile: req.body.asFile === '1' });
      return res.json({ ok: true, result: r });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post('/admin/test-text', checkAuth, express.json(), async (req, res) => {
    try {
      const { phone, text } = req.body || {};
      const id = (phone || '').replace(/\D/g, '');
      if (!id || !text) return res.status(400).json({ ok: false, error: 'Informe phone e text' });
      const { sendMessage } = require('./bot.js');
      const r = await sendMessage(id, text);
      return res.json({ ok: true, result: r });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { checkAuth, setupRoutes };