const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const { initDatabase } = require('./db.js');
const { delay, gerarResposta, quebradizarTexto, enviarLinhaPorLinha, inicializarEstado, criarUsuarioDjango, processarMensagensPendentes, sendMessage, gerarSenhaAleatoria, gerarBlocoInstrucoes } = require('./bot.js');
const { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia, mensagemImpulso, mensagensIntrodutorias, checklistVariacoes, mensagensPosChecklist, respostasNaoConfirmadoAcesso, respostasNaoConfirmadoConfirmacao, respostasDuvidasComuns } = require('./prompts.js');
const { checkAuth, setupRoutes } = require('./routes.js');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: '8065537Ncfp@',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

const server = http.createServer(app);
const io = socketIo(server);

setupRoutes(app, path, processarMensagensPendentes, inicializarEstado, criarUsuarioDjango, require('./db.js').salvarContato, require('./prompts.js').VERIFY_TOKEN); // Ajuste com os imports corretos

io.on('connection', (socket) => {
  console.log('Usuário conectado ao dashboard');
  socket.on('disconnect', () => {
    console.log('Usuário desconectado');
  });
});

initDatabase().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`[✅ Servidor rodando na porta ${PORT}]`);
  });
}).catch(err => console.error('Erro ao init DB:', err));
