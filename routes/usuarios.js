// routes/usuarios.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { autenticar, autorizar, comConexaoTenant } = require('../middleware/auth');
const { emailValido } = require('../utils/validacao');

const router = express.Router();
router.use(autenticar);

// GET /usuarios — lista os usuários da associação (só admin)
router.get('/', autorizar('admin'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT id, nome, email, papel, ativo, criado_em
             FROM usuarios
             ORDER BY criado_em`
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar usuários' });
    } finally {
        client.release();
    }
});

// POST /usuarios — convida/cria um novo usuário na mesma associação (só admin)
router.post('/', autorizar('admin'), async (req, res) => {
    const { nome, email, senha, papel } = req.body;

    if (!nome || !email || !senha || !papel) {
        return res.status(400).json({ erro: 'nome, email, senha e papel são obrigatórios' });
    }
    if (!emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail inválido' });
    }
    if (!['diretoria', 'associado'].includes(papel)) {
        return res.status(400).json({ erro: 'papel deve ser "diretoria" ou "associado"' });
    }
    if (senha.length < 6) {
        return res.status(400).json({ erro: 'senha deve ter ao menos 6 caracteres' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const senhaHash = await bcrypt.hash(senha, 10);

        const resultado = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, nome, email, papel, ativo, criado_em`,
            [req.usuario.associacao_id, nome, email, senhaHash, papel]
        );
        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe um usuário com esse e-mail nessa associação' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar usuário' });
    } finally {
        client.release();
    }
});

// PATCH /usuarios/:id/desativar — desativa um usuário (só admin, não pode desativar a si mesmo)
router.patch('/:id/desativar', autorizar('admin'), async (req, res) => {
    const { id } = req.params;

    if (id === req.usuario.id) {
        return res.status(400).json({ erro: 'Você não pode desativar seu próprio usuário' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query(`UPDATE usuarios SET ativo = false WHERE id = $1`, [id]);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao desativar usuário' });
    } finally {
        client.release();
    }
});

module.exports = router;
