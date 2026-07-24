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
});

module.exports = pool;
