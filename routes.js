const express = require('express');
const axios = require('axios');

const { truncate, findTidInText, safeStr } = require('./utils.js');
const { delay, handleIncomingNormalizedMessage } = require('./bot.js');
const { setEtapa, ensureEstado } = require('./stateManager.js');
const { sseRouter } = require('./stream/sse-router');
const estadoContatos = require('./state.js');
const {
  pool,
  getBotSettings,
  updateBotSettings,
  getContatoByPhone,
  listMetaNumbers,
  createMetaNumber,
  updateMetaNumber,
  deleteMetaNumber,
  deleteContatosByIds,
} = require('./db.js');


const LANDING_URL = 'https://tramposlara.com';
const SERVER_GTM_CONTACT_URL = 'https://ss.tramposlara.com/bot-contact';
const BOT_CONTACT_SECRET = 'SENHASECRETA'

async function sendContactEventToServerGtm({ wa_id, phone, tid, click_type, is_ctwa, event_time }) {
  if (!SERVER_GTM_CONTACT_URL) {
    console.warn('[CAPI][BOT][SKIP] SERVER_GTM_CONTACT_URL não configurada');
    return;
  }
  if (!wa_id) return;

  // garante um click_type consistente com as regras
  const resolvedClickType = click_type || (is_ctwa ? 'CTWA' : 'Orgânico');

  const payload = {
    event_name: 'contact_bot',
    event_time: event_time || Math.floor(Date.now() / 1000),
    wa_id,
    phone: phone || wa_id,
    tid: tid || '',
    click_type: resolvedClickType,
    action_source: is_ctwa ? 'CTWA' : resolvedClickType,
    is_ctwa: !!is_ctwa,
    source: 'chat',
  };

  console.log(
    `[CAPI][BOT][TX] url=${SERVER_GTM_CONTACT_URL} payload=${truncate(
      JSON.stringify(payload),
      500
    )}`
  );

  try {
    const resp = await axios.post(
      SERVER_GTM_CONTACT_URL,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-bot-secret': BOT_CONTACT_SECRET,
        },
        timeout: 10000,
        validateStatus: () => true,
      }
    );
    console.log(
      `[CAPI][BOT][RX] http=${resp.status} body=${truncate(
        JSON.stringify(resp.data || {}),
        800
      )}`
    );
  } catch (e) {
    console.warn(`[CAPI][BOT][ERR] ${e?.message || e}`);
  }
}

// idempotência local por execução
const sentContactByWa = new Set();
const sentIntakeByClid = new Set();

function checkAuth(req, res, next) {
  if (req.session.loggedIn) next();
  else res.redirect('/login');
}

