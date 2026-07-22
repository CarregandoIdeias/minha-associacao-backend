// middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db');
const env = require('../config/env');

const JWT_SECRET = env.jwtSecret;

// Verifica o token e disponibiliza os dados do usuário em req.usuario
function autenticar(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const token = header.split(' ')[1];

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.usuario = payload; // { id, associacao_id, papel, email }
        next();
    } catch (err) {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
}

// Garante que só determinados papéis acessem a rota
// Uso: autorizar('admin', 'diretoria')
function autorizar(...papeisPermitidos) {
    return (req, res, next) => {
        if (!req.usuario || !papeisPermitidos.includes(req.usuario.papel)) {
            return res.status(403).json({ erro: 'Acesso não permitido para esse papel' });
        }
        next();
    };
}

// Abre uma conexão dedicada do pool e ativa o isolamento por tenant (RLS).
// Necessário porque "SET" é por conexão, não pode usar pool.query direto
// quando o isolamento depende de estado de sessão.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function comConexaoTenant(associacaoId) {
    if (!UUID_REGEX.test(associacaoId)) {
        throw new Error('associacaoId inválido');
    }
    const client = await pool.connect();
    await client.query(`SET app.current_associacao_id = '${associacaoId}'`);
    return client; // lembrar de chamar client.release() depois de usar
}

// Verifica o token de SUPER-ADMIN (separado do login das associações)
function autenticarSuperAdmin(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const token = header.split(' ')[1];

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.tipo !== 'superadmin') {
            return res.status(403).json({ erro: 'Acesso restrito ao super-admin' });
        }
        req.superAdmin = payload; // { id, email, tipo }
        next();
    } catch (err) {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
}

module.exports = { autenticar, autorizar, comConexaoTenant, autenticarSuperAdmin };
