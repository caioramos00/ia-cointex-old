const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const axios = require('axios');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: '8065537Ncfp@',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Em prod, true para HTTPS no Render
}));

const server = http.createServer(app);
const io = socketIo(server);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DJANGO_API_URL = process.env.DJANGO_API_URL || 'https://cointex.com.br/api/create-user/';
const estadoContatos = {};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS contatos (
        id VARCHAR(255) PRIMARY KEY,
        grupos JSONB DEFAULT '[]',
        status VARCHAR(50) DEFAULT 'ativo',
        etapa VARCHAR(50) DEFAULT 'abertura',
        ultima_interacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        historico JSONB DEFAULT '[]',
        conversou VARCHAR(3) DEFAULT 'Não',
        etapa_atual VARCHAR(50) DEFAULT 'abertura',
        historico_interacoes JSONB DEFAULT '[]'
      );
    `);
    console.log('[DB] Tabela contatos criada ou já existe.');
  } catch (error) {
    console.error('[DB] Erro ao inicializar tabela:', error.message);
  } finally {
    client.release();
  }
}

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_API_VERSION = 'v20.0';
const WHATSAPP_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

async function sendMessage(to, text) {
  try {
    const response = await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    }, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`
      }
    });
    console.log(`[Envio] Mensagem enviada para ${to}: "${text}" - Status: ${response.status}`);
  } catch (error) {
    console.error(`[Erro] Falha ao enviar mensagem para ${to}: ${error.message}`);
  }
}

