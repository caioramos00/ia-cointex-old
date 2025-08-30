const axios = require('axios');
const OpenAI = require('openai');
const { quebradizarTexto } = require('./utils');
const { estadoContatos } = require('./state');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DJANGO_API_URL = process.env.DJANGO_API_URL || 'https://www.cointex.com.br/api/create-user/';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const GRAPH_API_VERSION = 'v20.0';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

const sendMessage = async (to, text) => {
  if (process.env.NODE_ENV === 'test') {
    // Mock para teste: Loga a mensagem e emite via Socket.IO em vez de enviar real
    console.log(`[Test Mode] Simulando envio para ${to}: "${text}"`);
    global.io.emit('bot_message', { contact: to, text }); // Use global.io
    return;
  }

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
};

const criarUsuarioDjango = async (contato) => {
  try {
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
      if (process.env.NODE_ENV === 'test') {
        // Fallback para fake se API falhar no test
        estadoContatos[contato].credenciais = {
          username: 'testuser@example.com',
          password: 'testpass123',
          link: 'https://example.com/login'
        };
        console.log(`[${contato}] [Test Mode] Usando credenciais fake após falha na API`);
      }
    }
  } catch (error) {
    console.error(`[${contato}] Erro na API Django: ${error.message}`);
    if (process.env.NODE_ENV === 'test') {
      // Fallback para fake em erro no test
      estadoContatos[contato].credenciais = {
        username: 'testuser@example.com',
        password: 'testpass123',
        link: 'https://example.com/login'
      };
      console.log(`[${contato}] [Test Mode] Usando credenciais fake devido a erro na API`);
    }
  }
};

const gerarResposta = async (messages, max_tokens = 60) => {
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
};

module.exports = {
  sendMessage,
  criarUsuarioDjango,
  gerarResposta
};