// db.js
// Pool de conexão com o Postgres.
// Configure a variável de ambiente DATABASE_URL no Render/Railway,
// ex: postgres://usuario:senha@host:5432/banco

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
