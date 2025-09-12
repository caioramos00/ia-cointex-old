const axios = require('axios');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_API_URL = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

const { atualizarContato } = require('./db.js');
const estadoContatos = require('./state.js');
const { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia, mensagemImpulso, mensagensIntrodutorias, checklistVariacoes, mensagensPosChecklist, respostasNaoConfirmadoAcesso, respostasNaoConfirmadoConfirmacao, respostasDuvidasComuns } = require('./prompts.js');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function quebradizarTexto(resposta) {
  return resposta.replace(/\b(você|vcê|cê|ce)\b/gi, 'vc');
}

function gerarSenhaAleatoria() {
  return Math.floor(1000 + Math.random() * 9000).toString();
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

function inicializarEstado(contato, tid = '', click_type = 'Orgânico') {
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
    aguardandoPrint: false,
    tid: tid,
    click_type: click_type
  };
  atualizarContato(contato, 'Sim', 'abertura');
  console.log(`[${contato}] Estado inicializado e contato atualizado: Sim, abertura. TID: ${tid}, click_type: ${click_type}`);
}

async function criarUsuarioDjango(contato) {
  try {
    const DJANGO_API_URL = process.env.DJANGO_API_URL || 'https://www.cointex.cash/api/create-user/';
    const estado = estadoContatos[contato];
    const tid = estado.tid || '';
    const click_type = estado.click_type || 'Orgânico';
    console.log(`[${contato}] Enviando para API Cointex: tid=${tid}, click_type=${click_type}`);
    const response = await axios.post(DJANGO_API_URL, { tid, click_type });
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
        const grupo1 = ['salve', 'e aí', 'eae'];
        const grupo2 = ['tô precisando de um lara pra agora', 'preciso de um lara pra agora', 'preciso de lara agora', 'tô precisando de lara agora'];
        const grupo3 = ['tá disponível?', 'vai poder fazer o trampo?', 'vai poder fazer o trampo agora?', 'bora fazer esse trampo agora?', 'vamos fazer esse trampo agora?'];
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
      const grupo1 = ['salve', 'e aí', 'eae'];
      const grupo2 = ['tô precisando de um lara pra agora', 'preciso de um lara pra agora', 'preciso de lara agora', 'tô precisando de lara agora'];
      const grupo3 = ['tá disponível?', 'vai poder fazer o trampo?', 'vai poder fazer o trampo agora?', 'bora fazer esse trampo agora?', 'vamos fazer esse trampo agora?'];
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

module.exports = { delay, gerarResposta, quebradizarTexto, enviarLinhaPorLinha, inicializarEstado, criarUsuarioDjango, processarMensagensPendentes, sendMessage, gerarSenhaAleatoria, gerarBlocoInstrucoes };