async function salvarContato(contatoId, grupoId = null, mensagem = null) {
  try {
    const agora = new Date().toISOString();
    const client = await pool.connect();
    try {
      const res = await client.query('SELECT * FROM contatos WHERE id = $1', [contatoId]);
      let contatoExistente = res.rows[0];

      if (!contatoExistente) {
        await client.query(`
          INSERT INTO contatos (id, grupos, status, etapa, ultima_interacao, historico, conversou, etapa_atual, historico_interacoes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          contatoId,
          grupoId ? JSON.stringify([{ id: grupoId, dataEntrada: agora }]) : '[]',
          'ativo',
          'abertura',
          agora,
          mensagem ? JSON.stringify([{ data: agora, mensagem }]) : '[]',
          'Não',
          'abertura',
          '[]'
        ]);
        console.log(`[Contato] Novo contato salvo: ${contatoId}`);
      } else {
        let grupos = contatoExistente.grupos || [];
        if (grupoId && !grupos.some(g => g.id === grupoId)) {
          grupos.push({ id: grupoId, dataEntrada: agora });
        }
        let historico = contatoExistente.historico || [];
        if (mensagem) {
          historico.push({ data: agora, mensagem });
        }
        await client.query(`
          UPDATE contatos SET
            grupos = $1,
            ultima_interacao = $2,
            status = $3,
            historico = $4
          WHERE id = $5
        `, [JSON.stringify(grupos), agora, 'ativo', JSON.stringify(historico), contatoId]);
        console.log(`[Contato] Contato atualizado: ${contatoId}`);
      }
    } finally {
      client.release();
    }
    console.log(`[DB] Contato ${contatoId} salvo`);
  } catch (error) {
    console.error(`[Erro] Falha ao salvar contato ${contatoId}: ${error.message}`);
  }
}

async function atualizarContato(contato, conversou, etapa_atual, mensagem = null, temMidia = false) {
  try {
    const client = await pool.connect();
    try {
      const res = await client.query('SELECT * FROM contatos WHERE id = $1', [contato]);
      if (res.rows.length === 0) {
        console.error(`[${contato}] Contato não encontrado no DB`);
        return;
      }
      let historicoInteracoes = res.rows[0].historico_interacoes || [];
      if (mensagem) {
        historicoInteracoes.push({
          mensagem,
          data: new Date().toISOString(),
          etapa: etapa_atual,
          tem_midia: temMidia
        });
      }
      await client.query(`
        UPDATE contatos SET
          conversou = $1,
          etapa_atual = $2,
          historico_interacoes = $3
        WHERE id = $4
      `, [conversou, etapa_atual, JSON.stringify(historicoInteracoes), contato]);
      console.log(`[${contato}] Contato atualizado: ${conversou}, ${etapa_atual}`);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`[Erro] Falha ao atualizar contato ${contato}: ${error.message}`);
  }
}

function checkAuth(req, res, next) {
  if (req.session.loggedIn) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Servir arquivos estáticos (CSS, JS)
app.use('/public', express.static(path.join(__dirname, 'public')));

// Rota para login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Rota para login POST
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'ncfp' && password === '8065537Ncfp@') {
    req.session.loggedIn = true;
    res.redirect('/dashboard');
  } else {
    res.send('Login inválido. <a href="/login">Tente novamente</a>');
  }
});

// Rota para logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Rota para dashboard
app.get('/dashboard', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API para métricas
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

// API para lista de contatos (com paginação)
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

// API para histórico de chat
app.get('/api/chat/:id', checkAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const historicoRes = await client.query('SELECT historico FROM contatos WHERE id = $1', [req.params.id]);
    const interacoesRes = await client.query('SELECT historico_interacoes FROM contatos WHERE id = $1', [req.params.id]);

    const historico = historicoRes.rows[0]?.historico || [];
    const interacoes = interacoesRes.rows[0]?.historico_interacoes || [];

    // Combinar e ordenar por data
    const allMessages = [...historico.map(msg => ({ ...msg, role: 'received' })), ...interacoes.map(msg => ({ ...msg, role: 'sent' }))];
    allMessages.sort((a, b) => new Date(a.data) - new Date(b.data));

    res.json(allMessages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

function promptClassificaAceite(contexto) {
  return `
Analise TODAS as respostas do lead após ser convidado pra fazer o trampo:
"${contexto}"

Responda com só UMA destas opções:
- "aceite" (se ele falou qualquer coisa que indique concordância ou entusiasmo, como "sim", "bora", "to on", "vambora", "vamos", "fechado", "claro", "quero sim", "bora pra cima", "beleza", "ok", "certo", etc)
- "recusa" (se ele falou algo que indique recusa, como "não", "tô fora", "não quero", "não posso", "depois", "agora não", "não rola")
- "duvida" (se ele perguntou algo ou demonstrou dúvida, como "como funciona", "é seguro", "que trampo é esse", "demora", "qual valor", etc)

Considere o contexto e variações coloquiais comuns em português brasileiro. Nunca explique nada. Só escreva uma dessas palavras.
  `;
}

function promptClassificaAcesso(contexto) {
  return `
Analise TODAS as respostas do lead após pedir para ele entrar na conta e responder com "ENTREI":
"${contexto}"

Responda com só UMA destas opções:
- "confirmado" (se ele indicou que conseguiu entrar na conta, como "ENTREI", "entrei", "tô dentro", "já tô dentro", "acessei", "já acessei", "entrei sim", "entrei agora", "entrei mano", "entrei irmão", "foi", "deu bom", "acabei de entrar", "loguei", "tô logado", "consegui entrar", "sim eu acessei", ou qualquer variação coloquial que indique sucesso no login)
- "nao_confirmado" (se ele indicou que não conseguiu entrar, como "não entrou", "deu erro", "não consegui", "não deu", "tô fora", "não posso", "não quero", "deu ruim", ou qualquer variação que indique falha no login)
- "duvida" (se ele fez uma pergunta sobre o processo, como "onde coloco o usuário?", "o link não abre", "qual senha?", "qual é o link?", "como entro?", ou qualquer dúvida relacionada ao login)
- "neutro" (se ele falou algo afirmativo ou irrelevante que não indica sucesso, falha ou dúvida, como "beleza", "tá bom", "certo", "fechou", "ok", "entendi", "vou fazer", "slk", "blza", "boa", ou qualquer resposta genérica sem relação direta com o login)

Considere o contexto e variações coloquiais comuns em português brasileiro. Nunca explique nada. Só escreva uma dessas palavras.
  `;
}

function promptClassificaConfirmacao(contexto) {
  return `
Analise TODAS as respostas do lead após pedir o valor disponível em FINANCEIRO:
"${contexto}"

Responda com só UMA destas opções:
- "confirmado" (se ele enviou um valor em texto, como "R$ 5000", "5000", "5.000,00", "5K", "5,8k", "R$5.876,41", "$5876,41", "5876,41", "5.876,41", ou qualquer formato numérico que represente um valor monetário maior ou igual a 4000)
- "nao_confirmado" (se ele não enviou um valor em texto ou disse que não conseguiu, como "não achei", "não tem valor", etc)
- "duvida" (se ele perguntou algo tipo "onde tá FINANCEIRO", "qual valor mando", "como vejo o valor", etc)
- "neutro" (se ele falou algo afirmativo como "beleza", "tá bom", "certo", "fechou", "ok", "entendi", "vou fazer", "slk", ou algo irrelevante como "Próximo passo?" que não confirma, nega ou questiona)

Considere variações de formato monetário em português brasileiro, com ou sem "R$" ou "$", com ponto ou vírgula como separador, e com "k" para milhares (ex.: "5.8k" = 5800). Nunca explique nada. Só escreva uma dessas palavras.
  `;
}

const promptClassificaRelevancia = (mensagensTexto, temMidia) => `
Analise TODAS as respostas do lead após pedir para ele sacar o valor e avisar quando cair:\n"${mensagensTexto}"\n\nConsidere se a mensagem contém referências a:\n- Problema (ex.: "deu problema", "tá com problema", "não funcionou")\n- Taxa (ex.: "tem taxa?", "cobrou taxa")\n- Dúvida (ex.: "como faço?", "o que é isso?", "onde clico?", "ué", "apareceu um negócio")\n- Validação (ex.: "confirma isso?", "precisa validar?", "validação", "pediu validação", "pediu verificar", "pediu")\n- Negócio (ex.: "qual é o negócio?", "que trampo é esse?")\n- Valor a pagar (ex.: "quanto pago?", "tem custo?")\n- Tela (ex.: "na tela aparece isso", "qual tela?")\n- Erro (ex.: "deu erro", "não funcionou")\n- Print (ex.: "te mandei o print", "é um print")\n- Ou se a mensagem é uma mídia (como imagem, vídeo, documento, etc.): ${temMidia ? 'sim' : 'não'}\n\nIgnorar como irrelevante se a mensagem for uma afirmação ou confiança (ex.: "confia irmão", "sou seu sócio agora", "vc vai ver que sou suave", "sou lara do 7", "tô na confiança", "beleza", "tamo junto", "vou mandar", "certo", "calma aí", "e aí?").\n\nResponda com só UMA destas opções:\n- "relevante" (se a mensagem contém qualquer um dos critérios acima ou é uma mídia)\n- "irrelevante" (se a mensagem não contém nenhum dos critérios e não é uma mídia, incluindo afirmações ou confiança)\n\nNunca explique nada. Só escreva uma dessas palavras.\n`;

const mensagemImpulso = `mano, é o seguinte
eu to fazendo uns quinze trampos aqui agora
entao, vou te mandar as instruções muito diretas. e, mano, vai me respondendo so o necessario, pode ser?`;

const mensagensIntrodutorias = [
  [
    ['antes de mais nada, já salva meu contato', 'antes de mais nada, salva meu contato', 'já deixa meu contato salvo aí', 'antes de tudo, já salva meu contato']
  ]
];

const checklistVariacoes = [
  ['vou te passar as instruções', 'vou te explicar como funciona', 'vou te falar como funciona', 'vou te explicar como funciona agora'],
  ['arruma uma conta com pelo menos 5 mil de limite no pix', 'arruma uma conta com pelo menos 5000 de limite no pix', 'vc tem que ter uma conta com pelo menos 5000 de limite no pix', 'a sua conta vai ter que ter pelo menos 5000 de limite no pix'],
  ['pode ser qualquer banco', 'qualquer banco', 'tanto faz o banco', 'banco físico ou digital'],
  ['se tiver como, desativa o wi-fi e ativa só os dados móveis', 'se der, desativa o wi-fi e ativa os dados móveis', 'se conseguir, desliga o wi-fi e liga os dados móveis', 'se puder, desliga o wi-fi e liga o 5g'],
  ['vou te mandar uma conta com usuário e senha pra acessar', 'vou te passar os dados pra vc acessar uma conta', 'vou te mandar os dados de acesso da conta pra entrar', 'vou te passar usuário e senha de uma conta', 'vou te mandar os dados de login pra entrar na conta'],
  [
    ['vc vai sacar R$ 5000 dessa conta pra sua conta de recebimento', 'vc vai sacar R$ 5000 dessa conta pra sua conta de recebimento', 'vc vai sacar R$ 5000 do saldo disponível lá pra sua conta bancária'],
    ['sua parte vai ser R$ 2000 nesse trampo, e vc vai mandar o restante pra gente assim que cair', 'sua parte nesse trampo é de R$ 2000, manda o restante pra minha conta assim que cair', 'vc fica com R$ 2000 desse trampo, o resto manda pra gente assim que cair', 'sua parte é R$ 2000, o restante manda pra minha conta logo que cair'],
    ['sem gracinha', 'certo pelo certo', 'sem sumir depois']
  ]
];

const mensagensPosChecklist = [
  ['mas fica tranquilo', 'mas relaxa', 'mas fica suave'],
  ['a gente vai fazer parte por parte', 'a gente faz parte por parte', 'a gente faz na calma, parte por parte']
];

const respostasNaoConfirmadoAcesso = [
  'mano, tenta de novo com os dados que te mandei. copia o usuário e senha certinho e usa o link. me avisa quando entrar',
  'tenta de novo, mano. usa o usuário e senha que te passei e o link certinho. me chama quando entrar'
];

const respostasNaoConfirmadoConfirmacao = [
  'me escreve o valor que tá disponível, EXATAMENTE nesse formato: R$ 5000, por exemplo',
  'me manda aqui escrito o valor disponível, EXATAMENTE nesse formato: R$ 5000, por exemplo',
  'me escreve aqui o valor disponível, EXATAMENTE nesse formato: R$ 5000, por exemplo',
  'escreve aqui o valor disponível, EXATAMENTE nesse formato: R$ 5000, por exemplo'
];

const respostasDuvidasComuns = {
  'não tenho 4g': 'não, tudo bem, vamos manter no wi-fi. o resto tá pronto, bora seguir',
  'qual cpf': 'usa o CPF da sua conta que vai receber a grana. faz aí e me avisa',
  'onde fica o perfil': 'no app, geralmente tá nas configurações ou no canto superior, procura por PERFIL',
  'não tenho 5k': 'tenta arrumar uma conta com alguém, precisa ter 5k pra rolar',
  'onde coloco o usuário': 'no campo de login no link que te mandei. copia o usuário e senha certinho',
  'o link não abre': 'tenta copiar e colar no navegador. me avisa se não rolar',
  'qual senha': 'a senha é a que te mandei. copia e cola no login',
  'não achei perfil': 'no app, vai nas configurações ou no canto superior, procura por PERFIL',
  'onde tá financeiro': 'no app, procura no menu ou configurações, tá como FINANCEIRO, depois me manda o valor em texto',
  'qual valor mando': 'o valor que aparece em FINANCEIRO, só escreve o número em texto',
  'como faço o saque': 'vai em FINANCEIRO, seleciona sacar, coloca TUDO pra sua conta e usa as senhas que te mandei',
  'qual chave pix': 'te passo a chave assim que confirmar que caiu, saca primeiro e me avisa',
  'demora quanto': 'saca tudo agora, geralmente cai na hora. me avisa quando cair'
};

function gerarSenhaAleatoria() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function quebradizarTexto(resposta) {
  return resposta.replace(/\b(você|vcê|cê|ce)\b/gi, 'vc');
}

function inicializarEstado(contato) {
  estadoContatos[contato] = {
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
    aguardandoPrint: false
  };
  atualizarContato(contato, 'Sim', 'abertura');
  console.log(`[${contato}] Estado inicializado e contato atualizado: Sim, abertura`);
}

async function criarUsuarioDjango(contato) {
  try {
    const DJANGO_API_URL = process.env.DJANGO_API_URL || 'https://www.cointex.com.br/api/create-user/';
    const response = await axios.post(DJANGO_API_URL, { tid: contato });
    if (response.data.status === 'success' && response.data.users && response.data.users.length > 0) {
      const userData = response.data.users[0];
      estadoContatos[contato].credenciais = {
        username: userData.email,
        password: userData.password,
        link: userData.login_url
      };
      console.log(`[${contato}] Usuário criado em background: ${userData.email}`);
    } else {
      console.error(`[${contato}] API retornou status inválido ou sem users: ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    console.error(`[${contato}] Erro na API Django: ${error.message}`);
  }
}

async function gerarResposta(messages, max_tokens = 60) {
  try {
    console.log("[OpenAI] Enviando requisição: " + JSON.stringify(messages, null, 2));
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
      max_tokens
    });
    const respostaBruta = completion.choices[0].message.content.trim();
    const resposta = quebradizarTexto(respostaBruta);
    console.log("[OpenAI] Resposta recebida: " + resposta);
    return resposta;
  } catch (error) {
    console.error("[OpenAI] Erro: " + error.message);
    return 'mano, deu um erro aqui, tenta de novo depois';
  }
}

async function enviarLinhaPorLinha(to, texto) {
  const estado = estadoContatos[to];
  if (!estado) {
    console.log(`[${to}] Erro: Estado não encontrado em enviarLinhaPorLinha`);
    return;
  }
  estado.enviandoMensagens = true;
  console.log(`[${to}] Iniciando envio de mensagem: "${texto}"`);

  console.log(`[${to}] Texto recebido para envio:\n${texto}`);

  await delay(10000);

  const linhas = texto.split('\n').filter(line => line.trim() !== '');
  for (const linha of linhas) {
    if (!linha || linha.trim() === '') {
      console.log(`[${to}] Ignorando linha vazia`);
      continue;
    }
    try {
      console.log(`[${to}] Enviando linha: "${linha}"`);
      await delay(Math.max(500, linha.length * 30));
      await sendMessage(to, linha);
      console.log(`[${to}] Linha enviada: "${linha}"`);
      await delay(7000 + Math.floor(Math.random() * 1000));
    } catch (error) {
      console.error(`[${to}] Erro ao enviar linha "${linha}": ${error.message}`);
      estado.enviandoMensagens = false;
      return;
    }
  }
  estado.enviandoMensagens = false;
  console.log(`[${to}] Envio concluído: "${texto}"`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processarMensagensPendentes(contato) {
  try {
    const estado = estadoContatos[contato];
    const estadoSemTimeout = Object.assign({}, estado, { acompanhamentoTimeout: estado && estado.acompanhamentoTimeout ? '[Timeout]' : null });
    console.log("[" + contato + "] Estado atual: " + JSON.stringify(estadoSemTimeout, null, 2));
    
    if (!estado || estado.enviandoMensagens) {
      console.log("[" + contato + "] Bloqueado: estado=" + (!!estado) + ", enviandoMensagens=" + (estado && estado.enviandoMensagens));
      return;
    }

    const mensagensPacote = [...estado.mensagensPendentes];
    estado.mensagensPendentes = [];
    const mensagensTexto = mensagensPacote.map(msg => msg.texto).join('\n');
    const temMidia = mensagensPacote.some(msg => msg.temMidia);

    const agora = Date.now();
    if (estado.etapa === 'encerrado' && estado.encerradoAte && agora < estado.encerradoAte) {
      console.log("[" + contato + "] Lead em timeout até " + new Date(estado.encerradoAte).toLocaleTimeString());
      return;
    }

    if (mensagensPacote.length === 0) {
      console.log("[" + contato + "] Nenhuma mensagem nova para processar");
      return;
    }

    if (estado.etapa === 'abertura') {
      console.log("[" + contato + "] Processando etapa abertura");
      if (!estado.aberturaConcluida) {
        const grupo1 = ['salve mano', 'e aí parceiro', 'salve', 'fala', 'fala mano', 'fala meu mano', 'e aí mano', 'salve irmão', 'salve, salve mano'];
        const grupo2 = ['tô precisando de um lara pra agora', 'preciso de um lara pra agora', 'preciso de um lara pra agora'];
        const grupo3 = ['tá disponível?', 'vai poder fazer o trampo?', 'vai poder fazer o trampo agora?'];
        const resposta = [
          grupo1[Math.floor(Math.random() * grupo1.length)],
          grupo2[Math.floor(Math.random() * grupo2.length)],
          grupo3[Math.floor(Math.random() * grupo3.length)]
        ].join('\n');
        await enviarLinhaPorLinha(contato, resposta);
        estado.aberturaConcluida = true;
        estado.historico.push({ role: 'assistant', content: resposta });
        await atualizarContato(contato, 'Sim', 'abertura', resposta);
        console.log("[" + contato + "] Mensagem inicial enviada: " + resposta);
      } else if (mensagensPacote.length > 0) {
        const contextoAceite = mensagensTexto;
        const tipoAceite = await gerarResposta([{ role: 'system', content: promptClassificaAceite(contextoAceite) }], 12);
        console.log("[" + contato + "] Tipo de resposta: " + tipoAceite);

        if (tipoAceite.includes('aceite')) {
          await enviarLinhaPorLinha(contato, mensagemImpulso);
          estado.etapa = 'impulso';
          estado.historico.push({ role: 'assistant', content: mensagemImpulso });
          estado.mensagensDesdeSolicitacao = [];
          await atualizarContato(contato, 'Sim', 'impulso', mensagemImpulso);
          console.log("[" + contato + "] Avançando para etapa impulso");
        } else if (tipoAceite.includes('recusa')) {
          if (estado.negativasAbertura < 2) {
            const insistencias = ['vamo maluco, é rapidão', 'demora nada, bora nessa', 'tá com medo de que, mano?'];
            const insistencia = insistencias[estado.negativasAbertura];
            await enviarLinhaPorLinha(contato, insistencia);
            estado.negativasAbertura++;
            estado.historico.push({ role: 'assistant', content: insistencia });
            await atualizarContato(contato, 'Sim', 'abertura', insistencia);
            console.log("[" + contato + "] Insistindo após recusa (" + estado.negativasAbertura + "/2)");
          } else {
            const mensagem = 'quando quiser, só chamar';
            await enviarLinhaPorLinha(contato, mensagem);
            estado.etapa = 'encerrado';
            estado.encerradoAte = Date.now() + 3 * 60 * 60 * 1000;
            estado.historico.push({ role: 'assistant', content: mensagem });
            await atualizarContato(contato, 'Sim', 'encerrado', mensagem);
            console.log("[" + contato + "] Etapa encerrada após 2 recusas");
          }
        } else if (tipoAceite.includes('duvida')) {
          await enviarLinhaPorLinha(contato, mensagemImpulso);
          estado.etapa = 'impulso';
          estado.historico.push({ role: 'assistant', content: mensagemImpulso });
          estado.mensagensDesdeSolicitacao = [];
          await atualizarContato(contato, 'Sim', 'impulso', mensagemImpulso);
          console.log("[" + contato + "] Resposta classificada como dúvida, avançando para impulso");
        } else {
          const mensagem = 'manda aí se vai ou não, mano';
          await enviarLinhaPorLinha(contato, mensagem);
          estado.historico.push({ role: 'assistant', content: mensagem });
          await atualizarContato(contato, 'Sim', 'abertura', mensagem);
          console.log("[" + contato + "] Resposta não classificada, pedindo esclarecimento");
        }
      }
      console.log(`[${contato}] Estado após processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    }

    if (estado.etapa === 'impulso') {
      console.log("[" + contato + "] Etapa 2: impulso");
      const contextoAceite = mensagensPacote.map(msg => msg.texto).join('\n');
      const tipoAceite = await gerarResposta([{ role: 'system', content: promptClassificaAceite(contextoAceite) }], 12);
      console.log("[" + contato + "] Mensagens processadas: " + mensagensTexto + ", Classificação: " + tipoAceite);

      if (tipoAceite.includes('aceite') || tipoAceite.includes('duvida')) {
        if (!estado.instrucoesEnviadas) {
          const mensagemIntro = mensagensIntrodutorias[0][0][Math.floor(Math.random() * mensagensIntrodutorias[0][0].length)];
          const blocoInstrucoes = gerarBlocoInstrucoes();
          const mensagemCompleta = mensagemIntro + "\n\n" + blocoInstrucoes;
          await enviarLinhaPorLinha(contato, mensagemCompleta);
          estado.etapa = 'instruções';
          estado.instrucoesEnviadas = true;
          estado.instrucoesCompletas = true;
          estado.aguardandoAcompanhamento = true;
          estado.mensagemDelayEnviada = false;
          estado.historico.push({ role: 'assistant', content: mensagemCompleta });
          await atualizarContato(contato, 'Sim', 'instruções', mensagemCompleta);
          console.log("[" + contato + "] Etapa 3: instruções - checklist enviado");

          if (estado.credenciais && estado.credenciais.username && estado.credenciais.password && estado.credenciais.link) {
            const mensagensAcesso = [
              'vamos começar, tá bom?',
              'não manda áudio e só responde com o que eu pedir',
              "USUÁRIO: ",
              estado.credenciais.username,
              "SENHA: ",
              estado.credenciais.password,
              estado.credenciais.link,
              'me avisa assim que vc entrar. manda só "ENTREI" pra agilizar'
            ];
            for (const msg of mensagensAcesso) {
              await enviarLinhaPorLinha(contato, msg);
              estado.historico.push({ role: 'assistant', content: msg });
              await atualizarContato(contato, 'Sim', 'acesso', msg);
            }
            estado.etapa = 'acesso';
            estado.tentativasAcesso = 0;
            estado.mensagensDesdeSolicitacao = [];
            console.log("[" + contato + "] Etapa 4: acesso - credenciais enviadas");
          } else {
            const mensagem = 'mano, ainda tô esperando os dados da conta, faz aí direitinho e me avisa';
            await enviarLinhaPorLinha(contato, mensagem);
            estado.historico.push({ role: 'assistant', content: mensagem });
            await atualizarContato(contato, 'Sim', 'instruções', mensagem);
            estado.mensagensDesdeSolicitacao = [];
            console.log("[" + contato + "] Etapa 3: instruções - credenciais não disponíveis");
          }
        }
      } else if (tipoAceite.includes('recusa')) {
        if (!estado.negativasAbertura) estado.negativasAbertura = 0;
        if (estado.negativasAbertura < 2) {
          const insistencias = ['vamo maluco, é rapidão', 'demora nada, bora nessa', 'tá com medo de que, mano?'];
          const insistencia = insistencias[estado.negativasAbertura];
          await enviarLinhaPorLinha(contato, insistencia);
          estado.negativasAbertura++;
          estado.historico.push({ role: 'assistant', content: insistencia });
          await atualizarContato(contato, 'Sim', 'impulso', insistencia);
        } else {
          const mensagem = 'quando quiser, só chamar';
          await enviarLinhaPorLinha(contato, mensagem);
          estado.etapa = 'encerrado';
          estado.encerradoAte = Date.now() + 3 * 60 * 60 * 1000;
          estado.historico.push({ role: 'assistant', content: mensagem });
          await atualizarContato(contato, 'Sim', 'encerrado', mensagem);
          console.log("[" + contato + "] Etapa encerrada (aguardando lead retomar)");
        }
      } else {
        const mensagem = 'manda aí se vai ou não, mano';
        await enviarLinhaPorLinha(contato, mensagem);
        estado.historico.push({ role: 'assistant', content: mensagem });
        await atualizarContato(contato, 'Sim', 'impulso', mensagem);
      }
      console.log(`[${contato}] Estado após processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    }

    if (estado.etapa === 'instruções') {
      console.log("[" + contato + "] Etapa 3: instruções");
      if (estado.instrucoesCompletas && mensagensPacote.length > 0) {
        console.log("[" + contato + "] Mensagem recebida durante espera: " + mensagensTexto);
        const tipoAceite = await gerarResposta([{ role: 'system', content: promptClassificaAceite(mensagensTexto) }], 12);
        if (tipoAceite.includes('aceite') && !estado.mensagemDelayEnviada) {
          const mensagem = '5 minutinhos eu já te chamo aí';
          await enviarLinhaPorLinha(contato, mensagem);
          estado.mensagemDelayEnviada = true;
          estado.historico.push({ role: 'assistant', content: mensagem });
          await atualizarContato(contato, 'Sim', 'instruções', mensagem);
          console.log("[" + contato + "] Mensagem de espera enviada");

          setTimeout(async () => {
            console.log("[" + contato + "] Timeout de 5 minutos expirado - avançando para acesso");
            if (estado.credenciais && estado.credenciais.username && estado.credenciais.password && estado.credenciais.link) {
              const mensagensAcesso = [
                'vamos começar, tá bom?',
                'não manda áudio e só responde com o que eu pedir',
                `USUÁRIO:`,
                `${estado.credenciais.username}`,
                `SENHA:`,
                `${estado.credenciais.password}`,
                `${estado.credenciais.link}`,
                'me avisa assim que vc entrar. manda só "ENTREI" pra agilizar'
              ];
              for (const msg of mensagensAcesso) {
                await enviarLinhaPorLinha(contato, msg);
                estado.historico.push({ role: 'assistant', content: msg });
                await atualizarContato(contato, 'Sim', 'acesso', msg);
              }
              estado.etapa = 'acesso';
              estado.tentativasAcesso = 0;
              estado.mensagensDesdeSolicitacao = [];
              console.log("[" + contato + "] Etapa 4: acesso - credenciais enviadas após timeout");
            } else {
              const mensagem = 'mano, ainda tô esperando os dados da conta, faz aí direitinho e me avisa';
              await enviarLinhaPorLinha(contato, mensagem);
              estado.historico.push({ role: 'assistant', content: mensagem });
              await atualizarContato(contato, 'Sim', 'instruções', mensagem);
              estado.mensagensDesdeSolicitacao = [];
              console.log("[" + contato + "] Etapa 3: instruções - credenciais não disponíveis após timeout");
            }
          }, 300000);
        } else {
          console.log("[" + contato + "] Ignorando mensagem irrelevante ou já enviou mensagem de espera: " + mensagensTexto);
        }
        estado.mensagensPendentes = [];
      }
      console.log(`[${contato}] Estado após processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    }

    if (estado.etapa === 'acesso') {
      console.log("[" + contato + "] Etapa 4: acesso");
      const tipoAcesso = await gerarResposta([{ role: 'system', content: promptClassificaAcesso(mensagensTexto) }], 12);
      console.log("[" + contato + "] Mensagens processadas: " + mensagensTexto + ", Classificação: " + tipoAcesso);

      if (tipoAcesso.includes('confirmado')) {
        const mensagensConfirmacao = [
          'agora manda um PRINT (ou uma foto) do saldo disponível, ou manda o valor disponível em escrito, EXATAMENTE NESSE FORMATO: "5000", por exemplo',
        ];
        for (const msg of mensagensConfirmacao) {
          await enviarLinhaPorLinha(contato, msg);
          estado.historico.push({ role: 'assistant', content: msg });
          await atualizarContato(contato, 'Sim', 'confirmacao', msg);
        }
        estado.etapa = 'confirmacao';
        estado.mensagensDesdeSolicitacao = [];
        estado.tentativasAcesso = 0;
        console.log("[" + contato + "] Etapa 5: confirmação - instruções enviadas");
      } else if (tipoAcesso.includes('nao_confirmado')) {
        if (estado.tentativasAcesso < 2) {
          const resposta = respostasNaoConfirmadoAcesso[Math.floor(Math.random() * respostasNaoConfirmadoAcesso.length)];
          await enviarLinhaPorLinha(contato, resposta);
          estado.tentativasAcesso++;
          estado.historico.push({ role: 'assistant', content: resposta });
          await atualizarContato(contato, 'Sim', 'acesso', resposta);
          console.log("[" + contato + "] Etapa 4: acesso - tentativa " + (estado.tentativasAcesso + 1) + "/2, insistindo");
        } else {
          const mensagem = 'mano, não rolou, tenta de novo outra hora';
          await enviarLinhaPorLinha(contato, mensagem);
          estado.etapa = 'encerrado';
          estado.encerradoAte = Date.now() + 3 * 60 * 60 * 1000;
          estado.historico.push({ role: 'assistant', content: mensagem });
          await atualizarContato(contato, 'Sim', 'encerrado', mensagem);
          console.log("[" + contato + "] Etapa encerrada após 2 tentativas");
        }
      } else if (tipoAcesso.includes('duvida')) {
        const mensagemLower = mensagensTexto.toLowerCase();
        let resposta = 'usa o usuário e senha que te passei, entra no link e me avisa com ENTREI';
        for (const [duvida, respostaPronta] of Object.entries(respostasDuvidasComuns)) {
          if (mensagemLower.includes(duvida)) {
            resposta = respostaPronta;
            break;
          }
        }
        await enviarLinhaPorLinha(contato, resposta);
        estado.historico.push({ role: 'assistant', content: resposta });
        await atualizarContato(contato, 'Sim', 'acesso', resposta);
        console.log("[" + contato + "] Etapa 4: acesso - respondeu dúvida, aguardando");
      } else {
        console.log("[" + contato + "] Mensagem neutra recebida, ignorando: " + mensagensTexto);
        estado.mensagensPendentes = [];
      }
      console.log(`[${contato}] Estado após processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    }

    if (estado.etapa === 'confirmacao') {
      console.log("[" + contato + "] Etapa 5: confirmação");
      const mensagensTextoConfirmacao = estado.mensagensDesdeSolicitacao.join('\n');
      const temMidia = mensagensPacote.some(msg => msg.temMidia);
      let tipoConfirmacao;
      if (temMidia) {
        tipoConfirmacao = 'confirmado';
        console.log("[" + contato + "] Mídia detectada, classificando como confirmado automaticamente");
      } else {
        tipoConfirmacao = await gerarResposta([{ role: 'system', content: promptClassificaConfirmacao(mensagensTextoConfirmacao) }], 12);
      }

      let saldoInformado = null;
      if (tipoConfirmacao.includes('confirmado')) {
        const possivelValor = estado.mensagensDesdeSolicitacao
          .slice()
          .reverse()
          .find(msg => msg.match(/[\d.,]+/) && !msg.includes('[mídia]'));
        if (possivelValor) {
          saldoInformado = possivelValor;
        } else if (temMidia) {
          saldoInformado = 'R$ 5000';
          console.log("[" + contato + "] Mídia sem valor em texto; usando saldo default: " + saldoInformado);
        }
      }

      console.log("[" + contato + "] Mensagens processadas: " + mensagensTextoConfirmacao + ", Classificação: " + tipoConfirmacao + ", Saldo informado: " + (saldoInformado || 'nenhum'));

      if (tipoConfirmacao.includes('confirmado') && saldoInformado) {
        estado.saldo_informado = saldoInformado;
        const saqueVariacoes = [
          'beleza, mano, saca R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho) dessa conta',
          'beleza, mano, pode sacar R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho) dessa conta',
          'beleza, mano, saca R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho)',
          'certo, pode sacar R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho)',
          'certo, saca R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho) agora',
          'pode sacar R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho) agora',
          'pode sacar R$ 5155 (descontando a taxa de 3%, vai cair R$ 5000 certinho)'
        ];
        const senhaIntroVariacao = [
          'vai pedir uma senha de saque, vai ser uma dessas:',
          'vou te passar uma senha de saque, vai ser uma dessas:',
          'vai pedir uma senha, vai ser uma dessas:',
          'vai pedir a senha de saque, vai ser uma dessas:'
        ];
        const parteVariacao = [
          'tua parte no trampo é de 2000',
          'tua parte é de 2000',
          'não esquece, sua parte é de 2000',
          'tua parte no trampo é de R$ 2000',
          'tua parte é de R$ 2000',
          'não esquece, sua parte é de R$ 2000'
        ];
        const avisaVariacao = [
          'assim que cai me avisa',
          'assim que cair me manda uma mensagem',
          'me avisa assim que cai',
          'me manda quando cair'
        ];
        const pixVariacao = [
          'pra eu te passar como você vai mandar minha parte',
          'pra eu poder te passar como vc vai mandar minha parte',
          'pra eu te falar como vc vai me mandar meu dinheiro',
          'pra eu te explicar como vc vai mandar minha parte',
          'pra eu te mostrar como vc vai mandar minha parte'
        ];
        const avisoVariacao = [
          'sem gracinha, mano',
          'certo pelo certo, mano',
          'não pisa na bola, mano',
          'faz direitinho, mano',
          'manda certinho, mano',
          'manda tudo certo, mano'
        ];
        const confiancaVariacao = [
          'tô confiando em vc, se fazer certinho tem mais trampo. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)',
          'tô na fé em vc, faz certo que te passo mais trampo. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)',
          'tô na confiança, faz certo que vai ter mais. se tiver qualquer problema pra sacar me manda um PRINT (ou uma foto da tela)'
        ];
        const senha1 = gerarSenhaAleatoria();
        const senha2 = '8293';
        const mensagensSaque = [
          saqueVariacoes[Math.floor(Math.random() * saqueVariacoes.length)],
          senhaIntroVariacao[Math.floor(Math.random() * senhaIntroVariacao.length)],
          senha1,
          senha2,
          parteVariacao[Math.floor(Math.random() * parteVariacao.length)],
          avisaVariacao[Math.floor(Math.random() * avisaVariacao.length)] + ' ' + pixVariacao[Math.floor(Math.random() * pixVariacao.length)],
          avisoVariacao[Math.floor(Math.random() * avisoVariacao.length)],
          confiancaVariacao[Math.floor(Math.random() * confiancaVariacao.length)]
        ];
        for (const msg of mensagensSaque) {
          await enviarLinhaPorLinha(contato, msg);
          estado.historico.push({ role: 'assistant', content: msg });
          await atualizarContato(contato, 'Sim', 'saque', msg);
        }
        estado.etapa = 'saque';
        estado.mensagensDesdeSolicitacao = [];
        console.log("[" + contato + "] Etapa 6: saque - instruções enviadas");
      } else if (tipoConfirmacao.includes('nao_confirmado')) {
        if (estado.tentativasConfirmacao < 2) {
          const resposta = respostasNaoConfirmadoConfirmacao[Math.floor(Math.random() * respostasNaoConfirmadoConfirmacao.length)];
          await enviarLinhaPorLinha(contato, resposta);
          estado.tentativasConfirmacao++;
          estado.historico.push({ role: 'assistant', content: resposta });
          await atualizarContato(contato, 'Sim', 'confirmacao', resposta);
          console.log("[" + contato + "] Etapa 5: confirmação - tentativa " + (estado.tentativasConfirmacao + 1) + "/2, insistindo");
        } else {
          const mensagem = 'mano, não deu certo, tenta de novo outra hora';
          await enviarLinhaPorLinha(contato, mensagem);
          estado.etapa = 'encerrado';
          estado.encerradoAte = Date.now() + 3 * 60 * 60 * 1000;
          estado.historico.push({ role: 'assistant', content: mensagem });
          await atualizarContato(contato, 'Sim', 'encerrado', mensagem);
          console.log(`[${contato}] Etapa encerrada após 2 tentativas`);
        }
      } else if (tipoConfirmacao.includes('duvida')) {
        const mensagemLower = mensagensTextoConfirmacao.toLowerCase();
        let resposta = 'me manda o valor que tá em FINANCEIRO, só o número em texto';
        for (const [duvida, respostaPronta] of Object.entries(respostasDuvidasComuns)) {
          if (mensagemLower.includes(duvida)) {
            resposta = respostaPronta;
            break;
          }
        }
        await enviarLinhaPorLinha(contato, resposta);
        estado.historico.push({ role: 'assistant', content: resposta });
        await atualizarContato(contato, 'Sim', 'confirmacao', resposta);
        console.log("[" + contato + "] Etapa 5: confirmação - respondeu dúvida, aguardando");
      } else {
        console.log("[" + contato + "] Mensagem neutra recebida, aguardando valor válido: " + mensagensTextoConfirmacao);
        estado.mensagensPendentes = [];
      }
      console.log(`[${contato}] Estado após processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
      return;
    }

    if (estado.etapa === 'saque') {
      console.log("[" + contato + "] Etapa 6: saque - Início do processamento");
      const mensagensDoLead = mensagensPacote.filter(
        msg => !msg.texto.startsWith('USUÁRIO:') &&
               !msg.texto.startsWith('SENHA:') &&
               !msg.texto.includes('saca') &&
               !msg.texto.includes('senha')
      );
      const mensagensTextoSaque = mensagensDoLead.map(msg => msg.texto).join('\n');
      const temMidiaReal = mensagensPacote.some(msg => msg.temMidia);
      const tipoRelevancia = await gerarResposta([{ role: 'system', content: promptClassificaRelevancia(mensagensTextoSaque, temMidiaReal) }], 12);
      console.log("[" + contato + "] Mensagens processadas (apenas lead): " + mensagensTextoSaque + ", temMidiaReal: " + temMidiaReal + ", Resposta bruta OpenAI: \"" + tipoRelevancia + "\"");

      const relevanciaNormalizada = tipoRelevancia.trim().toLowerCase();

      if (temMidiaReal) {
        estado.aguardandoPrint = false;
        estado.etapa = 'validacao';
        const respostas = [
          ['calma ai', 'calma ai irmão', 'calma aí mano', 'perai mano', 'perai'][Math.floor(Math.random() * 5)],
          ['pediu validação', 'pediu pra validar a conta', 'pediu validação bancária', 'caiu na validação', 'pediu verificação'][Math.floor(Math.random() * 5)],
          ['confirma aí, vai clicando em "Próximo"', 'vai clicando em "Próximo"', 'vai clicando em "Próximo" ai', 'pode ir clicando em "Próximo aí"'][Math.floor(Math.random() * 4)],
          ['vou falar com a menina aqui', 'vou falar com a menina que trabalha lá', 'vou falar com a menina do esquema aqui', 'vou falar com a menina que trampa lá'][Math.floor(Math.random() * 4)],
          ['aguarda 5m irmão', 'espera 5m aí', 'aguarda 5m aí mano', '5m já resolvo', 'espera 5m mano'][Math.floor(Math.random() * 5)]
        ];
        for (const msg of respostas) {
          await enviarLinhaPorLinha(contato, msg);
          estado.historico.push({ role: 'assistant', content: msg });
          await atualizarContato(contato, 'Sim', 'validacao', msg);
        }
        console.log("[" + contato + "] Etapa 7: validação - avançou devido a mídia");

        estado.acompanhamentoTimeout = setTimeout(async () => {
          console.log("[" + contato + "] Timeout de 3,5 minutos expirado - enviando mensagens pós-validação");
          const mensagensPosTimeout = [
            'ela me respondeu aqui',
            'é que essa conta nunca teve saque',
            'então quando saca pela primeira vez, qualquer valor acima de R$ 3000',
            'eles pedem pra validar a conta bancária como método de segurança',
            'pior que n tem muito o que fazer, tem q pagar essa validação pra sacar o dinheiro',
            'ela falou que valida na hora, pelo menos é mixaria',
            '27 conto pra sacar tudo isso vale a pena kkkkk',
            'pode validar, faz com bastante calma pra receber o saque certinho',
            'valida com a mesma conta que colocou pra receber o saque',
            'lembra',
            'sua parte é 2000',
            'vou precisar sair pra resolver um problema aqui',
            'mas não deixa de validar não',
            'assim que o saque cair na sua conta me avisa aqui',
            'o saldo dessa conta vai expirar em pouco tempo',
            'então não perde esse dinheiro todo por causa de merreca não'
          ];
          for (let i = 0; i < mensagensPosTimeout.length; i++) {
            console.log("[" + contato + "] Enviando mensagem com delay: " + mensagensPosTimeout[i]);
            await enviarLinhaPorLinha(contato, mensagensPosTimeout[i]);
            estado.historico.push({ role: 'assistant', content: mensagensPosTimeout[i] });
            await atualizarContato(contato, 'Sim', 'validacao', mensagensPosTimeout[i]);
            if (i === mensagensPosTimeout.length - 1) {
              estado.acompanhamentoTimeout = null;
              console.log("[" + contato + "] Todas as mensagens pós-timeout enviadas");
            }
            await delay(1000);
          }
        }, 210000);
      } else if (relevanciaNormalizada === 'relevante') {
        console.log("[" + contato + "] Entrando no bloco relevante (sem mídia)");
        if (!estado.aguardandoPrint) {
          estado.aguardandoPrint = true;
          const respostas = [
            ['o que deu aí irmão?', 'o que apareceu aí?', 'o que apareceu aí mano?', 'o que aconteceu?'][Math.floor(Math.random() * 4)],
            ['manda PRINT', 'me manda um PRINT', 'manda um PRINT aí', 'me manda um PRINT aí irmão'][Math.floor(Math.random() * 4)]
          ];
          for (const msg of respostas) {
            await enviarLinhaPorLinha(contato, msg);
            estado.historico.push({ role: 'assistant', content: msg });
            await atualizarContato(contato, 'Sim', 'saque', msg);
          }
          console.log("[" + contato + "] Etapa 6: saque - pedindo print após mensagem relevante");
        } else {
          console.log("[" + contato + "] Já pediu print, aguardando mídia");
          estado.mensagensPendentes = [];
        }
      } else {
        console.log("[" + contato + "] Entrando no bloco irrelevante");
        console.log("[" + contato + "] Mensagem irrelevante ignorada: " + mensagensTextoSaque);
        estado.mensagensPendentes = [];
      }
      console.log("[" + contato + "] Estado após processamento: etapa=" + estado.etapa + ", mensagensPendentes=" + estado.mensagensPendentes.length + ", aguardandoPrint=" + estado.aguardandoPrint + ", acompanhamentoTimeout=" + (estado.acompanhamentoTimeout ? 'ativo' : 'inativo'));
      return;
    }

    if (estado.etapa === 'validacao') {
      console.log("[" + contato + "] Etapa 7: validação");
      const mensagensDoLead = mensagensPacote.filter(
        msg => !msg.texto.startsWith('USUÁRIO:') &&
               !msg.texto.startsWith('SENHA:') &&
               !msg.texto.includes('saca') &&
               !msg.texto.includes('senha')
      );
      const mensagensTextoValidacao = mensagensDoLead.map(msg => msg.texto).join('\n');
      const temMidia = mensagensPacote.some(msg => msg.temMidia);
      console.log("[" + contato + "] Mensagens processadas (apenas lead): " + mensagensTextoValidacao + ", temMidia: " + temMidia);

      if (estado.acompanhamentoTimeout) {
        console.log("[" + contato + "] Ignorando mensagens durante timeout de 3,5 minutos");
        estado.mensagensPendentes = [];
        await atualizarContato(contato, 'Sim', 'validacao', mensagensTextoValidacao, temMidia);
        return;
      }

      console.log("[" + contato + "] Timeout concluído, mas aguardando envio das mensagens de validação");
      estado.mensagensPendentes = [];
      await atualizarContato(contato, 'Sim', 'validacao', mensagensTextoValidacao, temMidia);
      return;
    }

    if (estado.etapa === 'encerrado') {
      console.log("[" + contato + "] Etapa encerrada");
      const grupo1 = ['salve mano', 'e aí parceiro', 'salve', 'fala', 'fala mano', 'fala meu mano', 'e aí mano', 'salve irmão', 'salve, salve mano'];
      const grupo2 = ['tô precisando de um lara pra agora', 'preciso de um lara pra agora', 'preciso de um lara pra agora', 'apareceu um trampo aqui', 'acabou de aparecer um trampo aqui', 'acabou de abrir uma vaga pra lara', 'tem vaga pra lara aqui', 'preciso de lara agora', 'preciso de lara', 'tô precisando de lara agora', 'preciso de lara urgente', 'tô precisando de um lara pra agora', 'acabou de aparecer um trampo aqui', 'apareceu vaga agora'];
      const grupo3 = ['tá disponível?', 'vai poder fazer o trampo?', 'vai poder fazer o trampo agora?', 'bora fazer esse trampo agora?', 'vamos fazer esse trampo agora?', 'vamos?', 'vai fazer?', 'vai poder fazer?', 'tá pronto?'];
      const resposta = [
        grupo1[Math.floor(Math.random() * grupo1.length)],
        grupo2[Math.floor(Math.random() * grupo2.length)],
        grupo3[Math.floor(Math.random() * grupo3.length)]
      ].join('\n');
      await enviarLinhaPorLinha(contato, resposta);
      estado.etapa = 'abertura';
      estado.aberturaConcluida = true;
      estado.negativasAbertura = 0;
      estado.instrucoesEnviadas = false;
      estado.instrucoesCompletas = false;
      estado.historico.push({ role: 'assistant', content: resposta });
      await atualizarContato(contato, 'Sim', 'abertura', resposta);
      console.log("[" + contato + "] Retorno à Etapa 1: abertura (retomada)");
      console.log("[" + contato + "] Estado após processamento: etapa=" + estado.etapa + ", mensagensPendentes=" + estado.mensagensPendentes.length);
      return;
    }

    console.log(`[${contato}] Estado após processamento: etapa=${estado.etapa}, mensagensPendentes=${estado.mensagensPendentes.length}`);
  } catch (error) {
    console.error("[" + contato + "] Erro em processarMensagensPendentes: " + error.message);
    estadoContatos[contato].mensagensPendentes = [];
    const mensagem = 'mano, vou ter que sair aqui, daqui a pouco te chamo';
    await enviarLinhaPorLinha(contato, mensagem);
    await atualizarContato(contato, 'Sim', estadoContatos[contato].etapa, mensagem);
  }
}

function gerarBlocoInstrucoes() {
  const checklist = [
    checklistVariacoes[0][Math.floor(Math.random() * checklistVariacoes[0].length)],
    checklistVariacoes[1][Math.floor(Math.random() * checklistVariacoes[1].length)],
    checklistVariacoes[2][Math.floor(Math.random() * checklistVariacoes[2].length)],
    checklistVariacoes[3][Math.floor(Math.random() * checklistVariacoes[3].length)],
    checklistVariacoes[4][Math.floor(Math.random() * checklistVariacoes[4].length)],
    checklistVariacoes[5][0][Math.floor(Math.random() * checklistVariacoes[5][0].length)],
    checklistVariacoes[5][1][Math.floor(Math.random() * checklistVariacoes[5][1].length)],
    checklistVariacoes[5][2][Math.floor(Math.random() * checklistVariacoes[5][2].length)]
  ].filter(line => typeof line === 'string' && line.trim() !== '');

  console.log("[Debug] Checklist gerado:", checklist);

  if (checklist.length !== 8) {
    console.error("[Error] Checklist incompleto, esperado 8 itens, recebido:", checklist.length);
    return "Erro ao gerar instruções, tente novamente.";
  }

  const posChecklist = [
    mensagensPosChecklist[0][Math.floor(Math.random() * mensagensPosChecklist[0].length)],
    mensagensPosChecklist[1][Math.floor(Math.random() * mensagensPosChecklist[1].length)]
  ].join('\n');

  const checklistTexto = checklist.map(line => `✅ ${line}`).join('\n');
  const textoFinal = `
⚠ presta atenção e segue cada passo, não pula nada:

${checklistTexto}

${posChecklist}
  `.trim();

  console.log("[Debug] Texto final gerado em gerarBlocoInstrucoes:\n" + textoFinal);
  return textoFinal;
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

// Inicie o DB no startup e ouça o servidor
initDatabase().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`[✅ Servidor rodando na porta ${PORT}]`);
  });
}).catch(err => console.error('Erro ao init DB:', err));