const { Pool } = require('pg');

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
        historico_interacoes JSONB DEFAULT '[]',
        tid VARCHAR(255) DEFAULT '',  // Nova coluna para TID
        click_type VARCHAR(50) DEFAULT 'Orgânico'  // Nova coluna para click_type
      );
    `);
    console.log('[DB] Tabela contatos criada ou já existe.');
  } catch (error) {
    console.error('[DB] Erro ao inicializar tabela:', error.message);
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
          tid,  // Novo: Salva TID
          click_type  // Novo: Salva click_type
        ]);
        console.log(`[Contato] Novo contato salvo: ${contatoId}, TID: ${tid}, click_type: ${click_type}`);
      } else {
        let grupos = contatoExistente.grupos || [];
        if (grupoId && !grupos.some(g => g.id === grupoId)) {
          grupos.push({ id: grupoId, dataEntrada: agora });
        }
        let historico = contatoExistente.historico || [];
        if (mensagem) {
          historico.push({ data: agora, mensagem });
        }
        await client.query(`
          UPDATE contatos SET
            grupos = $1,
            ultima_interacao = $2,
            status = $3,
            historico = $4,
            tid = $5,  // Novo: Atualiza TID se necessário
            click_type = $6  // Novo: Atualiza click_type se necessário
          WHERE id = $7
        `, [JSON.stringify(grupos), agora, 'ativo', JSON.stringify(historico), tid, click_type, contatoId]);
        console.log(`[Contato] Contato atualizado: ${contatoId}, TID: ${tid}, click_type: ${click_type}`);
      }
    } finally {
      client.release();
    }
    console.log(`[DB] Contato ${contatoId} salvo`);
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
      console.log(`[${contato}] Contato atualizado: ${conversou}, ${etapa_atual}`);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`[Erro] Falha ao atualizar contato ${contato}: ${error.message}`);
  }
}

module.exports = { initDatabase, salvarContato, atualizarContato, pool };
