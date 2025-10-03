const promptClassificaAceite = (contexto) => `
Você é um classificador de intenções. Analise TODAS as respostas do lead após ser convidado para fazer o trampo:
"${contexto}"

REGRAS GERAIS (aplique todas):
1) Ignore caixa, acentos, emojis, pontuação e alongamentos de letras (ex.: "boraaa", "siiim", "okeeey" ≈ "bora", "sim", "ok").
2) Classifique como ACEITE se a frase CONTÉM alguma expressão de aceite, mesmo acompanhada de outras palavras (ex.: "bora irmão", "pode ser sim", "fechou então").
3) Se houver negação explícita (não/nao/n) até 3 palavras de distância de um termo de aceite (antes ou depois), classifique como RECUSA (ex.: "agora não", "não bora", "bora não").
4) Se houver aceite + pergunta/dúvida na mesma fala, priorize ACEITE.
5) Considere gírias/abreviações comuns do PT-BR.

VOCABULÁRIO ORIENTATIVO (não exaustivo):
• ACEITE (qualquer variação/elongação):
  "sim", "s", "claro", "quero sim", "certo", "ss",
  "bora", "boraaa", "vamo", "vamos", "vambora", "partiu",
  "pra cima", "bora pra cima", "agora",
  "to dentro", "tô dentro", "to on",
  "fechado", "fechou",
  "ok", "okay", "okey", "oki", "okok", "certo", "beleza", "bele", "blz", "suave", "show",
  "firmeza", "fmz",
  "pode ser", "pode pa", "pdp",
  "demoro", "demorou",
  "cuida"
• RECUSA (exemplos):
  "não", "nao", "n", "tô fora", "to fora", "não quero", "não posso",
  "depois", "mais tarde", "agora não", "não rola", "sem chance"
• DÚVIDA (exemplos):
  "como funciona", "é seguro", "que trampo é esse", "qual valor", "onde", "quando", "link", "ajuda?"

Responda com só UMA palavra, exatamente uma destas:
- "aceite"
- "recusa"
- "duvida"
`;

const promptClassificaAcesso = (contexto) => `
Analise TODAS as respostas do lead após pedir para ele entrar na conta e responder com "ENTREI":
"${contexto}"

Responda com só UMA destas opções:
- "confirmado" (se ele indicou que conseguiu entrar na conta, como "ENTREI", "entrei", "tô dentro", "já tô dentro", "acessei", "já acessei", "entrei sim", "entrei agora", "entrei mano", "entrei irmão", "foi", "deu bom", "acabei de entrar", "loguei", "tô logado", "consegui entrar", "sim eu acessei", ou qualquer variação coloquial que indique sucesso no login)
- "nao_confirmado" (se ele indicou que não conseguiu entrar, como "não entrou", "deu erro", "não consegui", "não deu", "tô fora", "não posso", "não quero", "deu ruim", ou qualquer variação que indique falha no login)
- "duvida" (se ele fez uma pergunta sobre o processo, como "onde coloco o usuário?", "o link não abre", "qual é o link?", "como entro?", ou qualquer dúvida relacionada ao login)
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
  Analise TODAS as respostas do lead após pedir para ele sacar o valor e avisar quando cair:
  "${mensagensTexto}"

  Considere se a mensagem contém referências a:
  - Problema (ex.: "deu problema", "tá com problema", "não funcionou")
  - Taxa (ex.: "tem taxa?", "cobrou taxa")
  - Dúvida (ex.: "como faço?", "o que é isso?", "onde clico?", "ué", "apareceu um negócio")
  - Validação (ex.: "confirma isso?", "precisa validar?", "validação", "pediu validação", "pediu verificar", "pediu")
  - Negócio (ex.: "qual é o negócio?", "que trampo é esse?")
  - Valor a pagar (ex.: "quanto pago?", "tem custo?")
  - Tela (ex.: "na tela aparece isso", "qual tela?")
  - Erro (ex.: "deu erro", "não funcionou")
  - Print (ex.: "te mandei o print", "é um print")
  - Ou se a mensagem é uma mídia (como imagem, vídeo, documento, etc.): ${temMidia ? 'sim' : 'não'}

  Ignorar como irrelevante se a mensagem for uma afirmação ou confiança (ex.: "confia irmão", "sou seu sócio agora", "vc vai ver que sou suave", "sou lara do 7", "tô na confiança", "beleza", "tamo junto", "vou mandar", "certo", "calma aí", "e aí?").\n\nResponda com só UMA destas opções:\n- "relevante" (se a mensagem contém qualquer um dos critérios acima ou é uma mídia)\n- "irrelevante" (se a mensagem não contém nenhum dos critérios e não é uma mídia, incluindo afirmações ou confiança)\n\nNunca explique nada. Só escreva uma dessas palavras.
  `;

