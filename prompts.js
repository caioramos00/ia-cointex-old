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

const mensagemImpulso = `só ignora o nome desse WhatsApp aqui, é que eu to usando esse número pra fazer outro trampo aqui também
vamo lá então, como já te disse, eu to fazendo vários trampos ao mesmo tempo aqui, tá bem corrido
então vou ser bem direto e falar só o necessário, e você vai me respondendo só o que eu te perguntar, pode ser?`;

const mensagensIntrodutorias = [
  [
    'antes de mais nada, já salva meu contato, pode salvar como "Ryan"',
    'antes de mais nada, já deixa meu contato salvo aí, pode salvar como "Ryan"',
    'antes de mais nada, já me adiciona aí nos seus contatos, pode salvar como "Ryan"',
  ],
  [
    'pq se aparecer mais um trampo, eu já passo pra você',
    'porque se aparecer mais um trampo hoje eu já te passo',
    'se aparecer mais um trampo hoje, você já faz também',
  ],
];

const checklistVariacoes = [
  // (0) Pré-requisito (PIX ativo)
  [
    'você precisa ter uma conta com pix ativo pra receber o dinheiro',
    'você tem que ter uma conta com pix ativo pra receber o dinheiro',
    'você precisa de uma conta com pix ativo pra receber o dinheiro',
  ],

  // (1) Banco
  [
    'pode ser qualquer banco, físico ou digital, tanto faz',
    'pode ser banco físico ou digital, tanto faz',
    'pode ser qualquer tipo de banco, físico ou digital',
  ],

  // (2) Conexão (inalterado)
  [
    'se tiver como, desativa o wi-fi e ativa só os dados móveis',
    'se der, desativa o wi-fi e ativa os dados móveis',
    'se conseguir, desliga o wi-fi e liga os dados móveis',
    'se puder, desliga o wi-fi e liga o 5g',
  ],

  // (3) Acesso (credenciais)
  [
    'vou te passar o email e a senha de uma conta pra você entrar',
    'vou te passar o email e a senha de uma conta pra você acessar',
    'vou te passar o email e a senha de uma conta pra vc entrar',
  ],

  // (4) Bloco final (sem "reforço")
  [
    // Saque
    [
      'vc vai sacar R$ 5000 dessa conta pra sua conta de recebimento',
      'vc vai sacar R$ 5000 dessa conta pra sua conta de recebimento',
      'vc vai sacar R$ 5000 do saldo disponível lá pra sua conta bancária',
    ],
    // Parte / repasse
    [
      'sua parte vai ser R$ 2000 nesse trampo, e vc vai mandar o restante pra gente assim que cair',
      'sua parte nesse trampo é de R$ 2000, manda o restante pra minha conta assim que cair',
      'vc fica com R$ 2000 desse trampo, o resto manda pra gente assim que cair',
      'sua parte é R$ 2000, o restante manda pra minha conta logo que cair',
    ],
  ],
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

function promptClassificaOptOut(texto) {
  return `
Tarefa: Classifique se o usuário pediu explicitamente para PARAR de receber mensagens (opt-out definitivo).

Responda APENAS com UMA palavra:
- OPTOUT  → quando houver pedido claro para parar, bloquear, remover, cancelar, sair, "não me chame", "não quero", "pare", "stop", "unsubscribe", "remova", "me tira", "excluir", etc., inclusive variações em pt/en, com gírias e abreviações.
- CONTINUAR → quando for só recusa momentânea ("agora não", "talvez depois"), dúvida, silêncio, ou qualquer outra coisa que NÃO seja pedido claro de parar.

Exemplos (→ saída):
"não quero" → OPTOUT
"não quero mais" → OPTOUT
"não quero mais mensagem" → OPTOUT
"pare de me mandar msg" → OPTOUT
"remove meu número" → OPTOUT
"stop" → OPTOUT
"apaga" → OPTOUT
"unsubscribe" → OPTOUT
"não dá ruim pra mim?" → OPTOUT
"tenho medo" → OPTOUT
"to com medo" → OPTOUT
"medo" → OPTOUT
"vai dar ruim pra mim" → OPTOUT
"polícia" → OPTOUT
"chamar a polícia" → OPTOUT
"federal" → OPTOUT
"civil" → OPTOUT
"funil" → OPTOUT
"clonou" → OPTOUT
"bot" → OPTOUT
"mensagem automática" → OPTOUT
"denunciar" → OPTOUT
"denúncia" → OPTOUT
"crime" → OPTOUT
"isso é errado" → OPTOUT
"não me chame mais" → OPTOUT
"não vou fazer isso" → OPTOUT
"to esperando até hoje" → OPTOUT
"de novo isso?" → OPTOUT
"você de novo?" → OPTOUT
"golpe" → OPTOUT
"já caí nesse golpe" → OPTOUT
"não posso agora" → CONTINUAR
"depois eu vejo" → CONTINUAR
"quem é?" → CONTINUAR
"não" (sem pedir para parar) → CONTINUAR

Texto do usuário:
${texto}
Saída:`;
};

function promptClassificaReoptin(texto) {
  return `
Tarefa: Classifique se a última mensagem do usuário indica RETOMAR/CONTINUAR a conversa.

Responda APENAS com UMA palavra:
- REOPTIN  → quando houver intenção clara de continuar/retomar/aceitar (“bora”, “pode continuar”, “pode seguir”, “pode mandar”, “mudei de ideia”, “segue”, “vamos”, “manda”, “ok pode mandar”, “retoma”, “pode falar”, “pode prosseguir”, “quero sim”, “sim”, “fechou”, “vamo”, “manda aí”, “pode ir”, “toca”, “vai”, “continua”, “voltei”, “pode enviar”, “prossegue”, “segue o baile”, “marcha”, “tô dentro”, “topo”, “aceito”, “faço sim”, beleza então”, etc.). Considere variações/gírias/erros.
- CONTINUAR → qualquer outra coisa que NÃO seja um convite claro para retomar (respostas neutras como “ok”, “entendi”, “?”, “hum” sem contexto de aceite; dúvidas; recusas).

Exemplos (→ saída):
"bora" → REOPTIN
"pode continuar" → REOPTIN
"pode mandar" → REOPTIN
"segue" → REOPTIN
"vamos" → REOPTIN
"ok" → CONTINUAR
"?" → CONTINUAR
"talvez" → CONTINUAR

Texto do usuário:
${texto}
Saída:`;
}

module.exports = { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia, mensagemImpulso, mensagensIntrodutoras, checklistVariacoes, mensagensPosChecklist, respostasNaoConfirmadoAcesso, respostasNaoConfirmadoConfirmacao, respostasDuvidasComuns, promptClassificaOptOut, promptClassificaReoptin };
