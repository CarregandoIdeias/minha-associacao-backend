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

module.exports = { limiteLogin, limiteRedefinicao };
