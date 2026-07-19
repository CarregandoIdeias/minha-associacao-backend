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
    const { nome, email, senha, papel, associado_id } = req.body;

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
    if (papel === 'associado' && !associado_id) {
        return res.status(400).json({ erro: 'associado_id é obrigatório para o papel "associado"' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query('BEGIN');

        const senhaHash = await bcrypt.hash(senha, 10);

        const resultado = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, nome, email, papel, ativo, criado_em`,
            [req.usuario.associacao_id, nome, email, senhaHash, papel]
        );
        const novoUsuario = resultado.rows[0];

        if (papel === 'associado') {
            const vinculo = await client.query(
                `UPDATE associados SET usuario_id = $1 WHERE id = $2 AND usuario_id IS NULL RETURNING id`,
                [novoUsuario.id, associado_id]
            );
            if (vinculo.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ erro: 'Esse associado não existe ou já tem um login vinculado' });
            }
        }

        await client.query('COMMIT');
        res.status(201).json(novoUsuario);
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe um usuário com esse e-mail nessa associação' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar usuário' });
    } finally {
        client.release();
    }
});

// GET /usuarios/associados-sem-login — lista associados que ainda não têm usuário vinculado (só admin)
router.get('/associados-sem-login', autorizar('admin'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT id, nome_completo FROM associados WHERE usuario_id IS NULL ORDER BY nome_completo`
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar associados sem login' });
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

// PUT /usuarios/:id — edita nome e papel de um usuário (só admin, não pode alterar o próprio papel)
router.put('/:id', autorizar('admin'), async (req, res) => {
    const { id } = req.params;
    const { nome, papel } = req.body;

    if (!nome || !nome.trim()) {
        return res.status(400).json({ erro: 'nome é obrigatório' });
    }
    if (papel && !['admin', 'diretoria', 'associado'].includes(papel)) {
        return res.status(400).json({ erro: 'papel inválido' });
    }
    if (id === req.usuario.id && papel && papel !== 'admin') {
        return res.status(400).json({ erro: 'Você não pode alterar o seu próprio papel' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `UPDATE usuarios SET nome = $1, papel = COALESCE($2, papel)
             WHERE id = $3
             RETURNING id, nome, email, papel, ativo, criado_em`,
            [nome.trim(), papel || null, id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar usuário' });
    } finally {
        client.release();
    }
});

// DELETE /usuarios/:id — remove permanentemente um usuário (só admin, não pode remover a si mesmo)
router.delete('/:id', autorizar('admin'), async (req, res) => {
    const { id } = req.params;

    if (id === req.usuario.id) {
        return res.status(400).json({ erro: 'Você não pode excluir seu próprio usuário' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(`DELETE FROM usuarios WHERE id = $1 RETURNING id`, [id]);
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir usuário' });
    } finally {
        client.release();
    }
});

module.exports = router;
