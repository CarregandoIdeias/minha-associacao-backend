// routes/associados.js
// Exemplo de CRUD já usando o isolamento por tenant (RLS).
const express = require('express');
const { autenticar, autorizar, comConexaoTenant } = require('../middleware/auth');

const router = express.Router();

// Todas as rotas abaixo exigem estar logado
router.use(autenticar);

// GET /associados — lista os associados da associação do usuário logado
router.get('/', async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT id, nome_completo, cpf, categoria, status, data_ingresso
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
    const { nome_completo, cpf, telefone, categoria } = req.body;

    if (!nome_completo) {
        return res.status(400).json({ erro: 'nome_completo é obrigatório' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `INSERT INTO associados (associacao_id, nome_completo, cpf, telefone, categoria)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, nome_completo, status`,
            [req.usuario.associacao_id, nome_completo, cpf, telefone, categoria]
        );
        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar associado' });
    } finally {
        client.release();
    }
});

module.exports = router;
