// server.js
require('dotenv').config();
const config = require('./config/env'); // valida/derruba o processo se faltar variável obrigatória em produção

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { limiteGeral } = require('./middleware/rateLimiter');

const authRoutes = require('./routes/auth');
const associadosRoutes = require('./routes/associados');
const cobrancasRoutes = require('./routes/cobrancas');
const comunicadosRoutes = require('./routes/comunicados');
const usuariosRoutes = require('./routes/usuarios');
const portalRoutes = require('./routes/portal');
const configuracoesRoutes = require('./routes/configuracoes');
const superadminRoutes = require('./routes/superadmin');
const atividadesRoutes = require('./routes/atividades');
const planoRoutes = require('./routes/plano');

const app = express();

// O Render coloca o app atrás de um proxy reverso (1 hop) -- sem isso,
// req.ip (usado pelo express-rate-limit no login) enxerga o IP interno do
// proxy pra todo mundo, e o limite de tentativas vira compartilhado entre
// todos os clientes em vez de por-IP de verdade.
app.set('trust proxy', 1);

// Cabeçalhos de segurança. A CSP do helmet vem desligada de propósito: esta
// API só devolve JSON (o front é servido pela Vercel, com CSP própria em
// painel/vercel.json) e a CSP padrão do helmet só atrapalharia a resposta de
// erro em HTML do Express sem agregar proteção real aqui.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({ origin: config.corsOrigins }));
// Antes de express.json() de propósito -- rejeita rajadas antes de gastar
// tempo fazendo parse de corpo grande. /auth/login e /auth/redefinir-senha
// já têm limites mais apertados (limiteLogin/limiteRedefinicao), que somam
// com este (as duas checagens precisam passar).
app.use(limiteGeral);
app.use(express.json({ limit: '6mb' }));

app.use('/auth', authRoutes);
app.use('/associados', associadosRoutes);
app.use('/cobrancas', cobrancasRoutes);
app.use('/comunicados', comunicadosRoutes);
app.use('/usuarios', usuariosRoutes);
app.use('/portal', portalRoutes);
app.use('/configuracoes', configuracoesRoutes);
app.use('/superadmin', superadminRoutes);
app.use('/atividades', atividadesRoutes);
app.use('/plano', planoRoutes);

app.get('/', (req, res) => {
    res.json({ status: 'ok', servico: 'plataforma-associacoes-api' });
});

app.listen(config.port, () => {
    console.log(`Servidor rodando na porta ${config.port}`);
});
