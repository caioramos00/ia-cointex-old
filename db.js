// db.js
const { Pool } = require('pg');

let _settingsCache = null;
let _settingsCacheTs = 0;
const SETTINGS_TTL_MS = 60_000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS contatos (
        id VARCHAR(255) PRIMARY KEY,
        grupos JSONB DEFAULT '[]',
        status VARCHAR(50) DEFAULT 'ativo',
        etapa VARCHAR(50) DEFAULT 'abertura',
        ultima_interacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        historico JSONB DEFAULT '[]',
        conversou VARCHAR(3) DEFAULT 'Não',
        etapa_atual VARCHAR(50) DEFAULT 'abertura',
        historico_interacoes JSONB DEFAULT '[]'
      );
    `);
    console.log('[DB] Tabela contatos criada ou já existe.');

    await client.query(`
      ALTER TABLE contatos
      ADD COLUMN IF NOT EXISTS tid VARCHAR(255) DEFAULT '',
      ADD COLUMN IF NOT EXISTS click_type VARCHAR(50) DEFAULT 'Orgânico';
    `);
    console.log('[DB] Colunas tid e click_type adicionadas ou já existem.');

    await client.query(`
      ALTER TABLE contatos
      ADD COLUMN IF NOT EXISTS manychat_subscriber_id VARCHAR(32);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_contatos_manychat_subscriber_id
      ON contatos (manychat_subscriber_id);
    `);
    console.log('[DB] Coluna manychat_subscriber_id OK.');
  } catch (error) {
    console.error('[DB] Erro ao inicializar tabela:', error.message);
  } finally {
    client.release();
  }
}

async function ensureDefaultSettings(client) {
  const { rows } = await client.query('SELECT id FROM bot_settings ORDER BY id ASC LIMIT 1');
  if (!rows.length) {
    await client.query("INSERT INTO bot_settings (message_provider) VALUES ('meta')");
  }
}

async function getBotSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheTs < SETTINGS_TTL_MS) return _settingsCache;

  const { rows } = await pool.query(`
    SELECT
      id, message_provider,
      twilio_account_sid, twilio_auth_token, twilio_messaging_service_sid, twilio_from,
      manychat_api_token, manychat_fallback_flow_id, manychat_webhook_secret,
      identity_enabled, identity_label, support_email, support_phone, support_url,
      optout_hint_enabled, optout_suffix,
      updated_at
    FROM bot_settings
    ORDER BY id ASC
    LIMIT 1
  `);
  _settingsCache = rows[0] || { message_provider: 'meta' };
  _settingsCacheTs = now;
  return _settingsCache;
}

async function getContatoByPhone(phone) {
  const id = String(phone || '').replace(/\D/g, '');
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM contatos WHERE id = $1 LIMIT 1', [id]);
    return rows[0] || null;
  } finally { client.release(); }
}

async function updateBotSettings(payload) {
  const client = await pool.connect();
  try {
    await ensureDefaultSettings(client);

    const {
      identity_enabled, identity_label, support_email, support_phone, support_url,
      optout_hint_enabled, optout_suffix,
      message_provider,
      twilio_account_sid, twilio_auth_token, twilio_messaging_service_sid, twilio_from,
      manychat_api_token, manychat_fallback_flow_id, manychat_webhook_secret
    } = payload;

    await client.query(`
      UPDATE bot_settings
         SET identity_enabled = COALESCE($1, identity_enabled),
             identity_label   = COALESCE($2, identity_label),
             support_email    = COALESCE($3, support_email),
             support_phone    = COALESCE($4, support_phone),
             support_url      = COALESCE($5, support_url),
             optout_hint_enabled = COALESCE($6, optout_hint_enabled),
             optout_suffix    = COALESCE($7, optout_suffix),
             message_provider = COALESCE($8, message_provider),
             twilio_account_sid = COALESCE($9, twilio_account_sid),
             twilio_auth_token = COALESCE($10, twilio_auth_token),
             twilio_messaging_service_sid = COALESCE($11, twilio_messaging_service_sid),
             twilio_from = COALESCE($12, twilio_from),
             manychat_api_token = COALESCE($13, manychat_api_token),
             manychat_fallback_flow_id = COALESCE($14, manychat_fallback_flow_id),
             manychat_webhook_secret = COALESCE($15, manychat_webhook_secret)
       WHERE id = (SELECT id FROM bot_settings ORDER BY id ASC LIMIT 1)
    `, [
      (typeof identity_enabled === 'boolean') ? identity_enabled : null,
      identity_label || null,
      support_email || null,
      support_phone || null,
      support_url || null,
      (typeof optout_hint_enabled === 'boolean') ? optout_hint_enabled : null,
      optout_suffix || null,
      message_provider || null,
      twilio_account_sid || null,
      twilio_auth_token || null,
      twilio_messaging_service_sid || null,
      twilio_from || null,
      manychat_api_token || null,
      manychat_fallback_flow_id || null,
      manychat_webhook_secret || null
    ]);

    _settingsCache = null;
    _settingsCacheTs = 0;
  } finally {
    client.release();
  }
}

async function salvarContato(contatoId, grupoId = null, mensagem = null, tid = '', click_type = 'Orgânico') {
  try {
    const agora = new Date().toISOString();
    const client = await pool.connect();
    try {
      const res = await client.query('SELECT * FROM contatos WHERE id = $1', [contatoId]);
      let contatoExistente = res.rows[0];

      if (!contatoExistente) {
        await client.query(`
          INSERT INTO contatos (id, grupos, status, etapa, ultima_interacao, historico, conversou, etapa_atual, historico_interacoes, tid, click_type)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          contatoId,
          grupoId ? JSON.stringify([{ id: grupoId, dataEntrada: agora }]) : '[]',
          'ativo',
          'abertura',
          agora,
          mensagem ? JSON.stringify([{ data: agora, mensagem }]) : '[]',
          'Não',
          'abertura',
          '[]',
          tid,
          click_type
        ]);
        console.log(`[DB] Contato novo salvo: ${contatoId}`);
      } else {
        let grupos = contatoExistente.grupos || [];
        if (grupoId && !grupos.some(g => g.id === grupoId)) {
          grupos.push({ id: grupoId, dataEntrada: agora });
        }
        let historico = contatoExistente.historico || [];
        if (mensagem) historico.push({ data: agora, mensagem });

        await client.query(`
          UPDATE contatos SET
            grupos = $1,
            ultima_interacao = $2,
            status = $3,
            historico = $4,
            tid = $5,
            click_type = $6 
          WHERE id = $7
        `, [JSON.stringify(grupos), agora, 'ativo', JSON.stringify(historico), tid, click_type, contatoId]);
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`[Erro] Falha ao salvar contato ${contatoId}: ${error.message}`);
  }
}

