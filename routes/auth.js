// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const config = require('../config/env');
const { autenticar, comConexaoTenant, comConexaoAuth } = require('../middleware/auth');
const { senhaForte } = require('../utils/validacao');
const { registrarEventoAuth } = require('../utils/authLog');
const { limiteLogin, limiteRedefinicao } = require('../middleware/rateLimiter');

const router = express.Router();
const JWT_SECRET = config.jwtSecret;

function assinarToken(usuario) {
    return jwt.sign(
        {
            id: usuario.id,
            associacao_id: usuario.associacao_id,
            papel: usuario.papel,
            email: usuario.email,
            deve_trocar_senha: usuario.deve_trocar_senha,
        },
        JWT_SECRET,
        { expiresIn: '8h' }
    );
}

// POST /auth/registrar-associacao foi REMOVIDA — a partir de agora, só o
// super-admin cria novas associações (ver routes/superadmin.js).

// POST /auth/login
// Login por e-mail + senha, sem precisar informar qual associação (o e-mail
// já é único em toda a plataforma). Usa comConexaoAuth() porque ainda não
// sabemos a qual tenant a requisição pertence — é isso que a query descobre.
router.post('/login', limiteLogin, async (req, res) => {
    const { email, senha } = req.body;

    if (!email || !senha) {
        return res.status(400).json({ erro: 'email e senha são obrigatórios' });
    }

    const client = await comConexaoAuth();
    try {
        const resultado = await client.query(
            `SELECT u.id, u.nome, u.email, u.senha_hash, u.papel, u.associacao_id, u.ativo, u.deve_trocar_senha,
                    a.ativo AS associacao_ativa
             FROM usuarios u
             JOIN associacoes a ON a.id = u.associacao_id
             WHERE lower(u.email) = lower($1)`,
            [email]
        );

        const usuario = resultado.rows[0];
        if (!usuario || !usuario.ativo) {
            await registrarEventoAuth(pool, { emailTentado: email, evento: 'login_falha', req });
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }

        if (!usuario.associacao_ativa) {
            await registrarEventoAuth(pool, {
                usuarioId: usuario.id,
                associacaoId: usuario.associacao_id,
                emailTentado: email,
                evento: 'login_falha',
                req,
            });
            return res.status(403).json({ erro: 'O acesso da sua associação está temporariamente bloqueado. Fale com o suporte.' });
        }

        const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaCorreta) {
            await registrarEventoAuth(pool, {
                usuarioId: usuario.id,
                associacaoId: usuario.associacao_id,
                emailTentado: email,
                evento: 'login_falha',
                req,
            });
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }

        const token = assinarToken(usuario);

        await registrarEventoAuth(pool, {
            usuarioId: usuario.id,
            associacaoId: usuario.associacao_id,
            emailTentado: email,
            evento: 'login_sucesso',
            req,
        });

        res.json({
            token,
            usuario: { id: usuario.id, nome: usuario.nome, papel: usuario.papel },
            deve_trocar_senha: usuario.deve_trocar_senha,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao autenticar' });
    } finally {
        client.release();
    }
});

// POST /auth/esqueci-senha
// Não gera token aqui (autosserviço de recuperação por e-mail depende de um
// provedor de e-mail configurado, que ainda não existe — ver plano). Quem
// esquecer a senha deve pedir para o admin da associação gerar o link (ver
// routes/usuarios.js -> POST /usuarios/:id/gerar-link-redefinicao).
router.post('/esqueci-senha', async (req, res) => {
    res.json({
        ok: true,
        mensagem: 'Entre em contato com o administrador da sua associação para receber um link de redefinição de senha.'
    });
});

// POST /auth/redefinir-senha
// Fluxo do link gerado pelo admin (token de uso único, ver usuarios.js).
// Também não sabe o tenant de antemão — o token é o próprio segredo que
// identifica o usuário — por isso usa comConexaoAuth().
router.post('/redefinir-senha', limiteRedefinicao, async (req, res) => {
    const { token, senha_nova } = req.body;

    if (!token || !senha_nova) {
        return res.status(400).json({ erro: 'token e senha_nova são obrigatórios' });
    }
    if (!senhaForte(senha_nova)) {
        return res.status(400).json({ erro: 'A nova senha deve ter ao menos 8 caracteres, com letra maiúscula, minúscula e número' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const client = await comConexaoAuth();
    try {
        await client.query('BEGIN');

        const resultado = await client.query(
            `SELECT pr.id, pr.usuario_id, pr.expira_em, pr.usado, u.associacao_id, u.email
             FROM password_resets pr
             JOIN usuarios u ON u.id = pr.usuario_id
             WHERE pr.token_hash = $1`,
            [tokenHash]
        );
        const registro = resultado.rows[0];

        if (!registro || registro.usado || new Date(registro.expira_em) < new Date()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ erro: 'Link de redefinição inválido ou expirado' });
        }

        const senhaHash = await bcrypt.hash(senha_nova, 10);

        await client.query(
            `UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = false WHERE id = $2`,
            [senhaHash, registro.usuario_id]
        );
        await client.query(`UPDATE password_resets SET usado = true WHERE id = $1`, [registro.id]);

        await registrarEventoAuth(client, {
            usuarioId: registro.usuario_id,
            associacaoId: registro.associacao_id,
            emailTentado: registro.email,
            evento: 'senha_redefinida',
            req,
        });

        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ erro: 'Erro ao redefinir senha' });
    } finally {
        client.release();
    }
});

