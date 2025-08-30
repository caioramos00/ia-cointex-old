const fs = require('fs').promises;
const lockfile = require('proper-lockfile');

// Constants for message variations
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

// Utility functions
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const quebradizarTexto = (resposta) => {
  return resposta.replace(/\b(você|vcê|cê|ce)\b/gi, 'vc');
};

const gerarSenhaAleatoria = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

const gerarBlocoInstrucoes = () => {
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
};

const escreverArquivoComLock = async (caminho, dados) => {
  try {
    const release = await lockfile.lock(caminho, { retries: { retries: 5, minTimeout: 100 } });
    try {
      await fs.writeFile(caminho, JSON.stringify(dados, null, 2));
      console.log(`[Arquivo] Escrito com sucesso: ${caminho}`);
    } finally {
      await release();
    }
  } catch (error) {
    console.error(`[Erro] Falha ao escrever arquivo ${caminho}: ${error.message}`);
    throw error;
  }
};

module.exports = {
  delay,
  quebradizarTexto,
  gerarSenhaAleatoria,
  gerarBlocoInstrucoes,
  escreverArquivoComLock,
  mensagensIntrodutorias,
  checklistVariacoes,
  mensagensPosChecklist,
  respostasNaoConfirmadoAcesso,
  respostasNaoConfirmadoConfirmacao,
  respostasDuvidasComuns
};