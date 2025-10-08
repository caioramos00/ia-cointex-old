const { normalizeContato } = require('./utils.js');
const estadoContatos = require('./state.js');

function ensureEstado(contato) {
    const normalized = normalizeContato(contato);
    if (!estadoContatos[normalized]) {
        estadoContatos[normalized] = {
            contato: normalized,
            etapa: 'abertura:send',
        };
    }
    return estadoContatos[normalized];
}

module.exports = {
    ensureEstado
};
