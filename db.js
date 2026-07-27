// db.js
// Pool de conexão com o Postgres.
// Configure a variável de ambiente DATABASE_URL no Render/Railway,
// ex: postgres://usuario:senha@host:5432/banco

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config/env');

// CA própria do Supabase (Supabase Root 2021 CA + Supabase Intermediate 2021
// CA) — não é uma CA pública, então rejectUnauthorized:true sozinho falha.
// Certificado, não é segredo: é público por natureza, pode ficar no git.
const supabaseCa = fs.readFileSync(path.join(__dirname, 'config', 'supabase-ca.pem'), 'utf8');

const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.isProduction ? { rejectUnauthorized: true, ca: supabaseCa } : false,
    // Padrão do pg é 10s -- baixo demais para o padrão de uso real (gaps
    // entre cliques do usuário são comuns), o que força o pool a abrir
    // conexões novas com frequência. Cada conexão nova pela primeira vez é
    // onde os erros intermitentes do pooler do Supabase têm aparecido.
    idleTimeoutMillis: 30000,
    // Explícito (era o padrão implícito de 10 do pg) -- ver comentário em
    // config/env.js sobre DB_POOL_MAX: multiplica por instância ao escalar
    // horizontalmente no Render, então o limite do Session Pooler do
    // Supabase precisa ser conferido antes de aumentar o nº de instâncias.
    max: config.poolMax,
    // Sem isso, pool.connect() espera para sempre quando o pool está cheio: a
    // requisição fica pendurada sem erro nenhum (parece "o sistema travou").
    // Com timeout, vira um erro claro, que agora o error handler de server.js
    // converte em 500 -- ruim, mas diagnosticável e sem prender o navegador.
    // (Só client-side -- um setTimeout local, não manda nada a mais pro
    // servidor -- por isso é seguro mesmo com o Session Pooler.)
    connectionTimeoutMillis: 10000,
    // REMOVIDO (26/07/2026): `statement_timeout` aqui vira parâmetro do
    // pacote de STARTUP da conexão (node_modules/pg/lib/client.js, não um
    // `SET` depois de conectar). Coincidiu com autenticar() passar a falhar
    // ~100% das vezes em produção com "invalid input syntax for type uuid:
    // ''" -- o sintoma documentado de "resposta de outra query vazando pela
    // conexão" (ver CLAUDE.md, sessão 25/07), só que virando praticamente
    // sempre em vez de raro. Suspeita: o Session Pooler do Supabase
    // (PgBouncer) não repassa esse parâmetro de startup do jeito esperado
    // pro backend, deixando a conexão num estado inconsistente desde a
    // abertura. Voltar a usar SET statement_timeout por conexão, depois de
    // conectar, se precisar reintroduzir -- não pelo startup packet.
});

// Sem esse listener, um cliente ocioso no pool que tenha a conexão encerrada
// pelo banco (o Supabase derruba conexões ociosas periodicamente) emite um
// evento 'error' não tratado no pool -- e isso derruba o processo Node
// inteiro. É a causa real por trás dos 500 intermitentes e em rajada que
// apareciam em várias rotas ao mesmo tempo (o Render reinicia o serviço,
// e as requisições em trânsito nessa janela falham).
pool.on('error', (err) => {
    console.error('Erro inesperado em cliente ocioso do pool de conexões:', err);
});

module.exports = pool;
