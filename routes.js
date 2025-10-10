const express = require('express');
const axios = require('axios');

const { pool } = require('./db.js');
const { delay } = require('./bot.js');
const { getBotSettings, updateBotSettings, getContatoByPhone } = require('./db.js');
const { setEtapa } = require('./stateManager.js');
const { ensureEstado } = require('./stateManager.js');

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

  app.get('/dashboard', checkAuth, async (req, res) => {
    try {
      const { rows: contatos } = await pool.query('SELECT * FROM contatos ORDER BY ultima_interacao DESC');
      const { rows: settings } = await pool.query('SELECT * FROM bot_settings WHERE id = 1 LIMIT 1');
      res.render('dashboard', { contatos, settings: settings[0] || {} });
    } catch (error) {
      console.error('Erro ao carregar dashboard:', error.message);
      res.status(500).send('Erro interno');
    }
  });

  app.post('/settings', checkAuth, async (req, res) => {
    const settings = req.body;
    try {
      await updateBotSettings(settings);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/webhook/manychat', express.json(), async (req, res) => {
    const payload = req.body || {};
    res.status(200).json({ ok: true });

    const { subscriber } = payload || {};
    const subscriberId = safeStr(subscriber?.id || '').trim();
    const phone = normalizeContato(subscriber?.whatsapp_phone || subscriber?.phone || '');
    const hasPhone = phone.length >= 10;

    if (!subscriberId || !hasPhone) {
      console.warn(`[ManyChat] Invalid: id=${subscriberId} phone=${phone}`);
      return;
    }

    if (payload?.event === 'subscriber_created') {
      await setManychatSubscriberId(phone, subscriberId);
      return;
    }

    const textoRecebido = safeStr(subscriber?.last_input_text || '').trim();
    const hasText = !!textoRecebido;

    if (subscriber?.last_input_type === 'whatsapp_media') {
      const mediaUrl = safeStr(subscriber?.last_input_whatsapp_media_url || '').trim();
      if (mediaUrl) {
        console.log(`[ManyChat] Mídia: ${mediaUrl}`);
      } else {
        console.warn(`[ManyChat] Mídia sem URL: ${JSON.stringify(subscriber, null, 2)}`);
      }
      return;
    }

    if (!hasText) {
      console.warn(`[ManyChat] Sem texto: ${JSON.stringify(payload, null, 2)}`);
      return;
    }

    const idContato = await bootstrapFromManychat(phone, subscriberId, inicializarEstado, estado);
    await handleIncomingNormalizedMessage(idContato, textoRecebido);

    if (typeof processarMensagensPendentes === 'function') {
      await processarMensagensPendentes(idContato);
    }
  });

  app.get('/webhook/meta', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
      res.send(req.query['hub.challenge']);
    } else {
      res.sendStatus(403);
    }
  });

  app.post('/webhook/meta', express.json(), async (req, res) => {
    res.status(200).json({ ok: true });

    const body = req.body;
    if (!body || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        if (change.value?.messages && Array.isArray(change.value.messages)) {
          for (const message of change.value.messages) {
            const from = normalizeContato(message.from);
            if (!from || from.length < 10) continue;

            const text = safeStr(message?.text?.body || '').trim();
            const hasText = !!text;

            let hasMedia = false;
            let mediaUrl = '';
            if (message.type === 'image' && message.image?.id) {
              hasMedia = true;
              mediaUrl = await getMediaUrl(message.image.id);
            }

            if (!hasText && !hasMedia) continue;

            const idContato = from;
            if (!estado[idContato]) inicializarEstado(idContato, '', 'Orgânico');

            await handleIncomingNormalizedMessage(idContato, text, hasMedia);

            if (typeof processarMensagensPendentes === 'function') {
              await processarMensagensPendentes(idContato);
            }
          }
        }
      }
    }
  });

  app.post('/webhook/confirm-image-sent', express.json(), async (req, res) => {
    console.log(`[ConfirmImage] Received full request: Method=${req.method}, Headers=${JSON.stringify(req.headers, null, 2)}, Body=${JSON.stringify(req.body, null, 2)}`);

    res.status(200).json({ ok: true });

    const { contact, status, image_url } = req.body;
    const normalized = normalizeContato(contact);

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