// routes/usuarios.js
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { autenticar, bloquearSenhaProvisoria, autorizar, comConexaoTenant } = require('../middleware/auth');
const { emailValido, gerarSenhaProvisoria } = require('../utils/validacao');
const { registrarEventoAuth } = require('../utils/authLog');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);

// GET /usuarios — lista os usuários da associação (só admin)
router.get('/', autorizar('admin'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT id, nome, email, papel, ativo, criado_em
             FROM usuarios
             WHERE associacao_id = $1
             ORDER BY criado_em`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar usuários' });
    } finally {
        client.release();
    }
});

// POST /usuarios — convida/cria um novo usuário na mesma associação (só admin).
// A senha é sempre gerada automaticamente e devolvida uma única vez nesta
// resposta — o convidado troca por uma senha própria no primeiro login.
router.post('/', autorizar('admin'), async (req, res) => {
    const { nome, email, papel, associado_id } = req.body;

    if (!nome || !email || !papel) {
        return res.status(400).json({ erro: 'nome, email e papel são obrigatórios' });
    }
    if (!emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail inválido' });
    }
    if (!['diretoria', 'associado'].includes(papel)) {
        return res.status(400).json({ erro: 'papel deve ser "diretoria" ou "associado"' });
    }
    if (papel === 'associado' && !associado_id) {
        return res.status(400).json({ erro: 'associado_id é obrigatório para o papel "associado"' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query('BEGIN');

        const senhaProvisoria = gerarSenhaProvisoria();
        const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

        const resultado = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel, deve_trocar_senha)
             VALUES ($1, $2, $3, $4, $5, true)
             RETURNING id, nome, email, papel, ativo, criado_em`,
            [req.usuario.associacao_id, nome, email, senhaHash, papel]
        );
        const novoUsuario = resultado.rows[0];

        if (papel === 'associado') {
            const vinculo = await client.query(
                `UPDATE associados SET usuario_id = $1 WHERE id = $2 AND usuario_id IS NULL AND associacao_id = $3 RETURNING id`,
                [novoUsuario.id, associado_id, req.usuario.associacao_id]
            );
            if (vinculo.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ erro: 'Esse associado não existe ou já tem um login vinculado' });
            }
        }

        await registrarEventoAuth(client, {
            usuarioId: novoUsuario.id,
            associacaoId: req.usuario.associacao_id,
            emailTentado: email,
            evento: 'senha_provisoria_criada',
            req,
        });

        await client.query('COMMIT');
        res.status(201).json({ ...novoUsuario, senha_provisoria: senhaProvisoria });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail na plataforma' });
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
            `SELECT id, nome_completo FROM associados WHERE usuario_id IS NULL AND associacao_id = $1 ORDER BY nome_completo`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar associados sem login' });
    } finally {
        client.release();
    }
});

// GET /usuarios/logs-autenticacao — histórico de eventos de autenticação da
// associação (login, logout, troca/redefinição de senha), mais recente primeiro
router.get('/logs-autenticacao', autorizar('admin'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT l.id, l.evento, l.email_tentado, l.ip, l.criado_em, u.nome AS usuario_nome
             FROM auth_logs l
             LEFT JOIN usuarios u ON u.id = l.usuario_id
             WHERE l.associacao_id = $1
             ORDER BY l.criado_em DESC
             LIMIT 200`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar logs de autenticação' });
    } finally {
        client.release();
    }
});

// POST /usuarios/:id/gerar-link-redefinicao — admin gera um link de redefinição
// de senha para outro usuário da mesma associação (correção da vulnerabilidade
// que permitia qualquer pessoa gerar esse link só com e-mail + associacao_id)
router.post('/:id/gerar-link-redefinicao', autorizar('admin'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const usuario = await client.query(
            `SELECT id FROM usuarios WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (usuario.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }

        const tokenBruto = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(tokenBruto).digest('hex');
        const expiraEm = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

        await client.query(
            `INSERT INTO password_resets (usuario_id, token_hash, expira_em) VALUES ($1, $2, $3)`,
            [id, tokenHash, expiraEm]
        );

        res.json({ ok: true, token: tokenBruto });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao gerar link de redefinição' });
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
        await client.query(`UPDATE usuarios SET ativo = false WHERE id = $1 AND associacao_id = $2`, [id, req.usuario.associacao_id]);
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
             WHERE id = $3 AND associacao_id = $4
             RETURNING id, nome, email, papel, ativo, criado_em`,
            [nome.trim(), papel || null, id, req.usuario.associacao_id]
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
        const resultado = await client.query(`DELETE FROM usuarios WHERE id = $1 AND associacao_id = $2 RETURNING id`, [id, req.usuario.associacao_id]);
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
