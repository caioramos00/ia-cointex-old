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

const promptClassificaPronto = (contexto) => `
Analise TODAS as respostas do lead após pedir para alterar os dados da conta ou conectar o Facebook e mandar "PRONTO":

"${contexto}"

Responda com só UMA destas opções:
- "pronto" (se ele indicou que concluiu a alteração ou conexão, como "pronto", "feito", "alterei", "mudei", "conectei", "entrei", "foi", "conectei o fb", "tudo certo", "já mudei os dados", "conectado", "alterado", "ok pronto", ou qualquer variação que confirme a ação)
- "nao_pronto" (se ele disse que não conseguiu alterar ou conectar, como "não consegui", "não tenho facebook", "não alterou", "deu erro", "não tem opção", etc)
- "duvida" (se ele perguntou algo tipo "como altera o nome?", "onde clica em conta?", "o que é ID?", "preciso mudar tudo?", "como conecta o fb?", etc)
- "neutro" (se ele falou algo afirmativo como "beleza", "tá bom", "certo", "ok", "entendi", "vou fazer", "slk", ou algo irrelevante como "Próximo?" que não confirma, nega ou questiona)

Considere variações em português brasileiro, incluindo abreviações, gírias e erros de digitação comuns (ex.: "prontoo", "feitu", "conectey"). Nunca explique nada. Só escreva uma dessas palavras.
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
Você é um **CLASSIFICADOR BINÁRIO de opt-out**.

Entrada:
- Você receberá UM OU MAIS trechos de mensagens do usuário, na ordem em que chegaram, separados por " | ".
- Considere o CONJUNTO como um todo, dando PESO MAIOR às mensagens MAIS RECENTES.

Objetivo:
- Decidir se há um pedido explícito para PARAR de receber mensagens (opt-out) OU se há ACUSAÇÃO/SUSPEITA de golpe/engano/falsidade que indique rejeição hostil ao contato. Em ambos os casos → OPTOUT.

Princípios (em ordem):
1) Normalize mentalmente: minúsculas, sem acentos; ignore emojis/URLs/hashtags/ruído.
2) Pedido explícito de parar (ex.: parar, pare, para, stop, unsubscribe, remover, tirar da lista, cancelar, sair, bloquear) → OPTOUT.
3) Ameaça/denúncia/autoridades (ex.: denunciar, polícia, procon, advogado, golpe, fraude, crime, scam, spam) → OPTOUT.
4) Acusação/suspeita de ENGANO/FAKE/GOLPE mesmo sem “pare” → OPTOUT.
   - Gatilhos PT (indicativos, não exaustivos): enganar, enrolar, passar a perna, papo furado, truque, armadilha, golpe, picaretagem, fraude, piramide, esquema, treta, fake, fakezada, falso, mentira, forjado, “isso não cola”, enganação, “já vi isso antes” (quando implica golpe), “isso é fake?”, “tá tentando me enganar?”.
   - EN: scam, fraud, fake, phishing, shady, trick, rip-off, bogus.
   - ES: estafa, fraude, timo, engaño, trampa, falso.
5) Recusa momentânea, dúvida neutra ou curiosidade (ex.: “agora não”, “depois vejo”, “é real?”, “tem garantia?”) SEM acusação/ameaça → CONTINUAR.
6) Conflito: prevalece a rejeição/ameaça/acusação MAIS RECENTE → OPTOUT.
7) Segurança primeiro: EM CASO DE DÚVIDA real, devolva OPTOUT.

FORMATO DE SAÍDA (obrigatório, somente JSON):
{"label":"OPTOUT"} ou {"label":"CONTINUAR"}

Exemplos rápidos (→ saída):
"pare" → {"label":"OPTOUT"}
"stop" → {"label":"OPTOUT"}
"me tira da lista" → {"label":"OPTOUT"}
"isso é golpe" → {"label":"OPTOUT"}
"já vi isso antes, papo furado" → {"label":"OPTOUT"}
"tá tentando me enganar?" → {"label":"OPTOUT"}
"isso não é fakezada não?" → {"label":"OPTOUT"}
"agora não" → {"label":"CONTINUAR"}
"depois eu vejo" → {"label":"CONTINUAR"}

Mensagens do usuário (separadas por " | "):
${texto}

Saída apenas em JSON:`;
}

function promptClassificaReoptin(texto) {
  return `
Tarefa: Dizer se o usuário está RETOMANDO/ACEITANDO continuar a conversa (re-opt-in).

Entrada:
- Você receberá ATÉ 3 mensagens, separadas por " | ", na ordem em que chegaram.
- Dê peso MAIOR à MENSAGEM MAIS RECENTE.

Rótulos:
- optin      → há intenção CLARA de continuar/retomar/aceitar (ex.: "bora", "pode continuar", "pode mandar", "segue", "vamos", "manda", "ok pode mandar", "pode falar", "pode prosseguir", "quero sim", "sim" quando indica aceite, "fechou", "tô dentro", "topo", "aceito", "retoma", "prossegue", "pode enviar", "continua", etc.). Considere variações/gírias/erros.
- nao_optin  → qualquer outra coisa (neutra, dúvida, recusa, silêncio). "ok", "blz", "entendi" SOZINHOS não contam como aceite.

Regras:
1) Avalie o conjunto; prevalece a intenção da ÚLTIMA mensagem quando houver conflito.
2) Seja conservador: só marque optin se estiver CLARO.
3) Responda SOMENTE em JSON válido.

FORMATO DE SAÍDA:
{"label":"optin"} ou {"label":"nao_optin"}

Mensagens do usuário (separadas por " | "):
${texto}

Saída apenas em JSON:`;
}

module.exports = { promptClassificaAceite, promptClassificaAcesso, promptClassificaPronto, promptClassificaRelevancia, promptClassificaOptOut, promptClassificaReoptin };
