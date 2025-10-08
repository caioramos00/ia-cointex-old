const axios = require('axios');
const { delay } = require('./utils.js');
const { ensureEstado } = require('./stateManager.js');

async function criarUsuarioDjango(contato) {
    const st = ensureEstado(contato);
    if (st.createdUser === 'ok' || st.credenciais) return { ok: true, skipped: true };
    if (st.createdUser === 'pending') return { ok: true, skipped: 'pending' };
    st.createdUser = 'pending';
    const phone = st.contato.startsWith('+') ? st.contato : `+${st.contato}`;
    const payload = { tid: st.tid || '', click_type: st.click_type || 'Orgânico', phone };
    const URL = 'https://www.cointex.cash/api/create-user/';
    const tryOnce = async () =>
        axios.post(URL, payload, { timeout: 15000, validateStatus: () => true });
    try {
        let resp = await tryOnce();
        if (resp.status >= 500 || resp.status === 429) {
            const jitter = 1200 + Math.floor(Math.random() * 400);
            console.warn(`[Contato] Cointex retry agendado em ${jitter}ms: ${st.contato} HTTP ${resp.status}`);
            await delay(jitter);
            resp = await tryOnce();
        }
        const okHttp = resp.status >= 200 && resp.status < 300;
        const okBody = !resp.data?.status || resp.data?.status === 'success';
        if (okHttp && okBody) {
            const user = Array.isArray(resp.data?.users) ? resp.data.users[0] : null;
            if (user?.email && user?.password) {
                st.credenciais = {
                    email: user.email,
                    password: user.password,
                    login_url: user.login_url || ''
                };
            }
            st.createdUser = 'ok';
            console.log(`[Contato] Cointex criado: ${st.contato} ${st.credenciais?.email || ''}`.trim());
            return { ok: true, status: resp.status, data: resp.data };
        }
        const msg = resp.data?.message || `HTTP ${resp.status}`;
        st.createdUser = undefined;
        console.warn(`[Contato] Cointex ERRO: ${st.contato} ${msg}`);
        throw new Error(msg);
    } catch (err) {
        st.createdUser = undefined;
        console.warn(`[Contato] Cointex ERRO: ${st.contato} ${err.message || err}`);
        throw err;
    }
}

module.exports = { criarUsuarioDjango };
