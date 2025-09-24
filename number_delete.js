#!/usr/bin/env node
/**
 * Wipe/DELETE de histórico de um contato na tabela `contatos`.
 *
 * Uso:
 *   # Soft wipe (limpa histórico mas mantém o contato)
 *   DATABASE_URL="postgresql://user:pass@host/db" node scripts/wipe-contact.js 5511999999999 --yes
 *
 *   # Hard delete (apaga a linha inteira)
 *   DATABASE_URL="postgresql://user:pass@host/db" node scripts/wipe-contact.js 5511999999999 --hard --yes
 *
 *   # Também pode passar a URL via --url=...
 *   node scripts/wipe-contact.js 5511999999999 --url="postgresql://user:pass@host/db" --yes
 */
const { Pool } = require('pg');
const readline = require('readline');

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function getArgFlag(name) {
  return process.argv.some(a => a === `--${name}`);
}
function getArgKV(prefix) {
  const kv = process.argv.find(a => a.startsWith(`--${prefix}=`));
  return kv ? kv.split('=').slice(1).join('=') : null;
}

(async () => {
  try {
    const rawPhone = process.argv[2];
    if (!rawPhone) {
      console.error('Uso: node scripts/wipe-contact.js <phoneDigits> [--hard] [--yes] [--url=POSTGRES_URL]');
      process.exit(1);
    }
    const phone = onlyDigits(rawPhone);
    if (!phone) {
      console.error('Telefone inválido. Informe apenas números (ex.: 5511999999999).');
      process.exit(1);
    }

    const urlFromArg = getArgKV('url');
    const connStr = urlFromArg || process.env.DATABASE_URL;
    if (!connStr) {
      console.error('Faltou a conexão. Use env DATABASE_URL ou --url="postgresql://..."');
      process.exit(1);
    }

    const HARD = getArgFlag('hard');
    const AUTO_YES = getArgFlag('yes');

    const pool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false }
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verifica se o contato existe
      const existing = await client.query('SELECT * FROM contatos WHERE id = $1 LIMIT 1', [phone]);
      if (!existing.rows.length) {
        console.log(`[OK] Nenhum contato com id=${phone} encontrado. Nada a fazer.`);
        await client.query('ROLLBACK');
        process.exit(0);
      }

      // Lista colunas da tabela para montar UPDATE dinâmico
      const colsRes = await client.query(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_name = 'contatos'
      `);
      const cols = new Set(colsRes.rows.map(r => r.column_name));

      // Prévia
      const row = existing.rows[0];
      const historicoCount = Array.isArray(row.historico) ? row.historico.length : 0;
      const interCount = Array.isArray(row.historico_interacoes) ? row.historico_interacoes.length : 0;

      console.log('--- Prévia do contato ---');
      console.log(`id: ${row.id}`);
      if (cols.has('tid')) console.log(`tid: ${row.tid || ''}`);
      if (cols.has('click_type')) console.log(`click_type: ${row.click_type || ''}`);
      if (cols.has('manychat_subscriber_id')) console.log(`manychat_subscriber_id: ${row.manychat_subscriber_id || ''}`);
      console.log(`historico: ${historicoCount} evento(s)`);
      console.log(`historico_interacoes: ${interCount} evento(s)`);
      console.log(`grupos: ${Array.isArray(row.grupos) ? row.grupos.length : 0} grupo(s)`);
      console.log('-------------------------\n');

      const actionDesc = HARD ? 'APAGAR A LINHA (HARD DELETE)' : 'LIMPAR HISTÓRICO (SOFT WIPE)';
      if (!AUTO_YES) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(res => rl.question(
          `Confirma ${actionDesc} do contato ${phone}? Digite "DELETE" para confirmar: `,
          (ans) => { rl.close(); res(ans); }
        ));
        if (answer !== 'DELETE') {
          console.log('Cancelado.');
          await client.query('ROLLBACK');
          process.exit(0);
        }
      }

      let affected = 0;

      if (HARD) {
        const del = await client.query('DELETE FROM contatos WHERE id = $1', [phone]);
        affected = del.rowCount || 0;
        console.log(`[HARD] Linhas removidas em contatos: ${affected}`);
      } else {
        // Monta UPDATE dinâmico só com colunas existentes
        const sets = [];
        if (cols.has('grupos')) sets.push(`grupos = '[]'::jsonb`);
        if (cols.has('status')) sets.push(`status = 'ativo'`);
        if (cols.has('etapa')) sets.push(`etapa = 'abertura'`);
        if (cols.has('etapa_atual')) sets.push(`etapa_atual = 'abertura'`);
        if (cols.has('ultima_interacao')) sets.push(`ultima_interacao = NOW()`);
        if (cols.has('historico')) sets.push(`historico = '[]'::jsonb`);
        if (cols.has('historico_interacoes')) sets.push(`historico_interacoes = '[]'::jsonb`);
        if (cols.has('conversou')) sets.push(`conversou = 'Não'`);
        if (cols.has('tid')) sets.push(`tid = ''`);
        if (cols.has('click_type')) sets.push(`click_type = 'Orgânico'`);
        if (cols.has('manychat_subscriber_id')) sets.push(`manychat_subscriber_id = NULL`);

        if (!sets.length) {
          console.warn('Nenhuma coluna esperada foi encontrada para atualizar. Abortando.');
          await client.query('ROLLBACK');
          process.exit(1);
        }

        const sql = `UPDATE contatos SET ${sets.join(', ')} WHERE id = $1`;
        const up = await client.query(sql, [phone]);
        affected = up.rowCount || 0;
        console.log(`[SOFT] Linhas atualizadas em contatos: ${affected}`);
      }

      await client.query('COMMIT');
      console.log('\n[OK] Concluído com sucesso.');
      console.log(HARD
        ? 'O contato foi removido da tabela.'
        : 'O histórico foi limpo e o contato foi resetado para o estado inicial.');
      console.log('\nObservação: se o bot mantém estado em memória, reinicie o processo para limpar cache/estado desse contato.');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[ERRO] Transação revertida:', err.message);
      process.exit(1);
    } finally {
      client.release();
      await pool.end();
    }
  } catch (e) {
    console.error('[ERRO]', e.message);
    process.exit(1);
  }
})();
