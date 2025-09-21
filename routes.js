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
    if (req.session.loggedIn) {
        next();
    } else {
        res.redirect('/login');
    }
}

function norm(s = '') {
    return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

// Palavras/frases de OPT-OUT (as que você definiu)
const OPTOUT_TOKENS = new Set([
    'sair', 'parar', 'cancelar', 'remover', 'nao quero'
]);

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

function setupRoutes(app, path, processarMensagensPendentes, inicializarEstado, criarUsuarioDjango, salvarContato, VERIFY_TOKEN, estadoContatos) {
    app.use('/public', express.static(path.join(__dirname, 'public')));

    app.get('/login', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'login.html'));
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
        res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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
      manychat_webhook_secret: (req.body.manychat_webhook_secret || '').trim(),
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
            const activeRes = await client.query('SELECT COUNT(*) FROM contatos WHERE status = \'ativo\' AND ultima_interacao > NOW() - INTERVAL \'10 minutes\'');
            const totalContatosRes = await client.query('SELECT COUNT(*) FROM contatos');
            const messagesReceivedRes = await client.query('SELECT SUM(jsonb_array_length(historico)) AS total FROM contatos');
            const messagesSentRes = await client.query('SELECT SUM(jsonb_array_length(historico_interacoes)) AS total FROM contatos');
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
            const interacoesRes = await client.query('SELECT historico_interacoes FROM contatos WHERE id = $1', [req.params.id]);

            const historico = historicoRes.rows[0]?.historico || [];
            const interacoes = interacoesRes.rows[0]?.historico_interacoes || [];

            const allMessages = [...historico.map(msg => ({ ...msg, role: 'received' })), ...interacoes.map(msg => ({ ...msg, role: 'sent' }))];
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

                                // 1) Checa re-opt-in primeiro: se contato está bloqueado e disse "BORA"
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
                                        // Confirma rápido (sem delays)
                                        await sendMessage(contato, 'fechou, voltamos então. bora.');
                                        // continua o fluxo normal desta mensagem
                                    } else {
                                        // ainda bloqueado — peça confirmação curta
                                        await sendMessage(contato, 'vc tinha parado as msgs. se quiser retomar, manda "BORA".');
                                        return res.sendStatus(200);
                                    }
                                }

                                // 2) Checa opt-out
                                const isToken = OPTOUT_TOKENS.has(n);
                                const isPhrase = OPTOUT_PHRASES.some(p => n.includes(p));
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
                                    // Confirmação no seu tom (sem pacing)
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

                            // Novo: Detecta CTWA e extrai ctwa_clid como TID
                            const referral = msg.referral || {};
                            if (referral.source_type === 'ad') {
                                tid = referral.ctwa_clid || '';
                                click_type = 'CTWA';
                                is_ctwa = true;
                                console.log(`[Webhook] CTWA detectado para ${contato}: ctwa_clid=${tid}`);
                            }

                            // Novo: Se não CTWA e é texto, parseia TID para landing (só na primeira mensagem)
                            if (!is_ctwa && msg.type === 'text') {
                                const tidMatch = texto.match(/\[TID:\s*([\w]+)\]/i);
                                if (tidMatch && tidMatch[1]) {
                                    tid = tidMatch[1];
                                    click_type = 'Landing';
                                    console.log(`[Webhook] Landing detectada para ${contato}: TID=${tid}`);
                                }
                            }

                            // Novo: Forward payload se CTWA
                            if (is_ctwa) {
                                try {
                                    const forward_url = `${LANDING_URL}/ctwa/intake`;
                                    await axios.post(forward_url, body);
                                    console.log(`[Webhook] Forwarded CTWA data para landing: ${forward_url}`);
                                } catch (error) {
                                    console.error(`[Webhook] Failed to forward CTWA data para landing: ${error.message}`);
                                }
                            }

                            // ===== Envio de CONTACT: 1x por identidade =====
                            const wa_id = (value?.contacts && value.contacts[0]?.wa_id) || msg.from || '';
                            const profile_name = (value?.contacts && value.contacts[0]?.profile?.name) || '';
                            const clid = is_ctwa ? (referral.ctwa_clid || '') : '';

                            // Envia 1x por CTWA (clid) OU, se não CTWA, 1x por wa_id
                            const shouldSendContact =
                                (is_ctwa && clid && !sentContactByClid.has(clid)) ||
                                (!is_ctwa && !sentContactByWa.has(wa_id) && !(estadoContatos[contato]?.capiContactSent));

                            if (shouldSendContact) {
                                const contactPayload = {
                                    wa_id,
                                    tid,
                                    ctwa_clid: clid,
                                    event_time: Number(msg.timestamp) || undefined, // server usa em event_time
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
                                    if (estadoContatos[contato]) estadoContatos[contato].capiContactSent = true;
                                    console.log(`[Webhook] Contact -> distribuidor status=${resp.status} deduped=${resp.data?.deduped ? 'yes' : 'no'} event_id=${resp.data?.event_id || ''}`);
                                } catch (err) {
                                    console.error('[Webhook] Falha ao enviar Contact ao distribuidor:', err.message);
                                }
                            } else {
                                console.log(`[Webhook] Contact suprimido (dedupe): wa_id=${wa_id} ctwa_clid=${clid || '-'}`);
                            }

                            if (!estadoContatos[contato]) {
                                inicializarEstado(contato, tid, click_type);  // Atualizado: Passa tid e click_type
                                await criarUsuarioDjango(contato);
                                await salvarContato(contato, null, texto, tid, click_type);  // Atualizado: Passa tid e click_type
                                console.log(`[${contato}] Etapa 1: abertura`);
                            } else {
                                await salvarContato(contato, null, texto, tid, click_type);  // Atualizado: Passa tid e click_type (atualiza se necessário)
                            }
                            const estado = estadoContatos[contato];
                            estado.mensagensPendentes.push({ texto, temMidia });
                            if (!estado.mensagensDesdeSolicitacao.includes(texto)) {
                                estado.mensagensDesdeSolicitacao.push(texto);
                            }
                            estado.ultimaMensagem = Date.now();

                            if (estado.enviandoMensagens) {
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
    // --- TWILIO WEBHOOK (ENTRADA) ---
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
    const temMidia = false; // ajuste depois se tratar mídia por Twilio

    // >>> Reaproveita o MESMO pipeline do /webhook da Meta (igual ao que você faz lá)
    if (!estadoContatos[from]) {
      inicializarEstado(from, '', 'Twilio');
      await criarUsuarioDjango(from);
      await salvarContato(from, null, text, '', 'Twilio');
    } else {
      await salvarContato(from, null, text, '', 'Twilio');
    }
    const estado = estadoContatos[from];
    estado.mensagensPendentes.push({ texto: text || '[mídia]', temMidia });
    if (!estado.mensagensDesdeSolicitacao.includes(text)) {
      estado.mensagensDesdeSolicitacao.push(text);
    }
    estado.ultimaMensagem = Date.now();

    if (estado.enviandoMensagens) {
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

// --- MANYCHAT WEBHOOK (ENTRADA via External Request) ---
app.post('/webhook/manychat', express.json(), async (req, res) => {
  try {
    const s = await getBotSettings().catch(() => ({}));
    const secret = process.env.MANYCHAT_WEBHOOK_SECRET || s.manychat_webhook_secret;
    if (secret && req.get('X-MC-Secret') !== secret) return res.sendStatus(403);

    const payload = req.body || {};
    const subscriberId = payload.subscriber_id || payload.user?.id;
    const phone = (payload.user?.phone || payload.phone || '').replace(/^whatsapp:/, '');
    const text = (payload.text || payload.message || '').trim();
    const temMidia = false;

    if (!subscriberId) return res.status(400).json({ error: 'subscriber_id ausente' });

    // Garante que existe contato e vincula subscriber_id (se tiver telefone)
    if (phone) {
      await salvarContato(phone, null, text || '[mídia]', '', 'Manychat');
      await pool.query(
        'UPDATE contatos SET manychat_subscriber_id = $2 WHERE id = $1',
        [phone, subscriberId]
      );
      if (!estadoContatos[phone]) {
        inicializarEstado(phone, '', 'Manychat');
        await criarUsuarioDjango(phone);
      }
      const estado = estadoContatos[phone];
      estado.mensagensPendentes.push({ texto: text || '[mídia]', temMidia });
      if (text && !estado.mensagensDesdeSolicitacao.includes(text)) {
        estado.mensagensDesdeSolicitacao.push(text);
      }
      estado.ultimaMensagem = Date.now();

      if (estado.enviandoMensagens) {
        console.log(`[${phone}] (Manychat) Mensagem acumulada, aguardando processamento`);
      } else {
        const delayAleatorio = 10000 + Math.random() * 5000;
        console.log(`[${phone}] (Manychat) Aguardando ${Math.round(delayAleatorio / 1000)}s antes de processar`);
        await delay(delayAleatorio);
        await processarMensagensPendentes(phone);
      }
    } else {
      // Sem phone: só persiste o vínculo p/ futuras saídas via ManychatTransport (envio por subscriber_id)
      console.warn('[ManychatWebhook] Sem phone no payload; armazene mapping em outra tabela se quiser.');
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[ManychatWebhook] Erro:', e.message);
    res.sendStatus(500);
  }
});

}

module.exports = { checkAuth, setupRoutes };
