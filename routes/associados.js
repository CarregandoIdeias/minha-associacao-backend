// routes/associados.js
// CRUD completo já usando o isolamento por tenant (RLS).
const express = require('express');
const { autenticar, autorizar, comConexaoTenant } = require('../middleware/auth');
const { cpfValido } = require('../utils/validacao');

const router = express.Router();

// Todas as rotas abaixo exigem estar logado
router.use(autenticar);

// GET /associados — lista os associados da associação do usuário logado (só admin/diretoria)
router.get('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT id, nome_completo, cpf, telefone, categoria, status, data_ingresso, observacao
             FROM associados
             ORDER BY nome_completo`
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar associados' });
    } finally {
        client.release();
    }
});

// POST /associados — cria um novo associado (só admin/diretoria)
router.post('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const { nome_completo, cpf, telefone, categoria, observacao } = req.body;

    if (!nome_completo || !nome_completo.trim()) {
        return res.status(400).json({ erro: 'nome_completo é obrigatório' });
    }
    if (cpf && !cpfValido(cpf)) {
        return res.status(400).json({ erro: 'CPF inválido' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `INSERT INTO associados (associacao_id, nome_completo, cpf, telefone, categoria, observacao)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, nome_completo, cpf, telefone, categoria, status, data_ingresso, observacao`,
            [req.usuario.associacao_id, nome_completo.trim(), cpf || null, telefone || null, categoria || null, observacao || null]
        );
        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe um associado com esse CPF nessa associação' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar associado' });
    } finally {
        client.release();
    }
});

// PUT /associados/:id — edita um associado existente (só admin/diretoria)
router.put('/:id', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    const { nome_completo, cpf, telefone, categoria, status, observacao } = req.body;

    if (!nome_completo || !nome_completo.trim()) {
        return res.status(400).json({ erro: 'nome_completo é obrigatório' });
    }
    if (cpf && !cpfValido(cpf)) {
        return res.status(400).json({ erro: 'CPF inválido' });
    }
    const statusValidos = ['ativo', 'inadimplente', 'desligado', 'suspenso'];
    if (status && !statusValidos.includes(status)) {
        return res.status(400).json({ erro: 'status inválido' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `UPDATE associados
             SET nome_completo = $1, cpf = $2, telefone = $3, categoria = $4,
                 status = COALESCE($5, status), observacao = $6
             WHERE id = $7
             RETURNING id, nome_completo, cpf, telefone, categoria, status, data_ingresso, observacao`,
            [nome_completo.trim(), cpf || null, telefone || null, categoria || null, status || null, observacao || null, id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Associado não encontrado' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe um associado com esse CPF nessa associação' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar associado' });
    } finally {
        client.release();
    }
});

// DELETE /associados/:id — remove um associado e suas cobranças (só admin)
router.delete('/:id', autorizar('admin'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(`DELETE FROM associados WHERE id = $1 RETURNING id`, [id]);
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Associado não encontrado' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir associado' });
    } finally {
        client.release();
    }
});

module.exports = router;
