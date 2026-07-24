// db.js
// Pool de conexão com o Postgres.
// Configure a variável de ambiente DATABASE_URL no Render/Railway,
// ex: postgres://usuario:senha@host:5432/banco

const { Pool } = require('pg');
const config = require('./config/env');

const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.isProduction ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
