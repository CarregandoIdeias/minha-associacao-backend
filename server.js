// server.js
require('dotenv').config();
const config = require('./config/env'); // valida/derruba o processo se faltar variável obrigatória em produção

const express = require('express');
// Faz exceção em handler async chegar no error handler do Express 4 (que
// sozinho só pega erro síncrono). Sem isso, o handler no fim deste arquivo
// nunca rodaria e a requisição ficaria pendurada -- ver comentário lá.
// Precisa vir logo depois do require('express').
require('express-async-errors');
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
const sprintRoutes = require('./routes/sprint');
const auditoriaRoutes = require('./routes/auditoria');

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
app.use('/sprint', sprintRoutes);
app.use('/auditoria', auditoriaRoutes);

app.get('/', (req, res) => {
    res.json({ status: 'ok', servico: 'plataforma-associacoes-api' });
});

// Rede de segurança: no Express 4, uma exceção lançada dentro de um handler
// async NÃO vira resposta de erro -- vira rejeição não tratada, e a requisição
// fica pendurada até o navegador desistir (sintoma: "o sistema trava/está
// instável", sem nenhum erro na tela). Isso acontecia de verdade quando o pool
// entregava uma conexão já derrubada pelo Supabase, porque toda rota faz
// `const client = await comConexaoX()` antes do try.
//
// A causa principal foi corrigida em middleware/auth.js (comConexaoComSessao
// descarta a conexão morta e tenta outra). Este handler é o cinto de segurança
// para qualquer outro caso: sempre devolve uma resposta.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    // Corpo que não é JSON válido é erro do CLIENTE (400), não do servidor.
    // O express.json() lança SyntaxError nesse caso, que caía direto no 500
    // abaixo -- achado do QA de 07/08/2026. Um 500 aqui é ruim de duas
    // formas: faz parecer que a aplicação quebrou e polui o log de erro real
    // com ruído de requisição malformada.
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ erro: 'Corpo da requisição não é um JSON válido' });
    }
    // Corpo acima do limite do express.json() -- também é 4xx, não 5xx.
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ erro: 'Requisição grande demais' });
    }

    console.error('Erro não tratado em', req.method, req.originalUrl, '->', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
});

// Rejeição fora do ciclo de requisição (ex.: falha em log assíncrono): registra
// em vez de deixar o processo morrer silenciosamente.
process.on('unhandledRejection', (err) => {
    console.error('Rejeição não tratada fora de requisição:', err);
});

app.listen(config.port, () => {
    console.log(`Servidor rodando na porta ${config.port}`);
});
