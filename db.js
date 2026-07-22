// db.js
// Pool de conexão com o Postgres.
// Configure a variável de ambiente DATABASE_URL no Render/Railway,
// ex: postgres://usuario:senha@host:5432/banco

const { Pool } = require('pg');
const env = require('./config/env');

const pool = new Pool({
    connectionString: env.databaseUrl,
    ssl: env.isProduction ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