function normalizeContato(raw) {
  return safeStr(raw).replace(/\D/g, '');
}

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

  const attachments = payload.attachments
    || payload?.message?.attachments
    || payload?.last_message?.attachments
    || payload?.payload?.attachments
    || [];

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
  if (typeof inicializarEstado !== 'function') {
    try { inicializarEstado = require('./bot.js').inicializarEstado; } catch { }
  }

  app.use('/public', express.static(pathModule.join(__dirname, 'public')));

  app.use(sseRouter);

  app.get('/', (req, res) =>
    res.sendFile(pathModule.join(__dirname, 'public', 'login.html'))
  );

  app.get('/login', (req, res) =>
    res.sendFile(pathModule.join(__dirname, 'public', 'login.html'))
  );

  app.post('/login', (req, res) => {
    const { password } = req.body;

    if (password === '8065537Ncfp@') {
      req.session.loggedIn = true;
      res.redirect('/admin/settings');
    } else {
      res.send('Login inválido. <a href="/login">Tente novamente</a>');
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  app.get('/admin/settings', checkAuth, async (req, res) => {
    try {
      const settings = await getBotSettings({ bypassCache: true });
      const metaNumbers = await listMetaNumbers().catch(() => []);
      res.render('settings.ejs', {
        settings,
        metaNumbers,
        ok: req.query.ok === '1',
      });
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

  app.post(
    '/admin/settings/meta/save',
    checkAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = (req.body.id || '').trim();
      const payload = {
        phone_number_id: (req.body.phone_number_id || '').trim(),
        display_phone_number: (req.body.display_phone_number || '').trim(),
        access_token: (req.body.access_token || '').trim(),
        active: req.body.active === 'on',
      };

      try {
        if (!payload.phone_number_id || !payload.access_token) {
          throw new Error('phone_number_id e access_token são obrigatórios');
        }

        if (id) {
          await updateMetaNumber(Number(id), payload);
        } else {
          await createMetaNumber(payload);
        }

        res.redirect('/admin/settings?ok=1');
      } catch (e) {
        console.error('[AdminSettings][MetaSave] erro:', e);
        res.status(500).send('Erro ao salvar número Meta');
      }
    }
  );

  app.post(
    '/admin/settings/meta/delete',
    checkAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number((req.body.id || '').trim() || 0);
      try {
        if (id) {
          await deleteMetaNumber(id);
        }
        res.redirect('/admin/settings?ok=1');
      } catch (e) {
        console.error('[AdminSettings][MetaDelete] erro:', e);
        res.status(500).send('Erro ao remover número Meta');
      }
    }
  );

  app.post(
    '/admin/settings/reset-state',
    checkAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      try {
        Object.keys(estadoContatos).forEach((k) => {
          delete estadoContatos[k];
        });

        console.log('[AdminSettings][RESET_STATE] Estado de memória do bot resetado manualmente.');

        res.redirect('/admin/settings?ok=1');
      } catch (e) {
        console.error('[AdminSettings][RESET_STATE] erro:', e);
        res.status(500).send('Erro ao resetar memória do bot');
      }
    }
  );

  app.post(
    '/admin/settings/wipe-contacts',
    checkAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      try {
        const raw = safeStr(req.body.numeros || req.body.numbers || '');
        // aceita números separados por espaço, vírgula, ponto e vírgula ou quebra de linha
        const parts = raw
          .split(/[\s,;]+/)
          .map((s) => normalizeContato(s))
          .filter(Boolean);

        const unique = [...new Set(parts)];

        if (!unique.length) {
          // nada pra apagar
          return res.redirect('/admin/settings?ok=1');
        }

        const deleted = await deleteContatosByIds(unique);

        // limpa também a memória em runtime desses contatos
        unique.forEach((id) => {
          if (estadoContatos[id]) {
            delete estadoContatos[id];
          }
        });

        console.log(
          `[AdminSettings][WipeContacts] solicitados=${unique.length}, deletados=${deleted}`
        );

        res.redirect('/admin/settings?ok=1');
      } catch (e) {
        console.error('[AdminSettings][WipeContacts] erro:', e);
        res.status(500).send('Erro ao apagar contatos');
      }
    }
  );

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
      res.json({ activeConversations: active, totalContatos, messagesReceived, messagesSent, stages });
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
      const interacoesRes = await client.query('SELECT historico_interacoes FROM contatos WHERE id = $1', [req.params.id]);

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

  // Webhook de verificação (Meta)
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
    else res.sendStatus(403);
  });

  // auxiliares de gate
  const postedIntakeByClid = sentIntakeByClid; // reaproveita o Set existente (após POST OK)
  const confirmedIntakeByClid = new Set();     // confirmado via /ctwa/get
  const inflightIntakeByClid = new Map();      // promessa em voo por clid

  async function ensureCtwaIntakeConfirmed(clid, rawWebhookBody, contactToken) {
    if (!clid) return false;
    if (confirmedIntakeByClid.has(clid)) return true;

    if (inflightIntakeByClid.has(clid)) {
      try { return await inflightIntakeByClid.get(clid); }
      catch { return false; }
    }

    const run = (async () => {
      try {
        if (!postedIntakeByClid.has(clid)) {
          const r = await axios.post(
            `${LANDING_URL}/ctwa/intake`,
            rawWebhookBody,
            {
              headers: { 'Content-Type': 'application/json', 'X-Contact-Token': contactToken },
              validateStatus: () => true,
              timeout: 10000,
            }
          );
          if (r.status >= 200 && r.status < 300 && r?.data?.ok !== false) {
            postedIntakeByClid.add(clid);
          } else {
            console.warn(`[CTWA][INTAKE][FAIL] http=${r.status}`);
            return false;
          }
        }

        // poll curto até confirmar persistência no projeto da LP
        const tries = [80, 140, 200, 260, 340, 420, 520, 650, 800, 950]; // ~4s máx
        for (let i = 0; i < tries.length; i++) {
          try {
            const g = await axios.get(`${LANDING_URL}/ctwa/get`, {
              params: { ctwa_clid: clid },
              validateStatus: () => true,
              timeout: 2500,
            });
            if (g.status === 200 && g.data && g.data.ok) {
              confirmedIntakeByClid.add(clid);
              return true;
            }
          } catch { }
          await delay(tries[i]);
        }
        console.warn(`[CTWA][GATE][TIMEOUT] clid=${clid} não confirmado a tempo`);
        return false;
      } finally {
        inflightIntakeByClid.delete(clid);
      }
    })();

    inflightIntakeByClid.set(clid, run);
    return run;
  }

  // ===== WHATSAPP WEBHOOK (ACK RÁPIDO + FALLBACK DE DB) =====
  app.post('/webhook', async (req, res) => {
    const body = req.body;

    // LOG: payload completo de recebimento (Meta Webhook)
    try {
      const e = ((body || {}).entry || [])[0] || {};
      const c = ((e.changes || [])[0]) || {};
      const v = c.value || {};
      const md = v.metadata || {};

      // O waba_id vem de entry.id; phone_number_id/display_phone_number vêm de metadata
      const rxInfo = {
        waba_id: e.id || '',
        phone_number_id: md.phone_number_id || '',
        display_phone_number: md.display_phone_number || '',
      };

      // Loga o payload inteiro recebido + IDs principais
      console.log(
        `[META][RX] waba_id=${rxInfo.waba_id || '-'} ` +
        `phone_number_id=${rxInfo.phone_number_id || '-'} ` +
        `display=${rxInfo.display_phone_number || '-'} ` +
        `payload=${JSON.stringify(body)}`
      );
    } catch (err) {
      console.warn('[META][RX][LOG][ERR]', err?.message || err);
    }

    // ACK automático em até 2.5s para cortar retries do Meta
    const ackTimer = setTimeout(() => {
      if (!res.headersSent) res.sendStatus(200);
    }, 2500);

    try {
      if (body.object === 'whatsapp_business_account') {
        // Fallback defensivo se o DB estiver reiniciando
        const settings = await getBotSettings().catch(() => ({}));
        const phoneNumberId = settings?.meta_phone_number_id || '';
        const contactToken = settings?.contact_token || '';

        for (const entry of (body.entry || [])) {
          for (const change of (entry.changes || [])) {
            if (change.field !== 'messages') continue;

            const value = change.value || {};
            const metadata = value.metadata || {};
            const rxPhoneNumberId = metadata.phone_number_id || rxInfo.phone_number_id || '';
            const rxDisplayPhone = metadata.display_phone_number || rxInfo.display_phone_number || '';

            if (!value.messages || !value.messages.length) continue;

            const msg = value.messages[0];
            const contato = msg.from;

            if (contato === phoneNumberId) {
              if (!res.headersSent) res.sendStatus(200);
              clearTimeout(ackTimer);
              return;
            }

            const isProviderMedia = msg.type !== 'text';
            const texto = msg.type === 'text' ? (msg.text.body || '').trim() : '';
            const adminTid = findTidInText(safeStr(texto)); // TID vindo do texto (LP)

            console.log(`[${contato}] ${texto || '[mídia]'}`);

            // ===== DEFINIÇÃO DE TID / CLICK_TYPE / CTWA =====
            const referral = msg.referral || {};
            const tidFromCtwa = (referral.source_type === 'ad') ? (referral.ctwa_clid || '') : '';
            const tidFromText = adminTid || '';

            let tid = '';
            let click_type = 'Orgânico';
            let is_ctwa = false;

            // prioridade: CTWA > Landing Page > Orgânico
            if (tidFromCtwa) {
              tid = tidFromCtwa;
              click_type = 'CTWA';          // clique em anúncio CTWA
              is_ctwa = true;
            } else if (tidFromText) {
              tid = tidFromText;
              click_type = 'Landing Page';  // TID digitado / vindo da LP
            } else {
              tid = '';
              click_type = 'Orgânico';      // nenhum TID
            }

            if (msg?.referral) {
              console.log(`[CTWA][RX] contato=${contato} is_ctwa=${is_ctwa} tid_len=${(tid || '').length}`);
              console.log(`[CTWA][RX][referral] ${truncate(JSON.stringify(msg.referral), 20000)}`);
            }

            const wa_id = (value?.contacts && value.contacts[0]?.wa_id) || msg.from || '';
            const clid = tidFromCtwa ? (referral.ctwa_clid || '') : '';

            // ===== CONTACT VIA SERVER GTM (primeira mensagem por wa_id) =====
            const isFirstContactForWa = wa_id && !sentContactByWa.has(wa_id);

            if (isFirstContactForWa) {
              const baseEventTime = Number(msg.timestamp) || Math.floor(Date.now() / 1000);

              const finalTid = tid;             // já decidido acima
              const finalClickType = click_type;

              if (is_ctwa) {
                // mantém o gate de intake antes de considerar contato "válido"
                const ok = await ensureCtwaIntakeConfirmed(clid, body, contactToken);
                if (!ok) {
                  console.warn(`[CTWA][GATE] Bloqueado envio de Contact (clid=${clid}) — intake ainda não confirmado.`);
                } else {
                  await sendContactEventToServerGtm({
                    wa_id,
                    phone: contato,
                    tid: finalTid,
                    click_type: finalClickType, // "CTWA"
                    is_ctwa: true,
                    event_time: baseEventTime,
                  });
                  sentContactByWa.add(wa_id);
                }
              } else {
                // Orgânico / Landing Page / qualquer entrada sem CTWA
                await sendContactEventToServerGtm({
                  wa_id,
                  phone: contato,
                  tid: finalTid,               // "" ou TID da LP
                  click_type: finalClickType,  // "Orgânico" ou "Landing Page"
                  is_ctwa: false,
                  event_time: baseEventTime,
                });
                sentContactByWa.add(wa_id);
              }
            }

            if (!estado[contato]) {
              inicializarEstado(contato, tid, click_type);
              await salvarContato(contato, null, texto || (isProviderMedia ? '[mídia]' : ''), tid, click_type);
            } else {
              await salvarContato(contato, null, texto || (isProviderMedia ? '[mídia]' : ''), tid, click_type);
            }

            try {
              const stMeta = ensureEstado(contato);
              if (rxPhoneNumberId) stMeta.meta_phone_number_id = rxPhoneNumberId;
              if (rxDisplayPhone) stMeta.meta_display_phone_number = rxDisplayPhone;

              if (rxPhoneNumberId) {
                // Persistimos no DB para sobreviver a restart
                pool
                  .query(
                    'UPDATE contatos SET meta_phone_number_id = $1 WHERE id = $2',
                    [rxPhoneNumberId, contato]
                  )
                  .catch((e) => {
                    console.warn(
                      '[META][RX] erro ao atualizar meta_phone_number_id no contato',
                      e?.message || e
                    );
                  });
              }
            } catch (e) {
              console.warn(
                '[META][RX] erro ao propagar meta_phone_number_id para o estado',
                e?.message || e
              );
            }

            await handleIncomingNormalizedMessage({
              contato,
              texto,
              temMidia: isProviderMedia,
              ts: Number(msg.timestamp) || Date.now()
            });

            const st = estado[contato];
            const urlsFromText = extractUrlsFromText(texto);
            void urlsFromText;
            st.ultimaMensagem = Date.now();

            const delayAleatorio = 10000 + Math.random() * 5000;
            await delay(delayAleatorio);
            await processarMensagensPendentes(contato);
          }
        }
        if (!res.headersSent) res.sendStatus(200);
      } else {
        if (!res.headersSent) res.sendStatus(404);
      }
    } catch (err) {
      console.error('[WEBHOOK][ERR]', err?.message || err);
      // mesmo com erro, envia 200 para evitar retry storm
      if (!res.headersSent) res.sendStatus(200);
    } finally {
      clearTimeout(ackTimer);
    }
  });

  const processingDebounce = new Map();

  // Webhook ManyChat
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

    // Disparo Contact-LP se houver TID no texto ManyChat
    const tidFromText = findTidInText(safeStr(textIn));
    if (tidFromText) {
      try {
        const contactToken = settings.contact_token || '';
        const lpPayload = {
          tid: tidFromText,
          event_time: Math.floor(Date.now() / 1000)
        };
        console.log(
          `[CAPI][TX][LP][ManyChat] url=${LANDING_URL}/api/capi/contact-lp token=${contactToken ? 'present' : 'missing'} ` +
          `payload=${truncate(JSON.stringify(lpPayload), 300)}`
        );
        const resp = await axios.post(`${LANDING_URL}/api/capi/contact-lp`, lpPayload, {
          headers: { 'Content-Type': 'application/json', 'X-Contact-Token': contactToken },
          validateStatus: () => true,
          timeout: 10000
        });
        console.log(`[CAPI][RX][LP][ManyChat] http=${resp.status} body=${truncate(JSON.stringify(resp.data), 800)}`);
      } catch (e) {
        console.warn(`[CAPI][LP][ERR][ManyChat] ${e?.message || e}`);
      }
    }

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
      payload.last_reply_type
      || payload.last_input_type
      || payload?.message?.type
      || payload?.last_message?.type
      || '';

    if (!phone) return res.status(200).json({ ok: true, ignored: 'no-phone' });

    console.log(`[${phone}] Mensagem recebida: ${textIn || '[mídia]'}`);

    if (subscriberId && phone) {
      try {
        await pool.query('UPDATE contatos SET manychat_subscriber_id = $2 WHERE id = $1', [phone, subscriberId]);
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
        phone, subscriberId, inicializarEstado, estado, finalTid, finalClickType
      );
    } catch { }

    if (!idContato) {
      idContato = phone;
      if (idContato && !estado[idContato]) {
        if (typeof inicializarEstado === 'function') {
          inicializarEstado(idContato, finalTid, finalClickType);
        } else {
          estado[idContato] = {
            contato: idContato,
            tid: finalTid || '',
            click_type: finalClickType || 'Orgânico',
            mensagensPendentes: [],
            mensagensDesdeSolicitacao: []
          };
        }
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
    void allUrls;

    if (!estado[idContato]) {
      inicializarEstado(idContato, finalTid, finalClickType);
    }

    await handleIncomingNormalizedMessage({
      contato: idContato,
      texto: textoRecebido,
      temMidia: declaredType !== 'text',
      ts: Date.now()
    });

    const stNow = estado[idContato];
    stNow.ultimaMensagem = Date.now();

    if (processingDebounce.has(idContato)) {
      clearTimeout(processingDebounce.get(idContato));
    }
    const timer = setTimeout(async () => {
      try {
        await processarMensagensPendentes(idContato);
      } catch { } finally {
        processingDebounce.delete(idContato);
      }
    }, 5000);
    processingDebounce.set(idContato, timer);

    return res.status(200).json({ ok: true });
  });

  app.post('/webhook/confirm-image-sent', express.json(), async (req, res) => {
    console.log(
      `[ConfirmImage] Received full request: Method=${req.method}, Headers=${JSON.stringify(req.headers, null, 2)}, Body=${JSON.stringify(req.body, null, 2)}`
    );
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
        console.warn('[SetEtapa] falha ao atualizar DB:', e.message);
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
