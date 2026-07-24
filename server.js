// server.js
require('dotenv').config();
const config = require('./config/env'); // valida/derruba o processo se faltar variável obrigatória em produção

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const associadosRoutes = require('./routes/associados');
const cobrancasRoutes = require('./routes/cobrancas');
const comunicadosRoutes = require('./routes/comunicados');
const usuariosRoutes = require('./routes/usuarios');
const portalRoutes = require('./routes/portal');
const configuracoesRoutes = require('./routes/configuracoes');
const superadminRoutes = require('./routes/superadmin');

const app = express();

app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '6mb' }));

app.use('/auth', authRoutes);
app.use('/associados', associadosRoutes);
app.use('/cobrancas', cobrancasRoutes);
app.use('/comunicados', comunicadosRoutes);
app.use('/usuarios', usuariosRoutes);
app.use('/portal', portalRoutes);
app.use('/configuracoes', configuracoesRoutes);
app.use('/superadmin', superadminRoutes);

app.get('/', (req, res) => {
    res.json({ status: 'ok', servico: 'plataforma-associacoes-api' });
});

app.listen(config.port, () => {
    console.log(`Servidor rodando na porta ${config.port}`);
});
