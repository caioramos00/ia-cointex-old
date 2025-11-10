const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const { initDatabase } = require('./db.js');
const { inicializarEstado, processarMensagensPendentes } = require('./bot.js');
const { setupRoutes } = require('./routes.js');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const estadoContatos = require('./state.js');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: '8065537Ncfp@',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

const server = http.createServer(app);
const io = socketIo(server);

// rotas antes de escutar a porta
setupRoutes(
  app,
  path,
  processarMensagensPendentes,
  inicializarEstado,
  require('./db.js').salvarContato,
  process.env.VERIFY_TOKEN,
  estadoContatos
);

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

// Inicializa o DB em background com retentativas e backoff exponencial
(async function bootstrapDb() {
  let attempt = 0;
  while (attempt < 8) {
    try {
      await initDatabase();
      console.log('[DB] pronto');
      return;
    } catch (e) {
      const transientCodes = ['57P01', '57P03'];
      const transient = transientCodes.includes(e?.code) ||
                        ['ECONNRESET', 'ETIMEDOUT'].includes(e?.code) ||
                        /shutting down/i.test(e?.message || '');
      const wait = Math.min(10_000, 500 * 2 ** attempt);
      console.warn(`[DB] init falhou (${e?.code || e?.message}); retry em ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
      if (!transient && attempt >= 3) {
        console.error('[DB] erro não transitório detectado; parando retentativas por agora.');
        break;
      }
    }
  }
  console.error('[DB] init não concluiu; app segue em modo degradado (sem DB).');
})();
