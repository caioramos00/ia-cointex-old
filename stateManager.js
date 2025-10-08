const { normalizeContato } = require('./utils.js');
const estadoContatos = require('./state.js');

function _resetRuntime(st, opts = {}) {
    st.enviandoMensagens = false;
    st.mensagensPendentes = [];
    st.mensagensDesdeSolicitacao = [];
    st.sentHashes = st.sentHashes instanceof Set ? st.sentHashes : new Set();
    st.lastClassifiedIdx = {
        interesse: 0, acesso: 0, confirmacao: 0, saque: 0, validacao: 0, conversao: 0
    };
    st.saquePediuPrint = false;
    if (st.validacaoTimer) { try { clearTimeout(st.validacaoTimer); } catch { } }
    st.validacaoTimer = null;
    st.validacaoAwaitFirstMsg = false;
    st.validacaoTimeoutUntil = 0;
    st.conversaoBatch = 0;
    st.conversaoAwaitMsg = false;
    st.stageCursor = {};
    st.optoutLotsTried = 0;
    st.optoutBuffer = [];
    st.optoutBatchStage = null;
    if (opts.clearCredenciais) st.credenciais = undefined;
    if (opts.seedCredenciais && typeof opts.seedCredenciais === 'object') {
        st.credenciais = {
            email: String(opts.seedCredenciais.email || ''),
            password: String(opts.seedCredenciais.password || ''),
            login_url: String(opts.seedCredenciais.login_url || ''),
        };
    }
    if (opts.manychat_subscriber_id != null) {
        const v = opts.manychat_subscriber_id;
        st.manychat_subscriber_id = (typeof v === 'string' && v.trim()) ? v.trim() :
            (Number.isFinite(Number(v)) ? String(v) : undefined);
    }
    st.updatedAt = Date.now();
}

function ensureEstado(contato) {
    const normalized = normalizeContato(contato);
    if (!estadoContatos[normalized]) {
        estadoContatos[normalized] = {
            contato: normalized,
            etapa: 'abertura:send',
        };
        _resetRuntime(estadoContatos[normalized]);
    }
    return estadoContatos[normalized];
}

module.exports = {
    ensureEstado,
    _resetRuntime
};