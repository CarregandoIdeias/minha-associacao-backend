// middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db');
const config = require('../config/env');

const JWT_SECRET = config.jwtSecret;

// Verifica o token e disponibiliza os dados do usuário em req.usuario.
// Também revalida contra o banco a cada requisição (usuário/associação
// ainda ativos, papel em dia) — sem isso, desativar alguém ou bloquear a
// associação só valeria depois do token expirar (até 8h depois).
async function autenticar(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const token = header.split(' ')[1];

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }

    const client = await comConexaoAuth();
    try {
        const resultado = await client.query(
            `SELECT u.ativo, u.papel, a.ativo AS associacao_ativa
             FROM usuarios u
             JOIN associacoes a ON a.id = u.associacao_id
             WHERE u.id = $1`,
            [payload.id]
        );
        const usuario = resultado.rows[0];
        if (!usuario || !usuario.ativo || !usuario.associacao_ativa) {
            return res.status(401).json({ erro: 'Token inválido ou expirado' });
        }

        // { id, associacao_id, papel, email, deve_trocar_senha } — papel vem
        // fresco do banco, não do token, para uma troca de papel valer na hora.
        req.usuario = { ...payload, papel: usuario.papel };
        next();
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao validar sessão' });
    } finally {
        client.release();
    }
}

// Bloqueia rotas normais enquanto o usuário estiver com senha provisória
// pendente de troca (primeiro acesso). Usar logo depois de autenticar() em
// cada router, exceto na rota de troca de senha em si.
function bloquearSenhaProvisoria(req, res, next) {
    if (req.usuario && req.usuario.deve_trocar_senha) {
        return res.status(403).json({
            erro: 'Você precisa definir uma nova senha antes de continuar',
            codigo: 'SENHA_PROVISORIA_PENDENTE',
        });
    }
    next();
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
    await client.query(`SELECT set_config('app.current_associacao_id', $1, false)`, [associacaoId]);
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

// Abre uma conexão dedicada com o bypass explícito de RLS para o super-admin.
// Usada nas rotas de routes/superadmin.js, que legitimamente precisam ver
// dados de todas as associações. A flag só é setada aqui, nunca a partir de
// input do usuário — é isso que torna o bypass seguro.
async function comConexaoSuperAdmin() {
    const client = await pool.connect();
    await client.query(`SELECT set_config('app.superadmin_bypass', 'true', false)`);
    return client; // lembrar de chamar client.release() depois de usar
}

// Abre uma conexão dedicada com bypass para os fluxos públicos de
// autenticação (login por e-mail, redefinição de senha por token) — os
// únicos pontos que legitimamente precisam ler usuarios/associacoes antes
// de saber a qual tenant a requisição pertence (é isso que estão
// descobrindo). Mesmo princípio de segurança do comConexaoSuperAdmin: a
// flag nunca vem de input do usuário, só é setada por este código.
async function comConexaoAuth() {
    const client = await pool.connect();
    await client.query(`SELECT set_config('app.auth_bypass', 'true', false)`);
    return client; // lembrar de chamar client.release() depois de usar
}

module.exports = {
    autenticar,
    bloquearSenhaProvisoria,
    autorizar,
    comConexaoTenant,
    autenticarSuperAdmin,
    comConexaoSuperAdmin,
    comConexaoAuth,
};
