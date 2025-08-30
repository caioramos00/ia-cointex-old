const { Pool } = require('pg');
const readline = require('readline');

// Configuração da conexão
const pool = new Pool({
  connectionString: 'postgresql://ia_cointex_old_db_user:qa1WarpW5slKDmGgGYjIRpanL6RnpbLa@dpg-d2p9pumr433s73d1geg0-a.oregon-postgres.render.com/ia_cointex_old_db',
  ssl: { rejectUnauthorized: false }
});

// Função para resetar (cria tabela se não existir, depois apaga dados)
async function resetDatabase() {
  const client = await pool.connect();
  try {
    // Cria tabela se não existir
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
    console.log('Tabela "contatos" criada ou já existe.');

    // Apaga dados
    await client.query('DELETE FROM contatos');
    console.log('Todos os dados da tabela "contatos" foram apagados com sucesso.');
  } catch (error) {
    console.error('Erro ao resetar dados:', error.message);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
}

// Prompt de confirmação
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Tem certeza que deseja resetar (criar se necessário e apagar) TODO o conteúdo do banco de dados? Isso é irreversível! Digite "SIM" para confirmar: ', (answer) => {
  if (answer.trim().toUpperCase() === 'SIM') {
    console.log('Resetando dados...');
    resetDatabase();
  } else {
    console.log('Operação cancelada.');
    rl.close();
    process.exit(0);
  }
});