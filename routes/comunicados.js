// routes/comunicados.js
const express = require('express');
const { autenticar, autorizar, comConexaoTenant } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// GET /comunicados — lista comunicados da associação, mais recentes primeiro
router.get('/', async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT c.id, c.titulo, c.conteudo, c.categoria_alvo, c.publicado_em,
                    u.nome AS autor_nome
             FROM comunicados c
             LEFT JOIN usuarios u ON u.id = c.autor_id
             ORDER BY c.publicado_em DESC`
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar comunicados' });
    } finally {
        client.release();
    }
});

// POST /comunicados — cria um novo comunicado (só admin/diretoria)
router.post('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const { titulo, conteudo, categoria_alvo } = req.body;

    if (!titulo || !conteudo) {
        return res.status(400).json({ erro: 'titulo e conteudo são obrigatórios' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `INSERT INTO comunicados (associacao_id, autor_id, titulo, conteudo, categoria_alvo)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, titulo, conteudo, categoria_alvo, publicado_em`,
            [req.usuario.associacao_id, req.usuario.id, titulo, conteudo, categoria_alvo || null]
        );
        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar comunicado' });
    } finally {
        client.release();
    }
});

// DELETE /comunicados/:id — remove um comunicado (só admin/diretoria)
router.delete('/:id', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query(`DELETE FROM comunicados WHERE id = $1`, [id]);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao remover comunicado' });
    } finally {
        client.release();
    }
});

module.exports = router;
