// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const env = require('./config/env');

const authRoutes = require('./routes/auth');
const associadosRoutes = require('./routes/associados');
const cobrancasRoutes = require('./routes/cobrancas');
const comunicadosRoutes = require('./routes/comunicados');
const usuariosRoutes = require('./routes/usuarios');
const portalRoutes = require('./routes/portal');
const configuracoesRoutes = require('./routes/configuracoes');
const superadminRoutes = require('./routes/superadmin');

const app = express();

app.use(cors({
    origin(origin, callback) {
        // Chamadas sem Origin (health checks, Postman e servidor-a-servidor) não são navegadores.
        if (!origin || env.corsOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origem não permitida pelo CORS.'));
    },
}));
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

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.use((err, req, res, next) => {
    if (err.message === 'Origem não permitida pelo CORS.') {
        return res.status(403).json({ erro: err.message });
    }

    console.error(err);
    return res.status(500).json({ erro: 'Erro interno do servidor' });
});

app.listen(env.port, () => {
    console.log(`Servidor rodando na porta ${env.port}`);
});