function promptClassificaOptOut(texto) {
  return `
Você é um CLASSIFICADOR BINÁRIO. Decida se a mensagem do usuário é um pedido explícito para PARAR de receber mensagens. 
Responda **somente** com uma das palavras abaixo (sem pontuação, sem frases, sem espaços extras).
Priorize segurança: em caso de dúvida ou conflito entre sinais, devolva **OPTOUT**.

REGRAS DE AVALIAÇÃO (siga em ordem):
1) Normalize mentalmente: minúsculas, sem acentos, ignore emojis, hashtags, URLs e ruído.
2) Se houver um pedido explícito para parar, bloquear, excluir, remover, cancelar, sair, **ou** menções de denúncia/polícia/golpe/crime → **OPTOUT**.
3) Se for apenas recusa momentânea (ex.: “agora não”, “depois”), dúvida, perguntas gerais, silêncio, mídia sem texto → **CONTINUAR**.
4) Em mensagens com múltiplas frases, foque na intenção dominante do **trecho mais recente e assertivo**.
5) Se houver tanto aceite quanto rejeição/ameaça (“vou querer sim … é golpe / polícia”), a rejeição prevalece → **OPTOUT**.
6) Considere variações, gírias e abreviações em PT/EN/ES (ex.: “pare”, “para”, “parar”, “remove”, “unsubscribe”, “stop”, “block”, “spam”).
7) Não explique nada. **Apenas o rótulo**.

Saídas válidas (uma palavra):
- OPTOUT  → quando houver pedido claro para parar, bloquear, remover, cancelar, sair, "não me chame", "não quero", "pare", "stop", "unsubscribe", "remova", "me tira", "excluir", etc., inclusive variações em pt/en, com gírias e abreviações; também quando citar “golpe”, “polícia”, “denunciar”, “crime”, “processo”, “advogado”, etc.
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
"acho que não vou querer mais" → OPTOUT
"acho que não quero mais" → OPTOUT
"não quero mais não" → OPTOUT
"já caí nesse golpe" → OPTOUT
"não posso agora" → CONTINUAR
"depois eu vejo" → CONTINUAR
"quem é?" → CONTINUAR
"não" (sem pedir para parar) → CONTINUAR

Exemplos adicionais (reforço; não substituem os anteriores):
"para com isso" → OPTOUT
"me tira da lista" → OPTOUT
"excluir meu contato" → OPTOUT
"bloquearam?" (apenas pergunta) → CONTINUAR
"talvez depois" → CONTINUAR
"tá me spamando" → OPTOUT
"isso é fraude" → OPTOUT
"vou denunciar" → OPTOUT
"vou falar com meu advogado" → OPTOUT
"não manda mais nada" → OPTOUT
"só curiosidade, como funciona?" → CONTINUAR

Texto do usuário:
${texto}
Saída:`;
}

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

module.exports = { promptClassificaAceite, promptClassificaAcesso, promptClassificaConfirmacao, promptClassificaRelevancia, promptClassificaOptOut, promptClassificaReoptin };
