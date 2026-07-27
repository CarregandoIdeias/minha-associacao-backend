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

module.exports = { limiteLogin, limiteRedefinicao, limiteGeral };