// PUT /auth/senha
// Troca de senha pelo próprio usuário autenticado — usada tanto para a troca
// obrigatória do primeiro acesso (senha provisória) quanto para troca
// voluntária depois. Emite um token novo para liberar o acesso na hora, sem
// precisar logar de novo. Já sabemos o tenant pelo token, então usa
// comConexaoTenant() normalmente.
router.put('/senha', autenticar, async (req, res) => {
    const { senha_atual, senha_nova } = req.body;

    if (!senha_atual || !senha_nova) {
        return res.status(400).json({ erro: 'senha_atual e senha_nova são obrigatórios' });
    }
    if (!senhaForte(senha_nova)) {
        return res.status(400).json({ erro: 'A nova senha deve ter ao menos 8 caracteres, com letra maiúscula, minúscula e número' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(`SELECT senha_hash FROM usuarios WHERE id = $1`, [req.usuario.id]);
        const usuario = resultado.rows[0];
        if (!usuario) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }

        const senhaCorreta = await bcrypt.compare(senha_atual, usuario.senha_hash);
        if (!senhaCorreta) {
            return res.status(401).json({ erro: 'Senha atual incorreta' });
        }

        const novoHash = await bcrypt.hash(senha_nova, 10);
        await client.query(
            `UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = false WHERE id = $2`,
            [novoHash, req.usuario.id]
        );

        await registrarEventoAuth(client, {
            usuarioId: req.usuario.id,
            associacaoId: req.usuario.associacao_id,
            emailTentado: req.usuario.email,
            evento: 'senha_alterada',
            req,
        });

        const novoToken = assinarToken({ ...req.usuario, deve_trocar_senha: false });
        res.json({ ok: true, token: novoToken });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao trocar senha' });
    } finally {
        client.release();
    }
});

// POST /auth/logout
// JWT é stateless (não há revogação server-side ainda) — esse endpoint só
// registra o evento para auditoria; quem efetivamente encerra a sessão é o
// front-end, descartando o token guardado localmente.
router.post('/logout', autenticar, async (req, res) => {
    await registrarEventoAuth(pool, {
        usuarioId: req.usuario.id,
        associacaoId: req.usuario.associacao_id,
        emailTentado: req.usuario.email,
        evento: 'logout',
        req,
    });
    res.json({ ok: true });
});

module.exports = router;
