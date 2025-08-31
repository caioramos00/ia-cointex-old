const path = require('path');
const express = require('express');
const { pool } = require('./db.js');
const { delay } = require('./bot.js');

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const estadoContatos = require('./state.js');

function checkAuth(req, res, next) {
  if (req.session.loggedIn) {
    next();
  } else {
    res.redirect('/login');
  }
}

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

              if (!estadoContatos[contato]) {
                inicializarEstado(contato);
                await criarUsuarioDjango(contato);
                await salvarContato(contato, null, texto);
                console.log(`[${contato}] Etapa 1: abertura`);
              } else {
                await salvarContato(contato, null, texto);
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
}

module.exports = { checkAuth, setupRoutes };
