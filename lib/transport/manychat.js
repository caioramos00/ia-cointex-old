// lib/transport/manychat.js
const axios = require('axios');

const API = 'https://api.manychat.com';

async function call(path, payload, token) {
  const url = `${API}${path}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  console.log('[ManyChat][HTTP] POST', url);
  console.log('[ManyChat][HTTP] Payload:', JSON.stringify(payload));

  const resp = await axios.post(url, payload, {
    headers,
    validateStatus: () => true, // vamos inspecionar nós mesmos
  });

  console.log('[ManyChat][HTTP] Status:', resp.status, 'Body:', JSON.stringify(resp.data));

  // ManyChat pode devolver 200 com {status:"error"} ou 4xx com mensagem
  if (resp.status >= 400 || resp.data?.status === 'error') {
    const msg = `HTTP ${resp.status} ${JSON.stringify(resp.data)}`;
    const err = new Error(`ManyChat send falhou: ${msg}`);
    err.httpStatus = resp.status;
    err.body = resp.data;
    throw err;
  }

  return resp.data;
}

function buildV2ContentText(text) {
  return {
    version: 'v2',
    content: {
      type: 'whatsapp',
      messages: [{ type: 'text', text }],
    },
  };
}

module.exports = {
  name: 'manychat',

  // requer manychat_subscriber_id no contato
  async sendText({ subscriberId, text }, settings = {}) {
    const apiToken = settings.manychat_api_token || process.env.MANYCHAT_API_TOKEN;
    const fallbackFlowId = settings.manychat_fallback_flow_id || process.env.MANYCHAT_FALLBACK_FLOW_ID;

    if (!apiToken) throw new Error('ManyChat: MANYCHAT_API_TOKEN ausente');
    if (!subscriberId) throw new Error('ManyChat: subscriberId ausente no contato');

    // 1) Tenta enviar conteúdo v2 (mensagem free-form) no canal WhatsApp
    const v2payload = { subscriber_id: Number(subscriberId), data: buildV2ContentText(text) };

    try {
      // algumas contas usam /whatsapp/sending, outras /fb/sending
      try {
        await call('/whatsapp/sending/sendContent', v2payload, apiToken);
        return;
      } catch (e) {
        // se o endpoint não existir na sua conta (404/405), tenta o caminho "fb"
        if (e.httpStatus === 404 || e.httpStatus === 405) {
          await call('/fb/sending/sendContent', v2payload, apiToken);
          return;
        }
        throw e; // outros erros seguem o fluxo de fallback
      }
    } catch (e) {
      // 2) Se falhou por política de 24h, cai para Flow com Template
      const code = e.body?.code;
      const msg = e.body?.message || '';

      const is24h =
        code === 3011 || /24\s*hours?/i.test(msg) || /message tag/i.test(msg) || /window/i.test(msg);

      if (!is24h) {
        // erro diferente de janela — propaga
        throw e;
      }

      if (!fallbackFlowId) {
        // sem flow/template configurado
        throw new Error(
          `ManyChat: fora da janela de 24h e MANYCHAT_FALLBACK_FLOW_ID não configurado. Erro original: ${e.message}`
        );
      }

      // 3) Envia Flow (template) para reabrir/entregar
      // OBS: na UI do ManyChat, pegue o "Namespace" do flow/template (ex.: "content:123456")
      const flowPayload = {
        subscriber_id: Number(subscriberId),
        flow_ns: fallbackFlowId,
        // blocks: { ... } // se quiser passar variáveis do Flow
      };

      try {
        try {
          await call('/whatsapp/sending/sendFlow', flowPayload, apiToken);
        } catch (e2) {
          if (e2.httpStatus === 404 || e2.httpStatus === 405) {
            await call('/fb/sending/sendFlow', flowPayload, apiToken);
          } else {
            throw e2;
          }
        }
      } catch (e3) {
        // se até o template falhar, propaga para o log de quem chamou
        throw e3;
      }
    }
  },
};
