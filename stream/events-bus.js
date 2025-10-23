'use strict';
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);
let seq = 0;
function nextId() {
    const n = (seq = (seq + 1) % 1e9);
    return `${new Date().toISOString()}#${n}`;
}
function nowMs(ts) {
    if (!ts && ts !== 0) return Date.now();
    const n = Number(ts);
    return Number.isFinite(n) ? n : Date.now();
}

function publish(evt) {
    const base = {
        id: nextId(),
        ts: nowMs(evt.ts),
    };
    const payload = { ...base, ...evt };
    if (!payload.type) payload.type = 'message';
    bus.emit('evt', payload);
    return payload.id;
}

function publishMessage({ dir, wa_id, wamid, kind, text, media, tags, ts }) {
    return publish({
        type: 'message',
        dir: dir === 'out' ? 'out' : 'in',
        wa_id: String(wa_id || ''),
        wamid: wamid || '',
        kind: kind || (media ? (media.type || 'media') : 'text'),
        text: text || '',
        media: media || null,
        tags: Array.isArray(tags) ? tags : undefined,
        ts,
    });
}
function publishState({ wa_id, etapa, vars, ts }) {
    return publish({
        type: 'state',
        wa_id: String(wa_id || ''),
        etapa: etapa || '',
        vars: vars || undefined,
        ts,
    });
}
function publishAck({ wa_id, wamid, status, ts }) {
    return publish({
        type: 'ack',
        wa_id: String(wa_id || ''),
        wamid: wamid || '',
        status: status || 'delivered',
        ts,
    });
}

module.exports = {
    bus,
    publish,
    publishMessage,
    publishState,
    publishAck,
};
