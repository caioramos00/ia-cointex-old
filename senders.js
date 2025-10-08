const axios = require('axios');
const { delayRange, extraGlobalDelay, tsNow, safeStr, BETWEEN_MIN_MS, BETWEEN_MAX_MS } = require('./utils.js');
const { getContatoByPhone, setManychatSubscriberId } = require('./db');
const { getActiveTransport } = require('./lib/transport/index.js');
const { preflightOptOut } = require('./optout.js');
// const { ensureEstado } = require('./stateManager.js');

async function resolveManychatSubscriberId(contato, modOpt, settingsOpt) {
    const phone = String(contato || '').replace(/\D/g, '');
    const st = ensureEstado(phone);
    let subscriberId = null;
    try {
        const c = await getContatoByPhone(phone);
        if (c?.manychat_subscriber_id) subscriberId = String(c.manychat_subscriber_id);
    } catch { }
    if (!subscriberId && st?.manychat_subscriber_id) subscriberId = String(st.manychat_subscriber_id);
    if (subscriberId) return subscriberId;
    try {
        const { mod, settings } = (modOpt && settingsOpt) ? { mod: modOpt, settings: settingsOpt } : await getActiveTransport();
        const token = (settings && settings.manychat_api_token) || process.env.MANYCHAT_API_TOKEN || '';
        if (!token) return null;
        const phonePlus = phone.startsWith('+') ? phone : `+${phone}`;
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const call = async (method, url, data) => {
            try {
                return await axios({ method, url, data, headers, timeout: 12000, validateStatus: () => true });
            } catch { return { status: 0, data: null }; }
        };
        const tries = [
            { m: 'get', u: `https://api.manychat.com/whatsapp/subscribers/findByPhone?phone=${encodeURIComponent(phonePlus)}` },
            { m: 'post', u: 'https://api.manychat.com/whatsapp/subscribers/findByPhone', p: { phone: phonePlus } },
            { m: 'get', u: `https://api.manychat.com/fb/subscriber/findByPhone?phone=${encodeURIComponent(phonePlus)}` },
            { m: 'post', u: 'https://api.manychat.com/fb/subscriber/findByPhone', p: { phone: phonePlus } },
        ];
        for (const t of tries) {
            const r = await call(t.m, t.u, t.p);
            const d = r?.data || {};
            const id = d?.data?.id || d?.data?.subscriber_id || d?.subscriber?.id || d?.id || null;
            if (r.status >= 200 && r.status < 300 && id) { subscriberId = String(id); break; }
            console.log(`[${phone}] resolveManychatSubscriberId try fail: HTTP ${r.status}`);
        }
        if (subscriberId) {
            await setManychatSubscriberId(phone, subscriberId);
            st.manychat_subscriber_id = subscriberId;
            console.log(`[${phone}] resolveManychatSubscriberId OK id=${subscriberId}`);
        }
    } catch (e) {
        console.warn(`[${phone}] resolveManychatSubscriberId falhou: ${e?.message || e}`);
    }
    return subscriberId;
}

async function sendMessage(contato, texto, opts = {}) {
    await extraGlobalDelay();
    const st = ensureEstado(contato);
    if (await preflightOptOut(st)) {
        console.log(`[${contato}] msg=cancelada por opt-out em tempo real`);
        return { ok: false, reason: 'paused-by-optout' };
    }
    const paused = (st.permanentlyBlocked === true) || (st.optOutCount >= 3) || (st.optOutCount > 0 && !st.reoptinActive);
    if (paused && !opts.force) {
        return { ok: false, reason: 'paused-by-optout' };
    }
    const { mod, settings } = await getActiveTransport();
    const provider = mod?.name || 'unknown';
    try {
        if (provider === 'manychat') {
            const subscriberId = await resolveManychatSubscriberId(contato, mod, settings);
            if (!subscriberId) throw new Error('subscriber_id ausente');
            const payload = {
                subscriber_id: subscriberId,
                data: { version: 'v2', content: { type: 'whatsapp', messages: [{ type: 'text', text: texto }] } },
            };
            const r = await axios.post('https://api.manychat.com/fb/sending/sendContent', payload, {
                headers: { Authorization: `Bearer ${settings.manychat_api_token}`, 'Content-Type': 'application/json' },
                timeout: 15000,
                validateStatus: () => true
            });
            if (r.status >= 400 || r.data?.status === 'error') {
                throw new Error(`sendContent falhou: ${JSON.stringify(r.data)}`);
            }
            return { ok: true, provider: 'manychat' };
        } else if (provider === 'meta') {
            await mod.sendText({ to: contato, text: texto }, settings);
            return { ok: true, provider: 'meta' };
        } else {
            throw new Error(`provider "${provider}" não suportado`);
        }
    } catch (e) {
        console.log(`[${contato}] Msg send fail: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

async function updateManyChatCustomFieldByName(subscriberId, name, value, token) {
    const payload = { field_name: name, field_value: value };
    const r = await axios.post(`https://api.manychat.com/fb/subscriber/setCustomFieldByName`, payload, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true
    });
    return { ok: r.status >= 200 && r.status < 300 && r.data?.status === 'success', data: r.data };
}

