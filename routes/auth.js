// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { emailValido } = require('../utils/validacao');
const { limiteLogin, limiteRedefinicao } = require('../middleware/rateLimiter');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'troque-isso-em-producao';

// POST /auth/registrar-associacao foi REMOVIDA — a partir de agora, só o
// super-admin cria novas associações (ver routes/superadmin.js).

// POST /auth/login
router.post('/login', limiteLogin, async (req, res) => {
    const { email, senha, associacao_id } = req.body;

    if (!email || !senha || !associacao_id) {
        return res.status(400).json({ erro: 'email, senha e associacao_id são obrigatórios' });
    }

    try {
        const resultado = await pool.query(
            `SELECT id, nome, email, senha_hash, papel, associacao_id
             FROM usuarios
             WHERE email = $1 AND associacao_id = $2 AND ativo = true`,
            [email, associacao_id]
        );

        const usuario = resultado.rows[0];
        if (!usuario) {
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }

        const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaCorreta) {
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }

        const token = jwt.sign(
            {
                id: usuario.id,
                associacao_id: usuario.associacao_id,
                papel: usuario.papel,
                email: usuario.email,
            },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({ token, usuario: { id: usuario.id, nome: usuario.nome, papel: usuario.papel } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao autenticar' });
    }
});

// POST /auth/esqueci-senha
// Não gera mais o token aqui (vulnerabilidade corrigida). Quem esquecer a
// senha deve pedir para o admin da associação gerar o link (ver
// routes/usuarios.js -> POST /usuarios/:id/gerar-link-redefinicao).
router.post('/esqueci-senha', async (req, res) => {
    res.json({
        ok: true,
        mensagem: 'Entre em contato com o administrador da sua associação para receber um link de redefinição de senha.'
    });
});

// POST /auth/redefinir-senha
router.post('/redefinir-senha', limiteRedefinicao, async (req, res) => {
    const { token, senha_nova } = req.body;

    if (!token || !senha_nova) {
        return res.status(400).json({ erro: 'token e senha_nova são obrigatórios' });
    }
    if (senha_nova.length < 6) {
        return res.status(400).json({ erro: 'a nova senha deve ter ao menos 6 caracteres' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const resultado = await client.query(
            `SELECT id, usuario_id, expira_em, usado FROM password_resets WHERE token_hash = $1`,
            [tokenHash]
        );
        const registro = resultado.rows[0];

        if (!registro || registro.usado || new Date(registro.expira_em) < new Date()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ erro: 'Link de redefinição inválido ou expirado' });
        }

        const senhaHash = await bcrypt.hash(senha_nova, 10);

        await client.query(`UPDATE usuarios SET senha_hash = $1 WHERE id = $2`, [senhaHash, registro.usuario_id]);
        await client.query(`UPDATE password_resets SET usado = true WHERE id = $1`, [registro.id]);

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

module.exports = router;
