// lib/transport/manychat.js

const axios = require('axios');
const API = 'https://api.manychat.com';
const SILENT = ''; // log ligado

// ===== Configs diretas no código =====
const MC_API_TOKEN = 'COLOQUE_SEU_TOKEN_AQUI';
const FLOW_IMAGE_NS = 'seu_namespace/seu_flow_de_imagem'; // opcional; deixe '' se não tiver
const FLOW_TEXT_NS  = ''; // opcional: um flow simples de texto se preferir
// ====================================

async function call(path, payload, token, label) {
  const url = `${API}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (!SILENT) console.log(`[ManyChat][${label}] POST ${url}`);
  if (!SILENT) console.log(`[ManyChat][${label}] Payload: ${JSON.stringify(payload)}`);

  const resp = await axios.post(url, payload, { headers, validateStatus: () => true });

  const brief = typeof resp.data === 'string' ? resp.data.slice(0, 500) : resp.data;
  if (resp.status >= 400 || (resp.data && resp.data.status === 'error')) {
    console.warn(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(brief)}`);
    const err = new Error(`${label} falhou: HTTP ${resp.status}`);
    err.httpStatus = resp.status;
    err.body = resp.data;
    throw err;
  }
  if (!SILENT) console.log(`[ManyChat][${label}] HTTP ${resp.status} Body: ${JSON.stringify(brief)}`);
  return resp.data;
}

function contentV2Text(textOrLines) {
  let text = Array.isArray(textOrLines)
    ? textOrLines.map(v => (v == null ? '' : String(v))).join('\n')
    : String(textOrLines ?? '');
  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  return {
    version: 'v2',
    content: {
      type: 'whatsapp',
      messages: [{ type: 'text', text }],
    },
  };
}

function contentV2Image(url, caption) {
  const img = caption ? { type: 'image', url, caption } : { type: 'image', url };
  return {
    version: 'v2',
    content: {
      type: 'whatsapp',
      messages: [img],
    },
  };
}

// fallback alternativo: mandar como documento (muitos provedores aceitam “file” mesmo quando “image” falha)
function contentV2Document(url, filename = 'arquivo.jpg', caption) {
  const msg = { type: 'file', url, filename };
  if (caption) msg.caption = caption;
  return {
    version: 'v2',
    content: {
      type: 'whatsapp',
      messages: [msg],
    },
  };
}

