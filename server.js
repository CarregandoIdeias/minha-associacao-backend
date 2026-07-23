// server.js
require('dotenv').config();
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

app.use(cors());
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

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`Servidor rodando na porta ${PORTA}`);

    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'troque-isso-em-producao') {
        console.warn(
            '\n⚠️  AVISO DE SEGURANÇA: a variável de ambiente JWT_SECRET não está definida ' +
            'ou está usando o valor padrão de exemplo. Qualquer pessoa com esse valor pode ' +
            'forjar tokens de acesso. Defina um JWT_SECRET forte e único nas variáveis de ' +
            'ambiente do Render antes de usar em produção.\n'
        );
    }
});
