const { Pool } = require('pg');

let _settingsCache = null;
let _settingsCacheTs = 0;
const SETTINGS_TTL_MS = 60_000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // ajustes para robustez em produção
  keepAlive: true,
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 5000),
});

// EVITA derrubar o processo quando um cliente do pool falha durante restart do Postgres
pool.on('error', (err) => {
  console.error('[PG][POOL][ERROR]', { code: err?.code, message: err?.message });
  // não relança o erro aqui
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
    await client.query(`
      ALTER TABLE contatos
      ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS do_not_contact_at TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS do_not_contact_reason TEXT,
      ADD COLUMN IF NOT EXISTS opt_out_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS permanently_blocked BOOLEAN DEFAULT FALSE
    `);
    console.log('[DB] Colunas de opt-out OK.');

    await client.query(`
      ALTER TABLE contatos
      ADD COLUMN IF NOT EXISTS meta_phone_number_id VARCHAR(50) DEFAULT '';
    `);
    console.log('[DB] Coluna meta_phone_number_id em contatos OK.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_meta_numbers (
        id SERIAL PRIMARY KEY,
        phone_number_id VARCHAR(50) NOT NULL UNIQUE,
        display_phone_number VARCHAR(50),
        access_token TEXT NOT NULL,
        label TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] Tabela bot_meta_numbers criada ou já existe.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        message_provider VARCHAR(50) DEFAULT 'meta',
        twilio_account_sid TEXT,
        twilio_auth_token TEXT,
        twilio_messaging_service_sid TEXT,
        twilio_from TEXT,
        manychat_api_token TEXT,
        manychat_fallback_flow_id TEXT,
        manychat_webhook_secret TEXT,
        contact_token TEXT,
        graph_api_access_token TEXT,  // Token global para Graph API (page_id)
        identity_enabled BOOLEAN DEFAULT FALSE,
        identity_label TEXT,
        support_email TEXT,
        support_phone TEXT,
        support_url TEXT,
        optout_hint_enabled BOOLEAN DEFAULT FALSE,
        optout_suffix TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] Tabela bot_settings criada ou já existe.');

    await client.query(`
      ALTER TABLE bot_settings ADD CONSTRAINT bot_settings_singleton CHECK (id = 1) NOT VALID;
    `).catch(() => { });

    await client.query(`
      INSERT INTO bot_settings (id, message_provider)
      VALUES (1, 'meta')
      ON CONFLICT (id) DO NOTHING;
    `);
    console.log('[DB] Linha singleton em bot_settings OK.');

  } catch (error) {
    console.error('[DB] Erro ao inicializar tabela:', error.message);
    throw error; // deixa o chamador decidir como proceder (com backoff no index.js)
  } finally {
    client.release();
  }
}

async function getBotSettings({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && _settingsCache && now - _settingsCacheTs < SETTINGS_TTL_MS) return _settingsCache;

  const { rows } = await pool.query(`
    SELECT
      id, message_provider,
      twilio_account_sid, twilio_auth_token, twilio_messaging_service_sid, twilio_from,
      manychat_api_token, manychat_fallback_flow_id, manychat_webhook_secret,
      contact_token,
      graph_api_access_token,  // Token global para Graph API
      identity_enabled, identity_label, support_email, support_phone, support_url,
      optout_hint_enabled, optout_suffix,
      updated_at
    FROM bot_settings
    WHERE id = 1
    LIMIT 1
  `);
  _settingsCache = rows[0] || { id: 1, message_provider: 'meta' };
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
    await client.query(`
      INSERT INTO bot_settings (id, message_provider)
      VALUES (1, 'meta')
      ON CONFLICT (id) DO NOTHING;
    `);

    const {
      identity_enabled, identity_label, support_email, support_phone, support_url,
      optout_hint_enabled, optout_suffix,
      message_provider,
      twilio_account_sid, twilio_auth_token, twilio_messaging_service_sid, twilio_from,
      manychat_api_token, manychat_fallback_flow_id, manychat_webhook_secret,
      contact_token,
      graph_api_access_token  // Novo campo
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
             manychat_webhook_secret = COALESCE($15, manychat_webhook_secret),
             contact_token = COALESCE($16, contact_token),
             graph_api_access_token = COALESCE($17, graph_api_access_token)
       WHERE id = 1
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
      manychat_webhook_secret || null,
      contact_token || null,
      graph_api_access_token || null
    ]);

    _settingsCache = null;
    _settingsCacheTs = 0;
  } finally {
    client.release();
  }
}

async function listMetaNumbers() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, phone_number_id, display_phone_number, access_token, active, created_at, updated_at
       FROM bot_meta_numbers
       ORDER BY id ASC`
    );
    return rows;
  } finally {
    client.release();
  }
}

async function getMetaNumberById(id) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at
       FROM bot_meta_numbers
       WHERE id = $1
       LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function getMetaNumberByPhoneNumberId(phoneNumberId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, phone_number_id, display_phone_number, access_token, active, created_at, updated_at
       FROM bot_meta_numbers
       WHERE phone_number_id = $1
       AND active = TRUE
       LIMIT 1`,
      [phoneNumberId]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function getDefaultMetaNumber() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, phone_number_id, display_phone_number, access_token, active, created_at, updated_at
       FROM bot_meta_numbers
       WHERE active = TRUE
       ORDER BY id ASC
       LIMIT 1`
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function createMetaNumber({
  phone_number_id,
  display_phone_number,
  access_token,
  active = true,
}) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO bot_meta_numbers (
         phone_number_id, display_phone_number, access_token, active
       )
       VALUES ($1, $2, $3, $4)
       RETURNING id, phone_number_id, display_phone_number, access_token, active, created_at, updated_at`,
      [phone_number_id, display_phone_number || null, access_token, !!active]
    );
    return rows[0];
  } finally {
    client.release();
  }
}

async function updateMetaNumber(
  id,
  {
    phone_number_id,
    display_phone_number,
    access_token,
    active = true,
  }
) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE bot_meta_numbers
       SET phone_number_id = $2,
           display_phone_number = $3,
           access_token = $4,
           active = $5,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, phone_number_id, display_phone_number, access_token, active, created_at, updated_at`,
      [id, phone_number_id, display_phone_number || null, access_token, !!active]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function deleteMetaNumber(id) {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM bot_meta_numbers WHERE id = $1`, [id]);
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

async function deleteContatosByIds(ids = []) {
  const normIds = (ids || [])
    .map((v) => String(v || '').replace(/\D/g, ''))
    .filter((v, idx, arr) => v && arr.indexOf(v) === idx);

  if (!normIds.length) return 0;

  const client = await pool.connect();
  try {
    const result = await client.query(
      'DELETE FROM contatos WHERE id = ANY($1::text[])',
      [normIds]
    );
    console.log(
      `[DB] deleteContatosByIds: removidos ${result.rowCount} contatos (ids=${normIds.join(',')})`
    );
    return result.rowCount;
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
  listMetaNumbers,
  getMetaNumberById,
  getMetaNumberByPhoneNumberId,
  getDefaultMetaNumber,
  createMetaNumber,
  updateMetaNumber,
  deleteMetaNumber,
  deleteContatosByIds
};