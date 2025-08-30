const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const { inicializarEstado, processarMensagensPendentes, salvarContato } = require('./bot');
const { delay } = require('./utils');
const { sendMessage, criarUsuarioDjango } = require('./integrations');
const { estadoContatos } = require('./state');

const app = express();
app.use(bodyParser.json());

const server = http.createServer(app);
const io = socketIo(server);
global.io = io;

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;


// Adição para teste: Servir o chat.html em /chat se NODE_ENV=test
if (process.env.NODE_ENV === 'test') {
    app.use(express.static(__dirname)); // Serve arquivos estáticos, incluindo chat.html
    app.get('/chat', (req, res) => {
        res.sendFile(__dirname + '/chat.html');
    });
    console.log('[Test Mode] Chat simulador disponível em http://localhost:3000/chat');
}

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
              criarUsuarioDjango(contato);
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

io.on('connection', (socket) => {
  console.log('Usuário conectado ao dashboard');
  socket.on('disconnect', () => {
    console.log('Usuário desconectado');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[✅ Servidor rodando na porta ${PORT}]`);
});