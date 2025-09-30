// helpers/prompt-lab.js
// CLI minimalista para testar seus prompts no terminal.
// Usa o mesmo client/config do seu projeto: model "gpt-5", max_output_tokens: 24.

const readline = require('readline');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: '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' });

// === importa seus prompts a partir da raiz ===
const {
    promptClassificaAceite,
    promptClassificaAcesso,
    promptClassificaConfirmacao,
    promptClassificaRelevancia,
    promptClassificaOptOut,
    promptClassificaReoptin,
} = require('../prompts.js');

// ---------------- utils ----------------
const toUpperSafe = (x) => String(x || '').trim().toUpperCase();
const normalizeAllowedLabels = (allowed) => {
    if (Array.isArray(allowed)) return allowed.map(toUpperSafe).filter(Boolean);
    if (typeof allowed === 'string') return allowed.split(/[|,]/).map(toUpperSafe).filter(Boolean);
    return [];
};
const pickValidLabel = (text, allowed) => {
    if (!allowed.length) return null;
    const first = String(text || '').trim().split(/\s+/)[0];
    const u = toUpperSafe(first);
    return allowed.includes(u) ? u : null;
};
const extractJsonLabel = (outputText, allowed) => {
    try {
        const obj = JSON.parse(outputText || '{}');
        return pickValidLabel(obj.label, allowed);
    } catch { return null; }
};

// === mesma call/params do projeto (model + max_output_tokens) ===
async function gerarResposta(messages, allowedLabels) {
    const allow = normalizeAllowedLabels(allowedLabels);
    const DEFAULT_LABEL = allow.includes('CONTINUAR') ? 'CONTINUAR' : (allow[0] || 'UNKNOWN');

    try {
        const promptStr = messages.map(m => m.content).join('\n');

        const promptJson = `${promptStr}

Retorne estritamente JSON, exatamente neste formato:
{"label":"${allow.join("|").toLowerCase()}"}`;

        // 1ª tentativa: JSON estrito
        let res = await openai.responses.create({
            model: "gpt-5",
            input: promptJson,
            max_output_tokens: 24 // (mínimo aceito é 16) – não enviar temperature/top_p/stop
        });

        let outText = String(res.output_text || '').trim();
        let label = extractJsonLabel(outText, allow);

        if (!label) {
            // Fallback: pedir uma única palavra válida
            res = await openai.responses.create({
                model: "gpt-5",
                input: `${promptStr}\n\nResponda APENAS com UMA palavra válida: ${allow.join("|")}`,
                max_output_tokens: 24
            });
            const raw = String(res.output_text || '').trim();
            label = pickValidLabel(raw, allow);
            return { label: label || DEFAULT_LABEL, raw };
        }

        return { label, raw: outText };
    } catch (err) {
        return { label: DEFAULT_LABEL, raw: `ERRO: ${err?.message || err}` };
    }
}

// --------- catálogo de prompts (menu) ----------
const PROMPTS = [
    {
        key: 'aceite',
        title: 'Classifica Aceite',
        build: (texto) => [{ role: 'system', content: promptClassificaAceite(texto) }],
        labels: ['aceite', 'recusa', 'duvida']
    },
    {
        key: 'acesso',
        title: 'Classifica Acesso ("ENTREI" etc.)',
        build: (texto) => [{ role: 'system', content: promptClassificaAcesso(texto) }],
        labels: ['confirmado', 'nao_confirmado', 'duvida', 'neutro']
    },
    {
        key: 'confirmacao',
        title: 'Classifica Confirmação (valor em FINANCEIRO)',
        build: (texto) => [{ role: 'system', content: promptClassificaConfirmacao(texto) }],
        labels: ['confirmado', 'nao_confirmado', 'duvida', 'neutro']
    },
    {
        key: 'relevancia',
        title: 'Classifica Relevância (saque/mídia/dúvidas)',
        build: (texto, temMidia) => [{ role: 'system', content: promptClassificaRelevancia(texto, temMidia) }],
        labels: ['relevante', 'irrelevante'],
        acceptsMediaFlag: true
    },
    {
        key: 'optout',
        title: 'Classifica Opt-out',
        build: (texto) => [{ role: 'system', content: promptClassificaOptOut(texto) }],
        labels: ['OPTOUT', 'CONTINUAR']
    },
    {
        key: 'reoptin',
        title: 'Classifica Re-opt-in',
        build: (texto) => [{ role: 'system', content: promptClassificaReoptin(texto) }],
        labels: ['REOPTIN', 'CONTINUAR']
    },
];

// ---------------- CLI ----------------
let current = null;
let rawMode = false;
let relevanciaTemMidia = false;

function printMenu() {
    console.clear();
    console.log('🧪 Prompt Lab (CLI) — selecione um prompt:\n');
    PROMPTS.forEach((p, i) => console.log(`${i + 1}. ${p.title} (${p.key})`));
    console.log('\nComandos durante o teste:');
    console.log('  :labels   -> mostra rótulos válidos');
    console.log('  :raw      -> liga/desliga saída bruta');
    console.log('  :midia    -> (só relevância) alterna temMidia=' + (relevanciaTemMidia ? 'true' : 'false'));
    console.log('  :switch   -> voltar ao menu');
    console.log('  :quit     -> sair\n');
}

function buildMessages(texto) {
    if (!current) return [];
    if (current.key === 'relevancia') {
        return current.build(texto, relevanciaTemMidia);
    }
    return current.build(texto);
}

async function runLoop(rl) {
    console.log(`\n[Prompt: ${current.title}]`);
    console.log('Digite frases/palavras. Comandos: :labels  :raw  :midia  :switch  :quit');
    rl.setPrompt('› ');
    rl.prompt();

    rl.on('line', async (line) => {
        const txt = line.trim();

        if (txt === ':quit') { rl.close(); return; }
        if (txt === ':switch') {
            rl.close();        // <-- encerra a readline atual
            main();            // <-- volta ao menu
            return;
        }
        if (txt === ':labels') { console.log('Rótulos:', current.labels.join(' | ')); rl.prompt(); return; }
        if (txt === ':raw') { rawMode = !rawMode; console.log('RAW:', rawMode ? 'ON' : 'OFF'); rl.prompt(); return; }
        if (txt === ':midia') {
            if (current.key !== 'relevancia') console.log('Só para o prompt de Relevância.');
            else { relevanciaTemMidia = !relevanciaTemMidia; console.log('temMidia:', relevanciaTemMidia); }
            rl.prompt();
            return;
        }
        if (!txt) { rl.prompt(); return; }

        const messages = buildMessages(txt);
        const t0 = Date.now();
        const out = await gerarResposta(messages, current.labels);
        const ms = Date.now() - t0;

        console.log(`→ label: ${out.label}  (${ms}ms)`);
        if (rawMode) console.log('raw:', out.raw);
        rl.prompt();
    });
}

async function main() {
    printMenu();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nEscolha (1-' + PROMPTS.length + ') ou digite a chave: ', async (ans) => {
        rl.close(); // <-- fecha a primeira readline para evitar eco/duplicação
        const n = parseInt(ans, 10);
        const byIndex = !Number.isNaN(n) && n >= 1 && n <= PROMPTS.length ? PROMPTS[n - 1] : null;
        const byKey = PROMPTS.find(p => p.key.toLowerCase() === String(ans || '').trim().toLowerCase());
        current = byIndex || byKey;

        if (!current) { console.log('Entrada inválida.'); return; }

        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        await runLoop(rl2);
    });
}

main();
