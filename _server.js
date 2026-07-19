// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const associadosRoutes = require('./routes/associados');
const cobrancasRoutes = require('./routes/cobrancas');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/associados', associadosRoutes);
app.use('/cobrancas', cobrancasRoutes);

app.get('/', (req, res) => {
    res.json({ status: 'ok', servico: 'plataforma-associacoes-api' });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`Servidor rodando na porta ${PORTA}`);
});