async function headForInfo(url) {
  try {
    const r = await axios.head(url, { timeout: 10000, maxRedirects: 3, validateStatus: () => true });
    return {
      ok: r.status >= 200 && r.status < 400,
      status: r.status,
      headers: r.headers || {},
    };
  } catch (e) {
    return { ok: false, status: 0, headers: {} };
  }
}
function looksLikeImage(headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  return /^image\/(jpe?g|png|gif|webp)/.test(ct);
}
function getLength(headers) {
  const raw = headers['content-length'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  name: 'manychat',

  async sendText({ subscriberId, text }, settings = {}) {
    const apiToken = MC_API_TOKEN;
    if (!apiToken) throw new Error('ManyChat: token ausente');
    if (!subscriberId) throw new Error('ManyChat: subscriberId ausente');

    const data = contentV2Text(text);
    const payload = { subscriber_id: Number(subscriberId), data };

    try {
      await call('/fb/sending/sendContent', payload, apiToken, 'sendContent:text');
      return;
    } catch (e) {
      const code = e?.body?.code;
      const msg = (e?.body?.message || '').toLowerCase();
      const is24h = code === 3011 || /24|window|tag/.test(msg);

      if (!is24h) throw e;
      if (!FLOW_TEXT_NS) throw new Error('ManyChat: fora da janela e FLOW_TEXT_NS não está configurado');
      console.log(`[ManyChat] Usando fallback flow (text): ${FLOW_TEXT_NS}`);
      await call('/fb/sending/sendFlow', { subscriber_id: Number(subscriberId), flow_ns: FLOW_TEXT_NS }, apiToken, 'sendFlow:text');
    }
  },

  /**
   * Envio de imagem com modos:
   *   mode = 'content' (padrão): API v2
   *   mode = 'flow'   : manda via Flow (precisa de FLOW_IMAGE_NS configurado)
   *   mode = 'both'   : content -> flow (em sequência)
   *   fallbackAsDoc   : se true, tenta enviar como documento se imagem falhar
   *   confirmText     : se setado, manda um texto depois para confirmar entrega
   */
  async sendImage({ subscriberId, imageUrl, caption, mode = 'content', fallbackAsDoc = true, confirmText = 'Enviei uma imagem agora. Se não aparecer, toque no link acima.' }, settings = {}) {
    const apiToken = MC_API_TOKEN;
    if (!apiToken) throw new Error('ManyChat: token ausente');
    if (!subscriberId) throw new Error('ManyChat: subscriberId ausente');

    const url = String(imageUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('ManyChat: imageUrl inválida');

    // checagens úteis de cabeçalho
    const h = await headForInfo(url);
    if (!h.ok) {
      console.warn(`[ManyChat][sendImage] HEAD falhou status=${h.status} url=${url}`);
    } else {
      const tooBig = getLength(h.headers) > 4.8 * 1024 * 1024;
      const notImage = !looksLikeImage(h.headers);
      if (tooBig) console.warn(`[ManyChat][sendImage] Conteúdo grande (${getLength(h.headers)} bytes) — WhatsApp pode recusar > ~5MB`);
      if (notImage) console.warn(`[ManyChat][sendImage] Content-Type não parece imagem: ${h.headers['content-type']}`);
    }

    const tryContentImage = async () => {
      const data = contentV2Image(url, caption);
      const payload = { subscriber_id: Number(subscriberId), data };
      await call('/fb/sending/sendContent', payload, apiToken, 'sendContent:image');
    };
    const tryContentDoc = async () => {
      const filename = url.split('/').pop() || 'arquivo.jpg';
      const data = contentV2Document(url, filename, caption);
      const payload = { subscriber_id: Number(subscriberId), data };
      await call('/fb/sending/sendContent', payload, apiToken, 'sendContent:document');
    };
    const tryFlowImage = async () => {
      if (!FLOW_IMAGE_NS) throw new Error('ManyChat: FLOW_IMAGE_NS não configurado para mode=flow/both');
      // Flow precisa já ter um bloco de imagem apontando para um campo fixo ou para uma URL salva no Flow
      await call('/fb/sending/sendFlow', { subscriber_id: Number(subscriberId), flow_ns: FLOW_IMAGE_NS }, apiToken, 'sendFlow:image');
    };

    const shouldDoContent = mode === 'content' || mode === 'both';
    const shouldDoFlow    = mode === 'flow'   || mode === 'both';

    // 1) tenta pelo content v2 (imagem)
    if (shouldDoContent) {
      try {
        await tryContentImage();
      } catch (e) {
        const body = e?.body || {};
        const code = body?.code;
        const msg = String(body?.message || '').toLowerCase();
        const is24h = code === 3011 || /24|window|tag/.test(msg);

        if (code === 2301 || /url|media|download|fetch|invalid/i.test(msg)) {
          console.warn(`[ManyChat][sendImage] ManyChat rejeitou a URL da imagem. HTTPS público, CT=image/*, <=5MB, extensão ok.`);
        }

        if (fallbackAsDoc) {
          // tenta como documento
          try {
            await tryContentDoc();
          } catch (e2) {
            if (!is24h) throw e2; // erro “real”
          }
        } else if (!is24h) {
          throw e;
        }

        // se for 24h, segue pro Flow (abaixo)
      }
    }

    // 2) tenta via Flow (se solicitado ou se deu 24h/erro)
    if (shouldDoFlow) {
      try {
        await tryFlowImage();
      } catch (e) {
        // se flow falhar, não temos muito a fazer — segue
        console.warn(`[ManyChat][sendImage] Flow image falhou: ${e.message || e}`);
      }
    }

    // 3) texto de confirmação (ajuda a ver se a sessão está aberta e o contato recebeu algo)
    if (confirmText) {
      try {
        await this.sendText({ subscriberId, text: caption ? `${caption}\n\n${confirmText}` : confirmText });
      } catch (e) {
        console.warn(`[ManyChat][sendImage] Falha ao enviar texto de confirmação: ${e.message || e}`);
      }
    }
  },
};
