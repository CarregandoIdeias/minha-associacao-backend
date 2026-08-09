// middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

// Limite para login: no máximo 10 tentativas a cada 15 minutos, por IP.
// Suficiente para alguém que errou a senha algumas vezes, mas trava tentativas
// automatizadas de força bruta.
const limiteLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.' }
});

// Limite mais permissivo para redefinição de senha (o token já é o segredo
// difícil de adivinhar, mas ainda vale limitar tentativas repetidas)
const limiteRedefinicao = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.' }
});

// Limite geral, aplicado a toda a API (server.js) -- as rotas de negócio
// nunca tinham limite nenhum antes disso. Corta rajada de cliente com bug ou
// abuso, sem atrapalhar uso real.
//
// O limite é por IP, e várias pessoas da mesma associação normalmente saem
// pelo mesmo IP (escritório//NAT) -- ou seja, elas dividem essa cota. Com 300
// isso apertava rápido: só abrir o Dashboard já dispara 5 chamadas, e cada
// troca de aba soma mais. Login e redefinição de senha continuam com limites
// próprios e bem mais rígidos (limiteLogin/limiteRedefinicao), que é onde o
// controle de força bruta realmente importa.
const limiteGeral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas requisições. Aguarde alguns minutos antes de tentar de novo.' }
});

// A partir daqui: limitadores novos da auditoria de segurança Fase 2
// (08/08/2026, SEC-012/SEC-013) -- limiteGeral (1000/15min por IP) cobria
// exportações/uploads/bootstrap igual a qualquer outra rota, mas essas são
// mais caras que a média (PDF de até 5000 linhas em memória numa instância
// única do Render; upload de até ~2,8MB de base64 por requisição) e vale
// terem teto próprio, mais apertado.

// Exportação de PDF (auditoria/logs/leituras de comunicado).
const limiteExportacao = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas exportações em pouco tempo. Aguarde antes de tentar de novo.' }
});

// Upload de arquivo em base64 (foto do associado, logo da associação,
// comprovante de pagamento/contratação).
const limiteUpload = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitos envios de arquivo em pouco tempo. Aguarde antes de tentar de novo.' }
});

// POST /superadmin/bootstrap -- dá acesso total à plataforma pra quem
// acertar o BOOTSTRAP_SECRET. timingSafeEqual já protege o segredo em si
// (ver segredoValido em routes/superadmin.js), isto é só mais uma camada.
const limiteBootstrap = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.' }
});

// Bloqueio de login POR CONTA, não por IP -- limiteLogin sozinho deixa um
// atacante com muitos IPs tentar sem limite contra a mesma conta (SEC-013).
// Roda JUNTO com limiteLogin nas rotas de login (/auth/login,
// /superadmin/login), não no lugar dele: duas defesas independentes.
//
// keyGenerator lê req.body.email -- só funciona porque express.json() já
// rodou antes desses routers (server.js), então o corpo já está parseado
// quando este middleware executa. E-mail ausente/malformado cai num balde
// só ('sem-email'), que o próprio limiteLogin (por IP) já cobre.
const limiteLoginPorConta = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : 'sem-email'),
    message: { erro: 'Muitas tentativas para esta conta. Aguarde alguns minutos antes de tentar de novo.' }
});

module.exports = {
    limiteLogin,
    limiteRedefinicao,
    limiteGeral,
    limiteExportacao,
    limiteUpload,
    limiteBootstrap,
    limiteLoginPorConta,
};
