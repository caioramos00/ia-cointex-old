#!/usr/bin/env node
/**
 * Seta a etapa de um contato (DB e, se disponível, runtime).
 *
 * Uso:
 *   DATABASE_URL="postgres://user:pass@host/db" node helpers/set_stage.js <phoneDigits> <etapa> [--yes]
 *   # com sync de memória (opcional):
 *   ADMIN_URL="http://localhost:3000" ADMIN_TOKEN="token" DATABASE_URL="..." node helpers/set_stage.js 5511999999999 acesso --yes
 */
const { Pool } = require('pg');
const https = require('https');
const http = require('http');

function onlyDigits(v){ return String(v||'').replace(/\D/g,''); }
function mapStage(x){
  const s = String(x||'').toLowerCase();
  const alias = {
    'abertura':'abertura',
    'interesse':'interesse',
    'instrucoes':'instruções', 'instruções':'instruções', 'instrucao':'instruções', 'instrução':'instruções',
    'acesso':'acesso',
    'confirmacao':'confirmacao','confirmação':'confirmacao',
    'saque':'saque',
    'validacao':'validacao','validação':'validacao',
    'encerrado':'encerrado'
  };
  if(!alias[s]) throw new Error(`Etapa inválida: ${x}`);
  return alias[s];
}

(async ()=>{
  try{
    const phone = onlyDigits(process.argv[2]);
    const stageRaw = process.argv[3];
    const YES = process.argv.includes('--yes');
    if(!phone || !stageRaw){
      console.error('Uso: node helpers/set_stage.js <phoneDigits> <etapa> [--yes]');
      process.exit(1);
    }
    const etapa = mapStage(stageRaw);

    const connStr = process.env.DATABASE_URL;
    if(!connStr){ console.error('Faltou DATABASE_URL'); process.exit(1); }

    const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized:false } });
    const c = await pool.connect();
    try{
      await c.query('BEGIN');

      // garante linha
      const rows = await c.query('SELECT id FROM contatos WHERE id=$1 LIMIT 1',[phone]);
      if(!rows.rowCount){
        await c.query('INSERT INTO contatos (id, etapa, etapa_atual, status, ultima_interacao, historico, historico_interacoes) VALUES ($1,$2,$2,$3,NOW(),\'[]\',\'[]\')',
          [phone, etapa, 'ativo']);
        console.log('[DB] contato criado.');
      }else{
        await c.query(`UPDATE contatos
                          SET etapa=$2, etapa_atual=$2, status='ativo', ultima_interacao=NOW()
                        WHERE id=$1`, [phone, etapa]);
        console.log('[DB] etapa atualizada para:', etapa);
      }
      await c.query('COMMIT');
    }catch(e){
      await c.query('ROLLBACK'); throw e;
    }finally{
      c.release(); await pool.end();
    }

    // opcional: sincroniza memória do processo (se você habilitar a rota abaixo)
    if(process.env.ADMIN_URL && process.env.ADMIN_TOKEN){
      const url = new URL('/_debug/set-stage', process.env.ADMIN_URL);
      const body = JSON.stringify({ phone, etapa });
      const lib = url.protocol === 'https:' ? https : http;
      await new Promise((resolve,reject)=>{
        const req = lib.request({
          method:'POST', hostname:url.hostname, port:url.port, path:url.pathname,
          headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body), 'X-Admin-Token':process.env.ADMIN_TOKEN }
        }, res=>{
          let data=''; res.on('data',d=>data+=d); res.on('end',()=>{ 
            console.log('[ADMIN] resposta', res.statusCode, data||''); 
            resolve();
          });
        });
        req.on('error',reject); req.write(body); req.end();
      }).catch(()=>console.warn('[ADMIN] não consegui sincronizar memória (rota indisponível).'));
    }else{
      console.log('Obs.: para sincronizar o estado em memória, exporte ADMIN_URL/ADMIN_TOKEN e adicione a rota abaixo no seu servidor.');
    }
  }catch(e){
    console.error('[ERRO]', e.message); process.exit(1);
  }
})();
