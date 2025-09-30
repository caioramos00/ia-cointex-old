        if (estado.etapa === 'interesse') {
            console.log("[" + contato + "] Etapa 'interesse'");

            if (estado.interesseSequenciada) {
                console.log(`[${contato}] Interesse: já enviando, pulando.`);
                return;
            }

            if (!estado.interesseEnviado) {
                estado.interesseSequenciada = true;
                try {
                    const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                    await delay(7000 + Math.floor(Math.random() * 6000));
                    const g1 = [
                        'to bem corrido aqui',
                        'tô na correria aqui',
                        'tô na correria agora',
                        'tô bem corrido agora',
                        'to sem muito tempo aqui',
                        'tô sem muito tempo aqui',
                        'tô sem muito tempo agora',
                        'to sem tempo aqui',
                        'tô sem tempo aqui',
                        'tô sem tempo agora',
                        'to na maior correria aqui',
                        'tô na maior correria aqui',
                        'tô na maior correria agora',
                        'to na maior correria agora',
                        'to meio sem tempo aqui',
                        'tô meio sem tempo aqui',
                        'tô meio sem tempo agora',
                        'to meio corrido aqui'
                    ];
                    const g2 = [
                        'fazendo vários ao mesmo tempo',
                        'fazendo vários trampos ao mesmo tempo',
                        'fazendo vários trampo ao mesmo tempo',
                        'fazendo vários trampos juntos',
                        'fazendo vários trampo juntos',
                        'fazendo vários trampos',
                        'fazendo vários trampo',
                        'fazendo muitos trampos ao mesmo tempo',
                        'fazendo muitos trampo ao mesmo tempo',
                        'fazendo muitos trampos juntos',
                        'fazendo muitos trampo juntos',
                        'fazendo muitos trampos',
                        'fazendo muitos trampo',
                        'fazendo muito trampo',
                        'fazendo muito trampo ao mesmo tempo',
                        'fazendo muito trampo juntos',
                        'fazendo muito trampo agora'
                    ];
                    const g3 = [
                        'vou te mandando tudo o que você tem que fazer',
                        'vou te mandando tudo que você tem que fazer',
                        'vou te mandando tudo o que precisa fazer',
                        'vou te mandando tudo que precisa fazer',
                        'vou te mandando o que você tem que fazer',
                        'vou te mandando o que precisa fazer',
                        'vou te mandando o que você precisa fazer',
                        'vou te mandando o que você tem que fazer',
                        'vou ir te mandando tudo o que você tem que fazer',
                        'vou ir te mandando tudo que você tem que fazer',
                        'vou ir te mandando tudo o que precisa fazer',
                        'vou ir te mandando tudo que precisa fazer',
                        'vou ir te mandando o que você tem que fazer',
                        'vou ir te mandando o que precisa fazer',
                        'vou ir te mandando o que você precisa fazer',
                        'vou ir te mandando o que você tem que fazer',
                        'vou te falar tudo o que você tem que fazer',
                        'vou te falar tudo que você tem que fazer',
                        'vou te falar tudo o que precisa fazer',
                        'vou te falar tudo que precisa fazer',
                        'vou te falar o que você tem que fazer',
                    ];
                    const g4 = [
                        'e você só responde o que eu te perguntar',
                        'e você só responde o que eu perguntar',
                        'e você só responde o que eu te pedir',
                        'e você só responde o que eu pedir',
                        'e você só responde o que eu for perguntar',
                        'e você só responde o que eu for pedir',
                        'e você só responde o que eu te perguntar',
                        'e você responde só o que eu te perguntar',
                        'e você responde só o que eu perguntar',
                        'e você responde só o que eu te pedir',
                        'e você responde só o que eu pedir',
                        'e você responde só o que eu for perguntar',
                        'e você responde só o que eu for pedir',
                        'e você só fala o que eu te perguntar',
                        'e você só me fala o que eu perguntar',
                        'e você só fala o que eu te pedir',
                        'e você só me fala o que eu pedir',
                        'e você só fala o que eu for perguntar',
                        'e você só me fala o que eu for perguntar',
                        'e você só fala o que eu for pedir',
                        'e você só me fala o que eu for pedir',
                    ];
                    const g5 = [
                        'beleza?',
                        'blz?',
                        'tranquilo?',
                        'demoro?',
                        'dmr?',
                        'certo?',
                        'pode ser?',
                        'entendeu?',
                        'tlgd?',
                    ];

                    estado.interesseEnviado = true;
                    const msgInteresse = `${pick(g1)}, ${pick(g2)}... ${pick(g3)}, ${pick(g4)}, ${pick(g5)}`;
                    const sent = await sendOnce(contato, estado, 'interesse.msg', msgInteresse);
                    if (sent) await atualizarContato(contato, 'Sim', 'interesse', msgInteresse);
                    estado.mensagensPendentes = [];
                    estado.mensagensDesdeSolicitacao = [];
                    return;
                } finally {
                    estado.interesseSequenciada = false;
                }
            }

            if (mensagensPacote.length > 0) {
                const contexto = mensagensPacote.map(m => m.texto).join("\n");
                const classificacao = String(await gerarResposta(
                    [{ role: "system", content: promptClassificaAceite(contexto) }],
                    ["ACEITE", "RECUSA", "DUVIDA"]
                )).toUpperCase();

                console.log(`[${contato}] Resposta em interesse: ${classificacao}`);

                if (classificacao.trim() === "ACEITE") {
                    estado.etapa = 'instruções';
                    estado.primeiraRespostaPendente = false;
                    estado.instrucoesEnviadas = false;
                    estado.instrucoesCompletas = true;
                    await atualizarContato(contato, 'Sim', 'instruções', '[Avanço automático após ACEITE]');
                    return;
                } else {
                    console.log(`[${contato}] Stand-by em 'interesse' (aguardando ACEITE).`);
                    return;
                }
            }
        }

        if (estado.etapa === 'instruções') {
            console.log("[" + contato + "] Etapa 3: instruções");

            if (!estado.instrucoesConcluida) {
                const pick = (arr) =>
                    Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

                const msg1Grupo1 = [
                    'salvou o contato',
                    'salvou o número',
                    'salvou esse número',
                    'salvou esse contato',
                    'já salvou o contato',
                    'já salvou o número',
                    'já salvou esse número',
                    'já salvou esse contato',
                    'já salvou meu contato',
                    'já salvou meu número',
                    'salvou meu contato',
                    'salvou meu número',
                    'salvou o contato aí',
                    'salvou o número aí',
                    'salvou esse número aí',
                    'salvou esse contato aí',
                    'já salvou o contato aí',
                    'já salvou o número aí',
                    'já salvou esse número aí',
                    'já salvou esse contato aí',
                ];
                const msg1Grupo2 = [
                    'salva ai que se aparecer outro trampo mais tarde eu te chamo tambem',
                    'salva aí que se aparecer outro trampo mais tarde eu te chamo também',
                    'salva porque se aparecer outro trampo mais tarde eu te chamo tambem',
                    'salva porque se aparecer outro trampo mais tarde eu te chamo também',
                    'salva pq se aparecer outro trampo mais tarde eu te chamo tambem',
                    'salva pq se aparecer outro trampo mais tarde eu te chamo também',
                    'salva ai que se aparecer outro trampo eu te chamo tambem',
                    'salva aí que se aparecer outro trampo eu te chamo também',
                    'salva porque se aparecer outro trampo eu te chamo tambem',
                    'salva aí que se aparecer outro trampo eu te chamo tb',
                    'salva ai que se aparecer outro trampo eu te chamo tb',
                    'salva porque se aparecer outro trampo eu te chamo tb',
                    'salva pq se aparecer outro trampo eu te chamo tambem',
                    'salva pq se aparecer outro trampo eu te chamo também',
                    'salva pq se aparecer outro trampo eu te chamo tb',
                    'deixa salvo pq se aparecer outro trampo eu te chamo tambem',
                    'deixa salvo pq se aparecer outro trampo eu te chamo também',
                    'deixa salvo que se aparecer outro trampo eu te chamo tambem',
                    'deixa salvo que se aparecer outro trampo eu te chamo também',
                    'deixa salvo pq se aparecer outro trampo mais tarde eu te chamo tambem',
                    'deixa salvo pq se aparecer outro trampo mais tarde eu te chamo também',
                    'deixa salvo que se aparecer outro trampo mais tarde eu te chamo tambem',
                    'deixa salvo que se aparecer outro trampo mais tarde eu te chamo também',
                ];
                const msg1Grupo3 = [
                    'vou te mandar o passo a passo do que precisa pra fazer certinho',
                    'vou te mandar o passo a passo do que precisa pra fazer direitinho',
                    'vou te mandar o passo a passo do que precisa fazer certinho',
                    'vou te mandar o passo a passo do que precisa fazer direitinho',
                    'vou te mandar o passo a passo do que você precisa pra fazer certinho',
                    'vou te mandar o passo a passo do que você precisa pra fazer direitinho',
                    'vou te mandar o passo a passo do que você precisa fazer certinho',
                    'vou mandar o passo a passo do que você precisa fazer direitinho',
                    'vou mandar o passo a passo do que precisa pra fazer certinho',
                    'vou mandar o passo a passo do que precisa pra fazer direitinho',
                    'vou mandar o passo a passo do que precisa fazer certinho',
                    'vou mandar o passo a passo do que precisa fazer direitinho',
                    'agr vou mandar o passo a passo do que precisa pra fazer certinho',
                    'agora vou mandar o passo a passo do que precisa pra fazer certinho',
                    'agr vou mandar o passo a passo do que precisa pra fazer direitinho',
                    'agora vou mandar o passo a passo do que precisa pra fazer direitinho',
                    'vou mandar agora o passo a passo do que precisa pra fazer certinho',
                    'vou mandar agora o passo a passo do que precisa pra fazer direitinho',
                    'agr vou mandar o passo a passo do que precisa fazer certinho',
                    'agora vou mandar o passo a passo do que precisa fazer certinho',
                    'agora vou te mandar o passo a passo do que precisa fazer direitinho',
                    'agr vou mandar o passo a passo do que precisa fazer direitinho',
                    'agr vou te mandar o passo a passo do que precisa fazer direitinho',
                ];
                const instrMsg1 = `${pick(msg1Grupo1)}? ${pick(msg1Grupo2)}… ${pick(msg1Grupo3)}`;

                const pontos1Grupo1 = [
                    'você precisa de uma conta com pix ativo pra receber',
                    'você precisa ter uma conta com pix ativo pra receber',
                    'vc precisa de uma conta com pix ativo pra receber',
                    'vc precisa ter uma conta com pix ativo pra receber',
                    'você vai precisar de uma conta com pix ativo pra receber',
                    'você precisa de uma conta com pix pra receber',
                    'você precisa ter uma conta com pix pra receber',
                    'vc precisa de uma conta com pix pra receber',
                    'vc precisa ter uma conta com pix pra receber',
                    'você vai precisar de uma conta com pix pra receber',
                    'você precisa de uma conta bancária com pix ativo pra receber',
                    'você precisa ter uma conta bancária com pix ativo pra receber',
                    'vc precisa de uma conta bancária com pix ativo pra receber',
                    'vc precisa ter uma conta bancária com pix ativo pra receber',
                    'você vai precisar de uma conta bancária com pix ativo pra receber',
                    'você precisa de uma conta bancária com pix pra receber',
                    'você precisa ter uma conta bancária com pix pra receber',
                    'vc precisa de uma conta bancária com pix pra receber',
                    'vc precisa ter uma conta bancária com pix pra receber',
                    'você vai precisar de uma conta bancária com pix pra receber',
                ];
                const pontos1Grupo2 = [
                    'pode ser qualquer banco',
                    'pode ser qlqr banco',
                    'qualquer banco serve',
                    'qualquer banco',
                    'qlqr banco serve',
                ];
                const pontos1Grupo3 = [
                    'so nao da certo se for o SICOOB',
                    'só não dá certo se for o SICOOB',
                    'só não funciona se for o SICOOB',
                    'so nao funciona se for o SICOOB',
                    'só não dá se for o SICOOB',
                    'so nao da certo se for SICOOB',
                    'só não dá certo se for SICOOB',
                    'só não funciona se for SICOOB',
                    'so nao funciona se for SICOOB',
                    'só não dá se for SICOOB',
                    'so nao da certo se for o WISE',
                    'só não dá certo se for o WISE',
                    'só não funciona se for o WISE',
                    'so nao funciona se for o WISE',
                    'só não dá se for o WISE',
                    'so nao da certo se for WISE',
                    'só não dá certo se for WISE',
                    'só não funciona se for WISE',
                    'so nao funciona se for WISE',
                    'só não dá se for WISE',
                ];

                const pontos2Grupo1 = [
                    'se tiver dados moveis',
                    'se tiver dados móveis',
                    'se tiver 5g',
                    'se tiver 4g',
                    'se tiver dados',
                    'se tiver internet no chip',
                    'se vc tiver dados moveis',
                    'se vc tiver dados móveis',
                    'se vc tiver 5g',
                    'se vc tiver 4g',
                    'se vc tiver dados',
                    'se vc tiver internet no chip',
                    'se você tiver dados moveis',
                    'se você tiver dados móveis',
                    'se você tiver 5g',
                    'se você tiver 4g',
                    'se você tiver dados',
                    'se você tiver internet no chip',
                ];
                const pontos2Grupo2 = [
                    'desativa o wi-fi',
                    'desliga o wi-fi',
                    'desativa o wifi',
                    'desliga o wifi',
                    'tira do wi-fi',
                    'tira do wifi',
                    'deixa desligado o wi-fi',
                    'deixa desligado o wifi',
                    'deixa desativado o wi-fi',
                    'deixa desativado o wifi',
                    'deixa o wi-fi desligado',
                    'deixa o wifi desligado',
                ];
                const pontos2Grupo3 = [
                    'mas se nao tiver deixa no wifi mesmo',
                    'mas se não tiver deixa no wifi mesmo',
                    'mas se nao tiver deixa no wi-fi mesmo',
                    'mas se não tiver deixa no wi-fi mesmo',
                    'mas se nao tiver deixa no wifi',
                    'mas se não tiver deixa no wifi',
                    'mas se nao tiver deixa no wi-fi',
                    'mas se não tiver deixa no wi-fi',
                    'mas se não tiver pode deixar no wifi mesmo',
                    'mas se não tiver pode deixar no wi-fi mesmo',
                    'mas se nao tiver pode deixar no wifi mesmo',
                    'mas se nao tiver pode deixar no wi-fi mesmo',
                    'mas se não tiver usa o wifi mesmo',
                    'mas se não tiver usa o wi-fi mesmo',
                    'mas se nao tiver usa o wifi mesmo',
                    'mas se nao tiver usa o wi-fi mesmo',
                    'mas se não tiver pode deixar no wifi',
                    'mas se não tiver pode deixar no wi-fi',
                    'mas se nao tiver pode deixar no wifi',
                    'mas se nao tiver pode deixar no wi-fi',
                ];

                const pontos3Grupo1 = [
                    'vou passar o email e a senha de uma conta pra você acessar',
                    'vou passar o e-mail e a senha de uma conta pra você acessar',
                    'vou passar o email e a senha de uma conta pra vc acessar',
                    'vou passar o e-mail e a senha de uma conta pra vc acessar',
                    'vou te passar o email e a senha de uma conta pra você acessar',
                    'vou te passar o e-mail e a senha de uma conta pra você acessar',
                    'vou te passar o email e a senha de uma conta pra vc acessar',
                    'vou te passar o e-mail e a senha de uma conta pra vc acessar',
                    'vou passar o email e a senha de uma conta pra você entrar',
                    'vou passar o e-mail e a senha de uma conta pra você entrar',
                    'vou passar o email e a senha de uma conta pra vc entrar',
                    'vou passar o e-mail e a senha de uma conta pra vc entrar',
                    'vou te passar o email e a senha de uma conta pra você entrar',
                    'vou te passar o e-mail e a senha de uma conta pra você entrar',
                ];
                const pontos3Grupo2 = [
                    'lá vai ter um saldo disponível',
                    'lá vai ter um saldo disponivel',
                    'vai ter um saldo disponível lá',
                    'vai ter um saldo disponivel lá',
                    'lá vai ter um dinheiro disponível',
                    'lá vai ter um dinheiro disponivel',
                    'vai ter um dinheiro disponível lá',
                    'vai ter um dinheiro disponivel lá',
                    'lá vai ter uma grana disponível',
                    'lá vai ter uma grana disponivel',
                    'vai ter uma grana disponível lá',
                    'vai ter uma grana disponivel lá',
                    'vai ter um dinheiro disponível pra saque lá',
                    'vai ter um dinheiro disponivel pra saque lá',
                    'lá vai ter um dinheiro disponível pra saque',
                    'lá vai ter um dinheiro disponivel pra saque',
                    'vai ter um saldo disponível pra saque lá',
                    'vai ter um saldo disponivel pra saque lá',
                    'lá vai ter um saldo disponível pra saque',
                    'lá vai ter um saldo disponivel pra saque',
                ];
                const pontos3Grupo3 = [
                    'é só você transferir pra sua conta, mais nada',
                    'é só vc transferir pra sua conta, mais nada',
                    'é só você transferir pra sua conta bancária, mais nada',
                    'é só vc transferir pra sua conta bancária, mais nada',
                    'é só você sacar pra sua conta, mais nada',
                    'é só vc sacar pra sua conta, mais nada',
                    'é só você sacar pra sua conta bancária, mais nada',
                    'é só vc sacar pra sua conta bancária, mais nada',
                    'você só precisa transferir pra sua conta, mais nada',
                    'vc só precisa transferir pra sua conta, mais nada',
                    'é só vc mandar pra sua conta, mais nada',
                    'é só você mandar pra sua conta, e já era',
                    'você só precisa transferir pra sua conta bancária, e já era',
                    'vc só precisa transferir pra sua conta bancária, e já era',
                    'é só vc mandar pra sua conta bancária, e já era',
                    'é só você mandar pra sua conta bancária, e já era',
                    'você só precisa sacar pra sua conta, e já era',
                    'vc só precisa sacar pra sua conta, e já era',
                    'você só precisa sacar pra sua conta bancária, e já era',
                    'vc só precisa sacar pra sua conta bancária, e já era',
                ];

                const pontos4Grupo1 = [
                    'sua parte vai ser 2000',
                    'você vai receber 2000',
                    'sua parte é 2000',
                    'você recebe 2000',
                    'sua parte vai ser 2 mil',
                    'sua parte vai ser 2000',
                    'você vai receber 2 mil',
                    'sua parte é 2 mil',
                    'você recebe 2 mil',
                    'sua parte vai ser dois mil',
                    'você vai receber dois mil',
                    'sua parte é dois mil',
                    'você recebe dois mil',
                    'vc vai receber 2000 pelo trampo',
                    'vc vai receber 2 mil pelo trampo',
                    'vc vai receber dois mil pelo trampo',
                    'sua parte vai ser 2000 pelo trampo',
                    'sua parte vai ser 2 mil pelo trampo',
                    'sua parte vai ser dois mil pelo trampo',
                    'você vai receber 2000 pelo trampo',
                    'você vai receber 2000 nesse trampo',
                    'você vai receber 2 mil pelo trampo',
                    'você vai receber 2 mil nesse trampo',
                    'você vai receber dois mil pelo trampo',
                    'você vai receber dois mil nesse trampo',
                ];
                const pontos4Grupo2 = [
                    'o restante manda pra minha conta logo que cair',
                    'o restante você manda pra minha conta logo que cair',
                    'o restante vc manda pra minha conta logo que cair',
                    'o restante manda pra minha conta assim que cair',
                    'o restante você manda pra minha conta assim que cair',
                    'o restante vc manda pra minha conta assim que cair',
                    'o restante manda pra minha conta quando cair',
                    'o restante você manda pra minha conta quando cair',
                    'o restante vc manda pra minha conta quando cair',
                    'o resto você manda pra minha conta logo que cair',
                    'o resto vc manda pra minha conta logo que cair',
                    'o resto você manda pra minha conta assim que cair',
                    'o resto vc manda pra minha conta assim que cair',
                    'o resto você manda pra minha conta quando cair',
                    'o resto vc manda pra minha conta quando cair',
                    'o resto manda pra minha conta logo que cair',
                    'o que sobrar você manda pra minha conta logo que cair',
                    'o que sobrar vc manda pra minha conta logo que cair',
                    'o que sobrar você manda pra minha conta assim que cair',
                    'o que sobrar vc manda pra minha conta assim que cair',
                    'o que sobrar você manda pra minha conta quando cair',
                    'o que sobrar vc manda pra minha conta quando cair',
                ];
                const pontos4Grupo3 = [
                    'eu vou te passar a chave pix depois',
                    'depois eu te passo a chave pix',
                    'a chave pix eu te passo depois',
                    'eu te passo a chave pix depois',
                    'depois eu passo a chave pix',
                    'a chave pix eu passo depois',
                    'depois eu te passo a chave pix',
                    'depois eu passo a chave pix',
                    'eu vou te passar a chave pix mais tarde',
                    'mais tarde eu te passo a chave pix',
                    'a chave pix eu te passo mais tarde',
                    'eu te passo a chave pix mais tarde',
                    'mais tarde eu passo a chave pix',
                    'a chave pix eu passo mais tarde',
                    'mais tarde eu te passo a chave pix',
                    'mais tarde eu passo a chave pix',
                ];

                const instrMsg2 =
                    `• ${pick(pontos1Grupo1)}, ${pick(pontos1Grupo2)}, ${pick(pontos1Grupo3)}\n\n` +
                    `• ${pick(pontos2Grupo1)}, ${pick(pontos2Grupo2)}, ${pick(pontos2Grupo3)}\n\n` +
                    `• ${pick(pontos3Grupo1)}, ${pick(pontos3Grupo2)}, ${pick(pontos3Grupo3)}\n\n` +
                    `• ${pick(pontos4Grupo1)}, ${pick(pontos4Grupo2)}, ${pick(pontos4Grupo3)}`;

                const msg3Grupo1 = [
                    'é tranquilinho',
                    'é tranquilo',
                    'é bem tranquilo',
                    'é muito tranquilo',
                    'é mt tranquilo',
                    'não tem segredo',
                    'nao tem segredo',
                    'é sem segredo',
                    'não tem erro',
                    'nao tem erro',
                    'é sem erro',
                    'é suave',
                    'é isso',
                    'é só isso',
                    'é só isso mesmo',
                    'é só isso aí',
                    'é só isso msm',
                    'é só isso msm',
                    'é só isso aí msm',
                ];
                const msg3Grupo2 = [
                    'a gente vai fazendo parte por parte pra nao ter erro blz',
                    'a gente vai fazendo parte por parte pra não ter erro blz',
                    'a gente vai fazendo parte por parte pra nao ter erro beleza',
                    'a gente vai fazendo parte por parte pra não ter erro beleza',
                    'a gente vai fazendo parte por parte pra nao ter erro, blz',
                    'a gente vai fazendo parte por parte pra não ter erro, blz',
                    'a gente vai fazendo parte por parte pra nao ter erro, beleza',
                    'a gente vai fazendo parte por parte pra não ter erro, beleza',
                    'a gente vai fazendo parte por parte pra nao ter erro, pode ser',
                    'a gente vai fazendo parte por parte pra não ter erro, pode ser',
                    'a gnt vai fazendo parte por parte pra nao ter erro blz',
                    'a gnt vai fazendo parte por parte pra não ter erro blz',
                    'a gnt vai fazendo parte por parte pra nao ter erro beleza',
                    'a gnt vai fazendo parte por parte pra não ter erro beleza',
                    'a gnt vai fazendo parte por parte pra nao ter erro, blz',
                    'a gnt vai fazendo parte por parte pra não ter erro, blz',
                    'a gnt vai fazendo parte por parte pra nao ter erro, beleza',
                    'a gnt vai fazendo parte por parte pra não ter erro, beleza',
                    'a gnt vai fazendo parte por parte pra nao ter erro, pode ser',
                    'a gnt vai fazendo parte por parte pra não ter erro, pode ser',
                    'a gente faz parte por parte pra nao ter erro blz',
                    'a gente faz parte por parte pra não ter erro blz',
                    'a gente faz parte por parte pra nao ter erro beleza',
                    'a gente faz parte por parte pra não ter erro beleza',
                    'a gente faz parte por parte pra nao ter erro, blz',
                    'a gente faz parte por parte pra não ter erro, blz',
                ];
                const instrMsg3 = `${pick(msg3Grupo1)}… ${pick(msg3Grupo2)}?`;

                if (!estado.instrucoesSequenciada) {
                    estado.instrucoesSequenciada = true;
                    try {
                        if (!estado.instrMsg1Enviada) {
                            estado.instrMsg1Enviada = true;
                            await delay(rand(15000, 25000));
                            await sendMessage(contato, instrMsg1);
                            estado.historico.push({ role: 'assistant', content: instrMsg1 });
                            await atualizarContato(contato, 'Sim', 'instruções', instrMsg1);
                            console.log(`[${contato}] [instruções] Msg1 enviada: ${instrMsg1}`);
                        }

                        if (!estado.instrMsg2Enviada) {
                            estado.instrMsg2Enviada = true;
                            await delay(rand(25000, 35000));
                            await sendMessage(contato, instrMsg2);
                            estado.historico.push({ role: 'assistant', content: instrMsg2 });
                            await atualizarContato(contato, 'Sim', 'instruções', instrMsg2);
                            console.log(`[${contato}] [instruções] Msg2 enviada (bullets únicos)`);
                        }

                        if (!estado.instrMsg3Enviada) {
                            estado.instrMsg3Enviada = true;
                            await delay(rand(8000, 12000));
                            await sendMessage(contato, instrMsg3);
                            estado.historico.push({ role: 'assistant', content: instrMsg3 });
                            await atualizarContato(contato, 'Sim', 'instruções', instrMsg3);
                            console.log(`[${contato}] [instruções] Msg3 enviada: ${instrMsg3}`);
                        }

                        estado.instrucoesConcluida = true;
                        estado.instrucoesEnviadas = true;
                        estado.aguardandoAceiteInstrucoes = true;
                    } catch (e) {
                        console.error(`[${contato}] Erro na sequência de instruções: ${e.message}`);
                    } finally {
                        estado.instrucoesSequenciada = false;
                    }
                }
                return;
            }

            if (mensagensPacote.length > 0) {
                const contexto = mensagensPacote.map(m => m.texto).join("\n");
                const cls = String(await gerarResposta(
                    [{ role: "system", content: promptClassificaAceite(contexto) }],
                    ["ACEITE", "RECUSA", "DUVIDA"]
                )).toUpperCase();

                console.log(`[${contato}] Classificação pós-instruções: ${cls}`);

                if (cls.includes("ACEITE")) {
                    estado.etapa = 'acesso';
                    estado.tentativasAcesso = 0;
                    estado.mensagensDesdeSolicitacao = [];
                    await atualizarContato(contato, 'Sim', 'acesso', '[ACEITE após instruções]');
                    return;
                }
                console.log(`[${contato}] Stand-by em 'instruções' (aguardando ACEITE).`);
                return;
            }

            return;
        }

        if (estado.etapa === 'acesso') {
            console.log("[" + contato + "] Etapa 4: acesso (reformulada)");

            // Helpers locais (case-insensitive + sem acento)
            const norm = (str) => String(str || '')
                .normalize('NFD').replace(/\p{Diacritic}/gu, '')
                .toLowerCase().trim();

            const saidEntered = (s) => {
                const n = norm(s);
                // variações explícitas (inclui as que você citou)
                const hits = [
                    'entrei', 'ja entrei', 'já entrei', 'entrei sim', 'entrei aqui', 'entrou',
                    'consegui', 'logou', 'logei', 'logado', 'to dentro', 'tô dentro', 'pronto',
                    'foi', 'foi aqui', 'ok entrei', 'ok loguei', 'acessei', 'acesso feito',
                    'qual a senha', 'qual a senha?', 'q a senha', 'q a senha?'
                ];
                if (hits.some(x => n.includes(x))) return true;
                // fallback regex curta
                return /\b(entrei|loguei|acessei|consegui|pronto|foi|entrou|to dentro|t[oó] dentro|ok)\b/.test(n);
            };

            // helper p/ disparar imediatamente a primeira DM de confirmação (evita pedir "entrei" 2x)
            const dispararConfirmacaoInicial = async () => {
                const pick = arr => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
                const bloco1 = ['boa', 'boaa', 'boaaa', 'beleza', 'belezaa', 'belezaaa', 'tranquilo', 'isso aí'];
                const bloco2 = [
                    'agora manda um PRINT mostrando o saldo disponível',
                    'agora manda um PRINT mostrando o saldo disponível aí',
                    'agora me manda um PRINT mostrando o saldo disponível nessa conta',
                    'agora me manda um PRINT mostrando o saldo',
                ];
                const bloco3 = [
                    'ou escreve aqui quanto que tem disponível',
                    'ou me escreve o valor',
                    'ou manda o valor em escrito',
                    'ou me fala o valor disponível',
                ];
                const msgConfirmacao = `${pick(bloco1)}, ${pick(bloco2)}, ${pick(bloco3)}`;
                const sent = await sendOnce(contato, estado, 'confirmacao.m1', msgConfirmacao);
                if (sent) {
                    estado.confirmacaoMsgInicialEnviada = true;
                    await atualizarContato(contato, 'Sim', 'confirmacao', msgConfirmacao);
                    estado.confirmacaoDesdeTs = Date.now();
                    estado.mensagensDesdeSolicitacao = [];
                }
            };

            // 1) Garantir credenciais
            if (
                !estado.credenciais ||
                !estado.credenciais.username ||
                !estado.credenciais.password ||
                !estado.credenciais.link
            ) {
                try {
                    await criarUsuarioDjango(contato);
                } catch (e) {
                    console.error(`[${contato}] criarUsuarioDjango falhou: ${e?.message || e}`);
                }
            }

            const cred = estado.credenciais;
            if (!cred || !cred.username || !cred.password || !cred.link) {
                console.log(`[${contato}] Sem credenciais válidas após tentativa; standby em 'acesso'.`);
                return;
            }

            const email = cred.username;
            const senha = cred.password;
            const link = cred.link;

            // 2) Mensagens da etapa
            const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

            const bloco1A = [
                'vou mandar o e-mail e a senha da conta',
                'vou mandar o email e a senha da conta',
                'te mandar o e-mail e a senha da conta',
                'te mandar o email e a senha da conta',
                'esse é o e-mail e a senha da conta',
                'esse é o email e a senha da conta',
                'e-mail e a senha da conta',
                'email e a senha da conta',
            ];
            const bloco2A = [
                'só copia e cola pra não errar',
                'só copia e cola pra não colocar errado',
                'copia e cola pra não errar',
                'copia e cola pra não colocar errado',
                'só copia aqui e cola lá pra não errar',
                'só copia aqui e cola lá pra não colocar errado',
                'copia aqui e cola lá pra não errar',
                'copia aqui e cola lá pra não colocar errado',
            ];
            const bloco3A = ['E-mail', 'Email'];

            const bloco1C = [
                'entra nesse link', 'entra por esse link', 'esse é o link', 'o link é esse',
                'o link é esse aqui', 'segue o link', 'entra no link', 'clica no link',
                'aperta no link', 'só clicar no link'
            ];
            const bloco2C = [
                'entra na conta mas nao mexe em nada ainda',
                'entra na conta mas nao clica em nada ainda',
                'entra na conta mas nao aperta em nada ainda',
                'entra aí na conta mas nao mexe em nada ainda',
                'entra aí na conta mas nao clica em nada ainda',
                'entra aí na conta mas nao aperta em nada ainda',
                'entra aí mas nao mexe em nada ainda',
                'entra aí mas nao clica em nada ainda',
                'entra aí mas nao aperta em nada ainda',
                'entra aí na conta mas não muda nada ainda'
            ];
            const bloco3C = [
                'assim que conseguir acessar me manda um "ENTREI"',
                'assim que acessar me manda um "ENTREI"',
                'assim que conseguir acessar a conta me manda um "ENTREI"',
                'assim que acessar a conta me manda um "ENTREI"',
                'assim que entrar na conta me manda um "ENTREI"',
                'assim que logar na conta me manda um "ENTREI"',
                'assim q conseguir acessar me manda um "ENTREI"',
                'assim q acessar me manda um "ENTREI"',
                'assim q conseguir acessar a conta me manda um "ENTREI"',
                'assim q acessar a conta me manda um "ENTREI"',
                'assim q entrar na conta me manda um "ENTREI"',
                'assim q logar na conta me manda um "ENTREI"',
            ];

            const msg1 = [
                `${pick(bloco1A)}, ${pick(bloco2A)}:`,
                '',
                `${pick(bloco3A)}:`,
                email,
                '',
                'Senha:'
            ].join('\n');

            const msg2 = String(senha);

            const msg3 = [
                `${pick(bloco1C)}:`,
                '',
                link,
                '',
                `${pick(bloco2C)}, ${pick(bloco3C)}`
            ].join('\n');

            // 3) Disparo único da sequência
            if (!estado.acessoMsgsDisparadas) {
                estado.acessoMsgsDisparadas = true;

                if (!estado.acessoMsg1Enviada) {
                    estado.acessoMsg1Enviada = true;
                    await sendOnce(contato, estado, 'acesso.m1', msg1);
                    await atualizarContato(contato, 'Sim', 'acesso', msg1);
                    await delay(rand(6000, 9000));
                }

                if (!estado.acessoMsg2Enviada) {
                    estado.acessoMsg2Enviada = true;
                    await sendOnce(contato, estado, 'acesso.m2', msg2);
                    await atualizarContato(contato, 'Sim', 'acesso', msg2);
                    await delay(rand(7000, 11000));
                }

                if (!estado.acessoMsg3Enviada) {
                    estado.acessoMsg3Enviada = true;
                    await sendOnce(contato, estado, 'acesso.m3', msg3);
                    await atualizarContato(contato, 'Sim', 'acesso', msg3);
                }

                estado.acessoDesdeTs = Date.now();
                estado.credenciaisEntregues = true;
                await atualizarContato(contato, 'Sim', 'acesso', '[Credenciais enviadas]');
                estado.mensagensPendentes = [];
                return;
            } else {
                console.log(`[${contato}] Acesso: sequência já disparada (acessoMsgsDisparadas=true), não reenviando.`);
            }

            // 4) Analisar respostas desde o envio
            const anyTs = mensagensPacote.some(m => tsEmMs(m) !== null);
            const recentes = (!estado.acessoDesdeTs || !anyTs)
                ? mensagensPacote
                : mensagensPacote.filter(m => {
                    const ts = tsEmMs(m);
                    return ts === null || ts >= estado.acessoDesdeTs;
                });

            const respostasTexto = recentes.map(m => m.texto || '').filter(Boolean);

            // (A) Regra determinística ampla (aceita variações)
            if (respostasTexto.some(s => saidEntered(s))) {
                estado.etapa = 'confirmacao';
                estado.mensagensDesdeSolicitacao = [];
                estado.tentativasAcesso = 0;
                estado.confirmacaoMsgInicialEnviada = false;
                await atualizarContato(contato, 'Sim', 'confirmacao', '[Login confirmado — atalho]');
                console.log(`[${contato}] Etapa 5: confirmação — avançou pelo atalho`);

                // >>> Disparar IMEDIATAMENTE a primeira DM de confirmação <<<
                await dispararConfirmacaoInicial();
                return;
            }

            // (B) Classificação via LLM (fallback)
            if (!estado.credenciaisEntregues) {
                console.log(`[${contato}] Acesso: aguardando finalizar envio (credenciaisEntregues=false). Não vou classificar ainda.`);
                return;
            }
            const mensagensTexto = respostasTexto.join('\n').trim();
            if (!mensagensTexto) return;

            const classifyInput = promptClassificaAcesso(mensagensTexto);
            const tipoAcessoRaw = await gerarResposta(
                [{ role: 'system', content: classifyInput }],
                ["CONFIRMADO", "NAO_CONFIRMADO", "DUVIDA", "NEUTRO"]
            );
            const tipoAcesso = String(tipoAcessoRaw).toUpperCase();
            console.log(`[${contato}] acesso> LLM="${tipoAcesso}" novas=${recentes.length} texto="${mensagensTexto.slice(0, 120)}..."`);

            if (tipoAcesso === 'CONFIRMADO') {
                estado.etapa = 'confirmacao';
                estado.mensagensDesdeSolicitacao = [];
                estado.tentativasAcesso = 0;
                estado.confirmacaoMsgInicialEnviada = false;

                await atualizarContato(contato, 'Sim', 'confirmacao', '[Login confirmado — avançando]');
                console.log("[" + contato + "] Etapa 5: confirmação — avançou após CONFIRMADO");

                // >>> Disparar IMEDIATAMENTE a primeira DM de confirmação <<<
                await dispararConfirmacaoInicial();
                return;
            } else {
                console.log(`[${contato}] Acesso aguardando CONFIRMADO. Retorno: ${tipoAcesso}`);
                estado.mensagensPendentes = [];
                return;
            }
        }

        if (estado.etapa === 'confirmacao') {
            console.log("[" + contato + "] Etapa 5: confirmação");

            // ===== Helpers de mídia =====
            const getPossiveisStrings = (m) => {
                if (!m) return [];
                return [
                    m.texto, m.text, m.caption, m.url, m.mediaUrl, m.documentUrl, m.imageUrl, m.videoUrl
                ].filter(Boolean).map(String);
            };

            const looksLikeMediaUrl = (s) => {
                const n = String(s || '');
                const hostCdn = /(many(chat|bot)-files\.s3|s3\.amazonaws\.com|mmg\.whatsapp\.net|cdn\.whatsapp\.net|whatsapp\.net|fbcdn\.net)/i.test(n);
                const extImg = /https?:\/\/[^\s"'<>)]+?\.(?:jpg|jpeg|png|gif|webp|heic|heif|bmp)(?:\?[^\s"'<>)]*)?$/i.test(n);
                return (hostCdn && /(original|file|image|media|attachment)/i.test(n)) || extImg;
            };

            const isMidia = (m) => {
                if (!m) return false;
                if (m.temMidia === true || m.hasMedia === true) return true;
                if (typeof m.type === 'string' && /(image|video|document|sticker)/i.test(m.type)) return true;
                const strs = getPossiveisStrings(m);
                return strs.some(looksLikeMediaUrl);
            };

            // ===== Helpers de valor numérico =====
            const parsePtEnNumber = (raw) => {
                if (!raw) return null;
                let s = String(raw).toLowerCase();

                // normaliza espaços e símbolos de moeda
                s = s.replace(/\s+/g, '').replace(/[r$\u20ac£¥]+/g, '');

                // sufixos "k" e "mil"
                let mult = 1;
                if (/k\b/.test(s)) { mult = 1000; s = s.replace(/k\b/, ''); }
                if (/(^|[^\p{L}])mil\b/iu.test(s)) { mult = 1000; s = s.replace(/mil\b/iu, ''); }

                const lastComma = s.lastIndexOf(',');
                const lastDot = s.lastIndexOf('.');

                if (lastComma !== -1 && lastDot !== -1) {
                    if (lastComma > lastDot) {
                        // vírgula é decimal → remove pontos de milhar e troca vírgula por ponto
                        s = s.replace(/\./g, '').replace(',', '.');
                    } else {
                        // ponto é decimal → remove vírgulas de milhar
                        s = s.replace(/,/g, '');
                    }
                } else if (lastComma !== -1) {
                    // só vírgula → tratar como decimal
                    s = s.replace(/\./g, '').replace(',', '.');
                } else {
                    // só ponto (ou nenhum) → remover vírgulas de milhar
                    s = s.replace(/,/g, '');
                }

                // mantém apenas dígitos, ponto e sinal
                s = s.replace(/[^\d.\-]/g, '');

                const n = Number(s);
                return Number.isFinite(n) && n > 0 ? n * mult : null;
            };

            const extractValorFromTextSafe = (t) => {
                if (!t) return null;
                const text = String(t);
                const matches = text.match(/(?:\d[\d.,]*\d|\d+)(?:\s*(?:k|mil))?/gi);
                if (!matches) return null;
                for (const cand of matches) {
                    const v = parsePtEnNumber(cand);
                    if (v != null) return v;
                }
                return null;
            };

            // ===== Mensagem inicial da etapa (uma única vez) =====
            if (!estado.confirmacaoMsgInicialEnviada) {
                if (estado.confirmacaoSequenciada) {
                    console.log(`[${contato}] Confirmação: já enviando, pulando.`);
                    return;
                }
                estado.confirmacaoSequenciada = true;

                try {
                    const pick = arr => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

                    const bloco1 = ['boa', 'boaa', 'boaaa', 'beleza', 'belezaa', 'belezaaa', 'tranquilo', 'isso aí'];
                    const bloco2 = [
                        'agora manda um PRINT mostrando o saldo disponível',
                        'agora manda um PRINT mostrando o saldo disponível aí',
                        'agora me manda um PRINT mostrando o saldo disponível nessa conta',
                        'agora me manda um PRINT mostrando o saldo',
                    ];
                    const bloco3 = [
                        'ou escreve aqui quanto que tem disponível',
                        'ou me escreve o valor',
                        'ou manda o valor em escrito',
                        'ou me fala o valor disponível',
                    ];

                    const msgConfirmacao = `${pick(bloco1)}, ${pick(bloco2)}, ${pick(bloco3)}`;
                    const sent = await sendOnce(contato, estado, 'confirmacao.m1', msgConfirmacao);
                    if (sent) {
                        estado.confirmacaoMsgInicialEnviada = true;
                        await atualizarContato(contato, 'Sim', 'confirmacao', msgConfirmacao);
                        estado.confirmacaoDesdeTs = Date.now();
                        estado.mensagensDesdeSolicitacao = [];
                    }
                    return;
                } finally {
                    estado.confirmacaoSequenciada = false;
                }
            }

            // ===== Consolida mensagens do usuário desde o pedido =====
            let mensagensPacote = Array.isArray(estado.mensagensPendentes)
                ? estado.mensagensPendentes.splice(0)
                : [];

            if (estado.confirmacaoDesdeTs) {
                const anyTsX = mensagensPacote.some(m => tsEmMs(m) !== null);
                if (anyTsX) {
                    mensagensPacote = mensagensPacote.filter(m => {
                        const ts = tsEmMs(m);
                        return ts === null || ts >= estado.confirmacaoDesdeTs;
                    });
                }
            }
            if (!mensagensPacote.length) return;

            // histórico legível
            if (!Array.isArray(estado.mensagensDesdeSolicitacao)) estado.mensagensDesdeSolicitacao = [];
            estado.mensagensDesdeSolicitacao.push(
                ...mensagensPacote.map(m => (isMidia(m) ? '[mídia]' : (m.texto || '')))
            );

            console.log(`[${contato}] confirmacao> pacote`, mensagensPacote.map(m => ({
                temMidia: m?.temMidia, hasMedia: m?.hasMedia, type: m?.type,
                texto: (m?.texto || '').slice(0, 120)
            })));

            // ===== Regra determinística: MÍDIA OU VALOR numérico =====
            const temMidia = mensagensPacote.some(isMidia);

            const valorInformado =
                mensagensPacote
                    .map(m => extractValorFromTextSafe(m?.texto || m?.text || m?.caption))
                    .find(v => Number.isFinite(v) && v > 0) ?? null;

            if (temMidia || valorInformado != null) {
                if (valorInformado != null) estado.saldo_informado = valorInformado;

                estado.etapa = 'saque';
                estado.saqueInstrucoesEnviadas = false;
                estado.mensagensDesdeSolicitacao = [];
                estado.mensagensPendentes = [];
                await atualizarContato(
                    contato,
                    'Sim',
                    'saque',
                    temMidia ? '[Confirmado por print]' : `[Confirmado por valor=${valorInformado}]`
                );
                console.log(`[${contato}] Confirmação OK -> SAQUE (midia=${temMidia}, valor=${valorInformado})`);
                return;
            }

            // ===== Fallback LLM opcional (mantido, mas desligado por padrão) =====
            const USAR_FALLBACK_LLM_CONFIRMACAO = false;
            if (USAR_FALLBACK_LLM_CONFIRMACAO) {
                const textoAgregado = [
                    ...(estado.mensagensDesdeSolicitacao || []),
                    ...mensagensPacote.map(m => m.texto || m.text || m.caption || '')
                ].join('\n');

                const okConf = String(await gerarResposta(
                    [{ role: 'system', content: promptClassificaConfirmacao(textoAgregado, temMidia) }],
                    ['OK', 'NAO_OK', 'DUVIDA', 'NEUTRO']
                )).toUpperCase();

                if (temMidia || okConf === 'OK') {
                    estado.etapa = 'saque';
                    estado.saqueInstrucoesEnviadas = false;
                    estado.mensagensDesdeSolicitacao = [];
                    estado.mensagensPendentes = [];
                    await atualizarContato(contato, 'Sim', 'saque', '[Confirmado — avançando]');
                    return;
                }
            }

            // se não confirmou, apenas aguarda novas mensagens
            return;
        }

        else if (estado.etapa === 'saque') {
            console.log("[" + contato + "] Etapa 6: saque - Início do processamento");

            // 6.1) Dispara exatamente 3 MENSAGENS (com variações em blocos), uma única vez.
            if (!estado.saqueInstrucoesEnviadas) {
                // flags de dedupe/retomada (como nas outras etapas)
                estado.saqueMsg1Enviada = !!estado.saqueMsg1Enviada;
                estado.saqueMsg2Enviada = !!estado.saqueMsg2Enviada;
                estado.saqueMsg3Enviada = !!estado.saqueMsg3Enviada;

                const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';

                // ---------- MSG 1: "{b1}, {b2}, {b3}, {b4}… {b5}, {b6}" ----------
                const m1b1 = ['beleza', 'certo', 'tranquilo', 'fechou', 'show'];
                const m1b2 = ['segue o saque agora', 'vamos pro saque agora', 'faz o saque agora', 'pode iniciar o saque'];
                const m1b3 = ['do jeitinho que te falei', 'conforme te passei', 'igual expliquei', 'como combinamos'];
                const m1b4 = ['vai cair certinho depois', 'vai certinho depois', 'fica tudo certo no final', 'sem erro no final'];
                const m1b5 = ['nessa mesma conta', 'na conta que te passei', 'na conta aí', 'na conta de agora'];
                const m1b6 = ['agora', 'já agora', 'de uma vez', 'nesse instante'];

                const msg1 = `${pick(m1b1)}, ${pick(m1b2)}, ${pick(m1b3)}, ${pick(m1b4)}… ${pick(m1b5)}, ${pick(m1b6)}`;

                // ---------- MSG 2 (preserva QUEBRAS DE LINHA):
                // "{b1}, {b2}:\n\n{senha aleatória 1}\n8293\n{senha aleatória 2}" ----------
                const m2b1 = ['vai pedir uma senha de saque', 'vai pedir a senha de saque', 'ele pede a senha de saque'];
                const m2b2 = ['usa uma dessas', 'vai ser uma dessas', 'pode usar uma dessas'];

                const s1 = gerarSenhaAleatoria();
                const s2 = '8293';
                const s3 = gerarSenhaAleatoria();

                const msg2 = `${pick(m2b1)}, ${pick(m2b2)}:\n\n${s1}\n${s2}\n${s3}`;

                // ---------- MSG 3: "{b1}, {b2}… {b3}! {b4}, {b5}, {b6}" ----------
                const m3b1 = ['tua parte é 2000', 'sua parte é de 2000', 'tua parte no trampo é de 2000', 'sua parte é de R$ 2000'];
                const m3b2 = ['assim que cair me avisa', 'quando cair me chama aqui', 'me avisa na hora que cair', 'me dá um toque quando cair'];
                const m3b3 = ['pra eu te passar como vai mandar minha parte', 'pra te explicar como mandar minha parte', 'pra te passar o jeito de mandar minha parte'];
                const m3b4 = ['faz direitinho', 'certo pelo certo', 'sem gracinha', 'vai certinho'];
                const m3b5 = ['se travar manda um PRINT', 'qualquer erro me manda PRINT', 'deu problema, manda PRINT', 'se der algo, manda PRINT'];
                const m3b6 = ['vai na calma', 'faz com calma', 'vai clicando certinho', 'sem pressa'];

                const msg3 = `${pick(m3b1)}, ${pick(m3b2)}… ${pick(m3b3)}! ${pick(m3b4)}, ${pick(m3b5)}, ${pick(m3b6)}`;

                // disparamos as 3 mensagens com dedupe/retomada
                try {
                    if (!estado.saqueMsg1Enviada) {
                        estado.saqueMsg1Enviada = true;
                        await sendMessage(contato, msg1);
                        estado.historico.push({ role: 'assistant', content: msg1 });
                        await atualizarContato(contato, 'Sim', 'saque', msg1);
                        await delay(6000 + Math.floor(Math.random() * 3000));
                    }

                    if (!estado.saqueMsg2Enviada) {
                        estado.saqueMsg2Enviada = true;
                        await sendMessage(contato, msg2);
                        estado.historico.push({ role: 'assistant', content: msg2 });
                        await atualizarContato(contato, 'Sim', 'saque', msg2);
                        await delay(7000 + Math.floor(Math.random() * 4000));
                    }

                    if (!estado.saqueMsg3Enviada) {
                        estado.saqueMsg3Enviada = true;
                        await sendMessage(contato, msg3);
                        estado.historico.push({ role: 'assistant', content: msg3 });
                        await atualizarContato(contato, 'Sim', 'saque', msg3);
                    }
                    estado.saqueDesdeTs = Date.now();
                    estado.saqueInstrucoesEnviadas = true; // pacote concluído
                } catch (e) {
                    console.error("[" + contato + "] Erro ao enviar mensagens de saque: " + e.message);
                }

                return; // só classifica mensagens do lead nas próximas iterações
            }

            let mensagensPacote = Array.isArray(estado.mensagensPendentes)
                ? estado.mensagensPendentes.splice(0)
                : [];
            if (estado.saqueDesdeTs) {
                mensagensPacote = mensagensPacote.filter(m => {
                    const ts = tsEmMs(m);
                    return ts !== null && ts >= estado.saqueDesdeTs;
                });
            }
            if (!mensagensPacote.length) return;

            const mensagensDoLead = mensagensPacote.filter(
                msg => !msg.texto.startsWith('USUÁRIO:') &&
                    !msg.texto.startsWith('SENHA:') &&
                    !/saca|senha/i.test(msg.texto || '')
            );
            const mensagensTextoSaque = mensagensDoLead.map(msg => msg.texto).join('\n');
            const temMidiaReal = mensagensPacote.some(isMediaMessage);

            const tipoRelevancia = await gerarResposta(
                [{ role: 'system', content: promptClassificaRelevancia(mensagensTextoSaque, temMidiaReal) }],
                ["RELEVANTE", "IRRELEVANTE"]
            );
            const relevanciaNormalizada = String(tipoRelevancia).trim().toLowerCase();
            console.log("[" + contato + "] Saque → relevância: " + relevanciaNormalizada + " | temMidiaReal=" + temMidiaReal);

            if (temMidiaReal || relevanciaNormalizada === 'relevante') {
                estado.etapa = 'validacao';
                // devolve o pacote para ser reprocessado na 'validacao'
                estado.mensagensPendentes = mensagensPacote.concat(estado.mensagensPendentes);
                console.log("[" + contato + "] Saque → encaminhado para 'validacao'.");
                return;
            }

            console.log("[" + contato + "] Saque → mensagem irrelevante, ignorando.");
            estado.mensagensPendentes = [];
            return;
        }

        else if (estado.etapa === 'validacao') {
            console.log("[" + contato + "] Etapa 7: validacao");

            if (estado.acompanhamentoTimeout) {
                console.log("[" + contato + "] Ignorando mensagens durante acompanhamentoTimeout");
                const mensagensPacoteTimeout = Array.isArray(estado.mensagensPendentes)
                    ? estado.mensagensPendentes.splice(0)
                    : [];
                const txt = mensagensPacoteTimeout.map(m => m.texto).join('\n');
                const mid = mensagensPacoteTimeout.some(m => m.temMidia);
                await atualizarContato(contato, 'Sim', 'validacao', txt, mid);
                return;
            }

            const mensagensPacote = Array.isArray(estado.mensagensPendentes)
                ? estado.mensagensPendentes.splice(0)
                : [];
            if (!mensagensPacote.length) {
                console.log("[" + contato + "] Validacao → sem mensagens novas");
                return;
            }

            const mensagensTexto = mensagensPacote.map(m => m.texto).join('\n');
            const temMidia = mensagensPacote.some(m => m.temMidia);
            console.log("[" + contato + "] Validacao → recebeu pacote. temMidia=" + temMidia);

            // 7.1) Caso tenha chegado com MÍDIA: dispara o pacote inicial de validação UMA vez
            if (temMidia && !estado.validacaoRecebeuMidia) {
                estado.validacaoRecebeuMidia = true;
                estado.aguardandoPrint = false;

                const msgsValidacaoInicial = [
                    "<VALIDACAO_INICIAL_1>",
                    "<VALIDACAO_INICIAL_2>",
                    "<VALIDACAO_INICIAL_3>",
                    "<VALIDACAO_INICIAL_4>",
                    "<VALIDACAO_INICIAL_5>"
                ];
                for (const m of msgsValidacaoInicial) {
                    await enviarLinhaPorLinha(contato, m);
                    estado.historico.push({ role: 'assistant', content: m });
                    await atualizarContato(contato, 'Sim', 'validacao', m);
                }

                // 7.1.a) Agenda os acompanhamentos (timeouts) — mesmas janelas que você já usava
                estado.acompanhamentoTimeout = setTimeout(async () => {
                    try {
                        const followups = [
                            "<VALIDACAO_FOLLOWUP_A_1>",
                            "<VALIDACAO_FOLLOWUP_A_2>",
                            "<VALIDACAO_FOLLOWUP_A_3>",
                            "<VALIDACAO_FOLLOWUP_A_4>",
                            "<VALIDACAO_FOLLOWUP_A_5>",
                            "<VALIDACAO_FOLLOWUP_A_6>",
                            "<VALIDACAO_FOLLOWUP_A_7>",
                            "<VALIDACAO_FOLLOWUP_A_8>",
                            "<VALIDACAO_FOLLOWUP_A_9>",
                            "<VALIDACAO_FOLLOWUP_A_10>",
                            "<VALIDACAO_FOLLOWUP_A_11>",
                            "<VALIDACAO_FOLLOWUP_A_12>",
                            "<VALIDACAO_FOLLOWUP_A_13>",
                            "<VALIDACAO_FOLLOWUP_A_14>",
                            "<VALIDACAO_FOLLOWUP_A_15>",
                            "<VALIDACAO_FOLLOWUP_A_16>"
                        ];
                        for (let i = 0; i < followups.length; i++) {
                            const fx = followups[i];
                            await enviarLinhaPorLinha(contato, fx);
                            estado.historico.push({ role: 'assistant', content: fx });
                            await atualizarContato(contato, 'Sim', 'validacao', fx);

                            // após mensagem “marcadora”, agenda os outros timers (10m / 30m)
                            if (fx.includes("<VALIDACAO_MARCADOR_10M>")) {
                                try {
                                    if (estado.merrecaTimeout) clearTimeout(estado.merrecaTimeout);
                                    estado.merrecaTimeout = setTimeout(async () => {
                                        try {
                                            const bloco10m = [
                                                "<VALIDACAO_10M_1>",
                                                "<VALIDACAO_10M_2>",
                                                "<VALIDACAO_10M_3>",
                                                "<VALIDACAO_10M_4>",
                                                "<VALIDACAO_10M_5>",
                                                "<VALIDACAO_10M_6>",
                                                "<VALIDACAO_10M_7>",
                                                "<VALIDACAO_10M_8>",
                                                "<VALIDACAO_10M_9>",
                                                "<VALIDACAO_10M_10>",
                                                "<VALIDACAO_10M_11>"
                                            ];
                                            for (const z of bloco10m) {
                                                await enviarLinhaPorLinha(contato, z);
                                                estado.historico.push({ role: 'assistant', content: z });
                                                await atualizarContato(contato, 'Sim', 'validacao', z);
                                                await delay(1000);
                                            }

                                            // agenda o de 30m
                                            try {
                                                if (estado.posMerrecaTimeout) clearTimeout(estado.posMerrecaTimeout);
                                                estado.posMerrecaTimeout = setTimeout(async () => {
                                                    try {
                                                        const bloco30m = [
                                                            "<VALIDACAO_30M_1>",
                                                            "<VALIDACAO_30M_2>",
                                                            "<VALIDACAO_30M_3>",
                                                            "<VALIDACAO_30M_4>",
                                                            "<VALIDACAO_30M_5>",
                                                            "<VALIDACAO_30M_6>",
                                                            "<VALIDACAO_30M_7>",
                                                            "<VALIDACAO_30M_8>",
                                                            "<VALIDACAO_30M_9>"
                                                        ];
                                                        for (let j = 0; j < bloco30m.length; j++) {
                                                            const q = bloco30m[j];
                                                            await enviarLinhaPorLinha(contato, q);
                                                            estado.historico.push({ role: 'assistant', content: q });
                                                            await atualizarContato(contato, 'Sim', 'validacao', q);
                                                            // delay especial entre as 2 primeiras, se quiser manter
                                                            if (j === 0) await delay(3 * 60 * 1000);
                                                            else await delay(1000);
                                                        }
                                                    } catch (e) {
                                                        console.error("[" + contato + "] Erro bloco 30m: " + e.message);
                                                    } finally {
                                                        estado.posMerrecaTimeout = null;
                                                        console.log("[" + contato + "] (posMerrecaTimeout) finalizado");
                                                    }
                                                }, 30 * 60 * 1000);
                                                console.log("[" + contato + "] posMerrecaTimeout (30min) agendado");
                                            } catch (e) {
                                                console.error("[" + contato + "] Falha ao agendar posMerrecaTimeout: " + e.message);
                                            }
                                        } catch (e) {
                                            console.error("[" + contato + "] Erro bloco 10m: " + e.message);
                                        } finally {
                                            estado.merrecaTimeout = null;
                                            console.log("[" + contato + "] (merrecaTimeout) finalizado");
                                        }
                                    }, 10 * 60 * 1000);
                                    console.log("[" + contato + "] merrecaTimeout (10min) agendado");
                                } catch (e) {
                                    console.error("[" + contato + "] Falha ao agendar merrecaTimeout: " + e.message);
                                }
                            }
                        }
                    } catch (e) {
                        console.error("[" + contato + "] Erro acompanhamentoTimeout: " + e.message);
                    } finally {
                        estado.acompanhamentoTimeout = null;
                        console.log("[" + contato + "] acompanhamentoTimeout concluído");
                    }
                }, 3.5 * 60 * 1000);

                return;
            }

            // 7.2) Se NÃO veio mídia ainda:
            //     - classifica relevância para decidir se pede PRINT (apenas uma vez)
            const tipoRelevanciaValid = await gerarResposta(
                [{ role: 'system', content: promptClassificaRelevancia(mensagensTexto, temMidia) }],
                ["RELEVANTE", "IRRELEVANTE"]
            );
            const relev = String(tipoRelevanciaValid).trim().toLowerCase();
            console.log("[" + contato + "] Validacao → relevância=" + relev);

            if (!temMidia && relev === 'relevante' && !estado.validacaoMsgInicialEnviada) {
                // pede PRINT uma única vez dentro da etapa validacao
                const pedirPrint = [
                    "<VALIDACAO_PEDIR_PRINT_1>",
                    "<VALIDACAO_PEDIR_PRINT_2>"
                ];
                for (const p of pedirPrint) {
                    await enviarLinhaPorLinha(contato, p);
                    estado.historico.push({ role: 'assistant', content: p });
                    await atualizarContato(contato, 'Sim', 'validacao', p);
                }
                estado.validacaoMsgInicialEnviada = true;
                estado.aguardandoPrint = true;
                return;
            }

            // 7.3) Se já pediu print e AGORA chegou mídia, dispare o pacote inicial da 7.1
            if (temMidia && !estado.validacaoRecebeuMidia) {
                // reusa exatamente a lógica de mídia da 7.1, sem helper:
                estado.validacaoRecebeuMidia = true;
                estado.aguardandoPrint = false;

                const msgsValidacaoInicial = [
                    "<VALIDACAO_INICIAL_1>",
                    "<VALIDACAO_INICIAL_2>",
                    "<VALIDACAO_INICIAL_3>",
                    "<VALIDACAO_INICIAL_4>",
                    "<VALIDACAO_INICIAL_5>"
                ];
                for (const m of msgsValidacaoInicial) {
                    await enviarLinhaPorLinha(contato, m);
                    estado.historico.push({ role: 'assistant', content: m });
                    await atualizarContato(contato, 'Sim', 'validacao', m);
                }

                estado.acompanhamentoTimeout = setTimeout(async () => {
                    try {
                        const followups = [
                            "<VALIDACAO_FOLLOWUP_A_1>",
                            "<VALIDACAO_FOLLOWUP_A_2>",
                            "<VALIDACAO_FOLLOWUP_A_3>",
                            "<VALIDACAO_FOLLOWUP_A_4>"
                        ];
                        for (const fx of followups) {
                            await enviarLinhaPorLinha(contato, fx);
                            estado.historico.push({ role: 'assistant', content: fx });
                            await atualizarContato(contato, 'Sim', 'validacao', fx);
                        }
                    } catch (e) {
                        console.error("[" + contato + "] Erro acompanhamentoTimeout (2): " + e.message);
                    } finally {
                        estado.acompanhamentoTimeout = null;
                    }
                }, 3.5 * 60 * 1000);

                return;
            }

            // 7.4) Caso contrário: ignorar/standby
            console.log("[" + contato + "] Validacao → aguardando mídia/relevância útil. Mensagens foram: " + mensagensTexto);
            estado.mensagensPendentes = [];
            await atualizarContato(contato, 'Sim', 'validacao', mensagensTexto, temMidia);
            return;
        }
        else if (estado.etapa === 'encerrado') {
            console.log("[" + contato + "] Etapa encerrada");
            const grupo1 = ['salve', 'e aí', 'eae'];
            const grupo2 = ['tô precisando de um lara pra agora', 'preciso de um lara pra agora', 'preciso de lara agora', 'tô precisando de lara agora'];
            const grupo3 = ['tá disponível?', 'vai poder fazer o trampo?', 'bora fazer esse trampo?', 'vamos fazer esse trampo?'];
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