async function sendImage(contato, urlOrItems, captionOrOpts, opts = {}) {
    if (typeof captionOrOpts === 'object') { opts = captionOrOpts; captionOrOpts = undefined; }
    const st = ensureEstado(contato);
    const items = Array.isArray(urlOrItems) ? urlOrItems : [{ url: urlOrItems, caption: captionOrOpts }];
    const isArray = Array.isArray(urlOrItems);
    opts = { delayBetweenMs: [BETWEEN_MIN_MS, BETWEEN_MAX_MS], ...opts };
    await extraGlobalDelay();
    if (await preflightOptOut(st)) return { ok: false, reason: 'paused-by-optout' };
    const paused = (st.permanentlyBlocked === true) || (st.optOutCount >= 3) || (st.optOutCount > 0 && !st.reoptinActive);
    if (paused) return { ok: false, reason: 'paused-by-optout' };
    const { mod, settings } = await getActiveTransport();
    const provider = mod?.name || 'unknown';
    if (provider !== 'manychat') {
        console.warn(`[${contato}] sendImage: provider=${provider} não suportado (esperado manychat).`);
        return { ok: false, reason: 'unsupported-provider' };
    }
    const token = settings?.manychat_api_token || process.env.MANYCHAT_API_TOKEN || '';
    if (!token) throw new Error('ManyChat API token ausente');
    const subscriberId = await resolveManychatSubscriberId(contato, mod, settings);
    if (!subscriberId) throw new Error('subscriber_id ausente');
    const sendOneByFields = async ({ url, caption }) => {
        if (!opts.fields?.image) return { ok: false, reason: 'missing-field-name' };
        const r = await updateManyChatCustomFieldByName(subscriberId, opts.fields.image, url, token);
        if (!r.ok) return { ok: false, reason: 'set-field-failed' };
        console.log(`[${contato}] ManyChat: ${opts.fields.image} atualizado -> fluxo disparado. url="${url}" caption_len=${(caption || '').length}`);
        return { ok: true, provider: 'manychat', mechanism: 'manychat_fields' };
    };
    const sendOneByFlow = async ({ url, caption }) => {
        if (!opts.flowNs) return { ok: false, reason: 'missing-flow-ns' };
        const payload = {
            subscriber_id: subscriberId,
            flow_ns: opts.flowNs,
            variables: {
                contact_: contato,
                image_url_: url,
                caption_: caption || '',
                ...opts.flowVars,
            }
        };
        const r = await axios.post('https://api.manychat.com/fb/sending/sendFlow', payload, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 60000,
            validateStatus: () => true
        });
        console.log(`[ManyChat][sendFlow] http=${r.status} body=${JSON.stringify(r.data)}`);
        if (r.status >= 200 && r.status < 300 && r.data?.status === 'success') {
            return { ok: true, provider: 'manychat', mechanism: 'flow', flowNs: opts.flowNs };
        }
        return { ok: false, reason: 'flow-send-failed', details: r.data };
    };
    const sender = (opts.mechanism === 'flow' || (!!opts.flowNs)) ? sendOneByFlow : sendOneByFields;
    const results = [];
    for (let i = 0; i < items.length; i++) {
        const { url, caption } = items[i];
        const r = await sender({ url: url || '', caption });
        results.push(r);
        if (await preflightOptOut(st)) {
            results.push({ ok: false, reason: 'paused-by-optout-mid-batch' });
            break;
        }
        if (i < items.length - 1) {
            const [minMs, maxMs] = opts.delayBetweenMs;
            await delayRange(minMs, maxMs);
        }
    }
    if (!isArray) return results[0];
    const okAll = results.every(r => r?.ok);
    return { ok: okAll, results };
}

async function sendManychatWaFlow(contato, flowNs, dataOpt = {}) {
    await extraGlobalDelay();
    const st = ensureEstado(contato);
    if (await preflightOptOut(st)) {
        console.log(`[${contato}] flow=cancelado por opt-out em tempo real`);
        return { ok: false, reason: 'paused-by-optout' };
    }
    const paused = (st.permanentlyBlocked === true) || (st.optOutCount >= 3) || (st.optOutCount > 0 && !st.reoptinActive);
    if (paused) {
        return { ok: false, reason: 'paused-by-optout' };
    }
    const { mod, settings } = await getActiveTransport();
    const provider = mod?.name || 'unknown';
    if (provider !== 'manychat') {
        console.warn(`[${contato}] sendManychatWaFlow: provider=${provider} não suportado (esperado manychat).`);
        return { ok: false, reason: 'unsupported-provider' };
    }
    const token = (settings && settings.manychat_api_token) || process.env.MANYCHAT_API_TOKEN || '';
    if (!token) {
        console.warn(`[${contato}] sendManychatWaFlow: token Manychat ausente`);
        return { ok: false, reason: 'no-token' };
    }
    const subscriberId = await resolveManychatSubscriberId(contato, mod, settings);
    if (!subscriberId) {
        console.warn(`[${contato}] sendManychatWaFlow: subscriber_id não encontrado`);
        return { ok: false, reason: 'no-subscriber-id' };
    }
    const url = 'https://api.manychat.com/whatsapp/sending/sendFlow';
    const body = {
        subscriber_id: subscriberId,
        flow_ns: flowNs,
        data: dataOpt || {}
    };
    try {
        const r = await axios.post(url, body, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000,
            validateStatus: () => true
        });
        const ok = r.status >= 200 && r.status < 300 && (r.data?.status || 'success') === 'success';
        if (!ok) {
            console.warn(`[${contato}] sendManychatWaFlow: HTTP ${r.status} body=${JSON.stringify(r.data).slice(0, 400)}`);
            return { ok: false, status: r.status, body: r.data };
        }
        console.log(`[${contato}] sendManychatWaFlow OK flow_ns=${flowNs} subscriber_id=${subscriberId}`);
        return { ok: true };
    } catch (e) {
        console.warn(`[${contato}] sendManychatWaFlow erro: ${e?.message || e}`);
        return { ok: false, error: e?.message || String(e) };
    }
}

module.exports = {
    resolveManychatSubscriberId,
    sendMessage,
    updateManyChatCustomFieldByName,
    sendImage,
    sendManychatWaFlow
};