async function atualizarContato(contato, conversou, etapa_atual, mensagem = null, temMidia = false) {
  try {
    const client = await pool.connect();
    try {
      const res = await client.query('SELECT * FROM contatos WHERE id = $1', [contato]);
      if (res.rows.length === 0) {
        console.error(`[${contato}] Contato não encontrado no DB`);
        return;
      }
      let historicoInteracoes = res.rows[0].historico_interacoes || [];
      if (mensagem) {
        historicoInteracoes.push({
          mensagem,
          data: new Date().toISOString(),
          etapa: etapa_atual,
          tem_midia: temMidia
        });
      }
      await client.query(`
        UPDATE contatos SET
          conversou = $1,
          etapa_atual = $2,
          historico_interacoes = $3
        WHERE id = $4
      `, [conversou, etapa_atual, JSON.stringify(historicoInteracoes), contato]);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`[Erro] Falha ao atualizar contato ${contato}: ${error.message}`);
  }
}

async function setManychatSubscriberId(phone, subscriberId) {
  const id = String(phone || '').replace(/\D/g, '');
  const sid = String(subscriberId || '').replace(/\D/g, '');
  if (!id || !sid) return;

  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO contatos (id, manychat_subscriber_id, status, etapa, ultima_interacao)
      VALUES ($1, $2, 'ativo', 'abertura', NOW())
      ON CONFLICT (id) DO UPDATE
        SET manychat_subscriber_id = EXCLUDED.manychat_subscriber_id,
            ultima_interacao = NOW();
    `, [id, sid]);
    console.log(`[DB] Vinculado ManyChat subscriber_id=${sid} ao contato ${id}`);
  } finally {
    client.release();
  }
}

module.exports = {
  initDatabase,
  salvarContato,
  atualizarContato,
  getBotSettings,
  updateBotSettings,
  pool,
  getContatoByPhone,
  setManychatSubscriberId,
};
