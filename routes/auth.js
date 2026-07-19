// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { emailValido } = require('../utils/validacao');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'troque-isso-em-producao';

// POST /auth/registrar-associacao
// Cria a associação (tenant) + o primeiro usuário admin dela
router.post('/registrar-associacao', async (req, res) => {
    const { nome_associacao, tipo, nome_admin, email, senha } = req.body;

    if (!nome_associacao || !nome_admin || !email || !senha) {
        return res.status(400).json({ erro: 'Campos obrigatórios faltando' });
    }
    if (!emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail inválido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const associacao = await client.query(
            `INSERT INTO associacoes (nome, tipo) VALUES ($1, $2) RETURNING id`,
            [nome_associacao, tipo || 'outra']
        );
        const associacaoId = associacao.rows[0].id;

        const senhaHash = await bcrypt.hash(senha, 10);

        const usuario = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel)
             VALUES ($1, $2, $3, $4, 'admin') RETURNING id, nome, email, papel`,
            [associacaoId, nome_admin, email, senhaHash]
        );

        await client.query('COMMIT');

        res.status(201).json({
            associacao_id: associacaoId,
            usuario: usuario.rows[0],
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'E-mail já cadastrado nessa associação' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao registrar associação' });
    } finally {
        client.release();
    }
});

// POST /auth/login
router.post('/login', async (req, res) => {
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
// Gera um token de redefinição válido por 1 hora. Nessa versão simplificada,
// devolve o link diretamente na resposta (sem envio de e-mail automático) —
// quem estiver logado como admin deve copiar e enviar manualmente para a pessoa.
router.post('/esqueci-senha', async (req, res) => {
    const { email, associacao_id } = req.body;

    if (!email || !associacao_id) {
        return res.status(400).json({ erro: 'email e associacao_id são obrigatórios' });
    }

    try {
        const resultado = await pool.query(
            `SELECT id FROM usuarios WHERE email = $1 AND associacao_id = $2 AND ativo = true`,
            [email, associacao_id]
        );

        const usuario = resultado.rows[0];
        if (!usuario) {
            // Não revela se o e-mail existe ou não, por segurança
            return res.json({ ok: true, mensagem: 'Se o e-mail existir, um link de redefinição foi gerado.' });
        }

        const tokenBruto = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(tokenBruto).digest('hex');
        const expiraEm = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

        await pool.query(
            `INSERT INTO password_resets (usuario_id, token_hash, expira_em) VALUES ($1, $2, $3)`,
            [usuario.id, tokenHash, expiraEm]
        );

        res.json({ ok: true, token: tokenBruto });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao gerar redefinição de senha' });
    }
});

// POST /auth/redefinir-senha
router.post('/redefinir-senha', async (req, res) => {
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
