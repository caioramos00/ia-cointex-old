const promptClassificaAceite = (contexto) => `
Analise TODAS as respostas do lead após ser convidado pra fazer o trampo:
"${contexto}"

Responda com só UMA destas opções:
- "aceite" (se ele falou qualquer coisa que indique concordância ou entusiasmo, como "sim", "bora", "to on", "vambora", "vamos", "fechado", "claro", "quero sim", "bora pra cima", "beleza", "ok", "certo", etc)
- "recusa" (se ele falou algo que indique recusa, como "não", "tô fora", "não quero", "não posso", "depois", "agora não", "não rola")
- "duvida" (se ele perguntou algo ou demonstrou dúvida, como "como funciona", "é seguro", "que trampo é esse", "demora", "qual valor", etc)

Considere o contexto e variações coloquiais comuns em português brasileiro. Nunca explique nada. Só escreva uma dessas palavras.
  `;

const promptClassificaAcesso = (contexto) => `
Analise TODAS as respostas do lead após pedir para ele entrar na conta e responder com "ENTREI":
"${contexto}"

Responda com só UMA destas opções:
- "confirmado" (se ele indicou que conseguiu entrar na conta, como "ENTREI", "entrei", "tô dentro", "já tô dentro", "acessei", "já acessei", "entrei sim", "entrei agora", "entrei mano", "entrei irmão", "foi", "deu bom", "acabei de entrar", "loguei", "tô logado", "consegui entrar", "sim eu acessei", ou qualquer variação coloquial que indique sucesso no login)
- "nao_confirmado" (se ele indicou que não conseguiu entrar, como "não entrou", "deu erro", "não consegui", "não deu", "tô fora", "não posso", "não quero", "deu ruim", ou qualquer variação que indique falha no login)
- "duvida" (se ele fez uma pergunta sobre o processo, como "onde coloco o usuário?", "o link não abre", "qual senha?", "qual é o link?", "como entro?", ou qualquer dúvida relacionada ao login)
- "neutro" (se ele falou algo afirmativo ou irrelevante que não indica sucesso, falha ou dúvida, como "beleza", "tá bom", "certo", "fechou", "ok", "entendi", "vou fazer", "slk", "blza", "boa", ou qualquer resposta genérica sem relação direta com o login)

Considere o contexto e variações coloquiais comuns em português brasileiro. Nunca explique nada. Só escreva uma dessas palavras.
  `;

const promptClassificaConfirmacao = (contexto) => `
Analise TODAS as respostas do lead após pedir o valor disponível em FINANCEIRO:
"${contexto}"

Responda com só UMA destas opções:
- "confirmado" (se ele enviou um valor em texto, como "R$ 5000", "5000", "5.000,00", "5K", "5,8k", "R$5.876,41", "$5876,41", "5876,41", "5.876,41", ou qualquer formato numérico que represente um valor monetário maior ou igual a 4000)
- "nao_confirmado" (se ele não enviou um valor em texto ou disse que não conseguiu, como "não achei", "não tem valor", etc)
- "duvida" (se ele perguntou algo tipo "onde tá FINANCEIRO", "qual valor mando", "como vejo o valor", etc)
- "neutro" (se ele falou algo afirmativo como "beleza", "tá bom", "certo", "fechou", "ok", "entendi", "vou fazer", "slk", ou algo irrelevante como "Próximo passo?" que não confirma, nega ou questiona)

Considere variações de formato monetário em português brasileiro, com ou sem "R$" ou "$", com ponto ou vírgula como separador, e com "k" para milhares (ex.: "5.8k" = 5800). Nunca explique nada. Só escreva uma dessas palavras.
  `;

const promptClassificaRelevancia = (mensagensTexto, temMidia) => `
Analise TODAS as respostas do lead após pedir para ele sacar o valor e avisar quando cair:\n"${mensagensTexto}"\n\nConsidere se a mensagem contém referências a:\n- Problema (ex.: "deu problema", "tá com problema", "não funcionou")\n- Taxa (ex.: "tem taxa?", "cobrou taxa")\n- Dúvida (ex.: "como faço?", "o que é isso?", "onde clico?", "ué", "apareceu um negócio")\n- Validação (ex.: "confirma isso?", "precisa validar?", "validação", "pediu validação", "pediu verificar", "pediu")\n- Negócio (ex.: "qual é o negócio?", "que trampo é esse?")\n- Valor a pagar (ex.: "quanto pago?", "tem custo?")\n- Tela (ex.: "na tela aparece isso", "qual tela?")\n- Erro (ex.: "deu erro", "não funcionou")\n- Print (ex.: "te mandei o print", "é um print")\n- Ou se a mensagem é uma mídia (como imagem, vídeo, documento, etc.): ${temMidia ? 'sim' : 'não'}\n\nIgnorar como irrelevante se a mensagem for uma afirmação ou confiança (ex.: "confia irmão", "sou seu sócio agora", "vc vai ver que sou suave", "sou lara do 7", "tô na confiança", "beleza", "tamo junto", "vou mandar", "certo", "calma aí", "e aí?").\n\nResponda com só UMA destas opções:\n- "relevante" (se a mensagem contém qualquer um dos critérios acima ou é uma mídia)\n- "irrelevante" (se a mensagem não contém nenhum dos critérios e não é uma mídia, incluindo afirmações ou confiança)\n\nNunca explique nada. Só escreva uma dessas palavras.\n`;

const mensagemImpulso = `é o seguinte
eu to fazendo vários trampos ao mesmo tempo aqui, tá bem corrido
então vou ser bem direto e falar só o necessário, e você vai me respondendo só o que eu te perguntar, pode ser?`;

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

module.exports = { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia, mensagemImpulso, mensagensIntrodutorias, checklistVariacoes, mensagensPosChecklist, respostasNaoConfirmadoAcesso, respostasNaoConfirmadoConfirmacao, respostasDuvidasComuns };
