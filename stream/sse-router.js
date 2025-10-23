'use strict';
const express = require('express');
const { bus } = require('./events-bus');

const sseRouter = express.Router();

function checkAuth(req) {
    const want = (process.env.STREAM_TOKEN || '').trim();
    if (!want) return true;
    const h = String(req.get('authorization') || '');
    if (!h.toLowerCase().startsWith('bearer ')) return false;
    const got = h.slice(7).trim();
    return got && got === want;
}

sseRouter.get('/api/stream', (req, res) => {
    if (!checkAuth(req)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try { res.flushHeaders && res.flushHeaders(); } catch { }
    res.write(`event: ready\ndata: {}\n\n`);

    const HEARTBEAT_MS = 15000;
    const ping = setInterval(() => {
        safeWrite(res, `event: ping\ndata: {}\n\n`);
    }, HEARTBEAT_MS);

    const onEvt = (evt) => {
        const id = String(evt.id || '');
        const type = String(evt.type || 'message');
        const data = JSON.stringify(evt);
        const chunk = (id ? `id: ${id}\n` : '') + `event: ${type}\n` + `data: ${data}\n\n`;
        safeWrite(res, chunk);
    };
    bus.on('evt', onEvt);

    req.on('close', () => {
        clearInterval(ping);
        bus.off('evt', onEvt);
        try { res.end(); } catch { }
    });
});

function safeWrite(res, chunk) {
    try {
        const ok = res.write(chunk);
        if (ok === false) {
            try { res.end(); } catch { }
        }
    } catch {
        try { res.end(); } catch { }
    }
}

module.exports = { sseRouter };
