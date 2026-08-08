// routes/sprint.js
// Backlog de sprint da plataforma: melhorias/bugs que o usuário registra pra
// serem lidos e aplicados. Acesso restrito ao super-admin (qualquer papel,
// já que é ferramenta interna, não algo sensível de cliente).
const express = require('express');
const { autenticarSuperAdmin, comConexaoSuperAdmin } = require('../middleware/auth');

const paramUuid = require('../middleware/paramUuid');
const router = express.Router();
// Rejeita :id que nao seja uuid com 400, em vez de deixar virar 500 no Postgres
router.param('id', paramUuid);
router.use(autenticarSuperAdmin);

const TIPOS_VALIDOS = ['melhoria', 'bug'];
const PRIORIDADES_VALIDAS = ['baixa', 'media', 'alta', 'urgente'];
const STATUS_VALIDOS = ['pendente', 'em_andamento', 'concluido', 'cancelado'];

// GET /sprint?status=pendente&tipo=bug — lista, mais recente primeiro.
router.get('/', async (req, res) => {
    const condicoes = [];
    const valores = [];
    if (req.query.status && STATUS_VALIDOS.includes(req.query.status)) {
        valores.push(req.query.status);
        condicoes.push(`status = $${valores.length}`);
    }
    if (req.query.tipo && TIPOS_VALIDOS.includes(req.query.tipo)) {
        valores.push(req.query.tipo);
        condicoes.push(`tipo = $${valores.length}`);
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `SELECT s.*, sa.nome AS criado_por_nome
             FROM sprint_itens s
             LEFT JOIN super_admins sa ON sa.id = s.criado_por
             ${where}
             ORDER BY
                CASE s.status WHEN 'em_andamento' THEN 0 WHEN 'pendente' THEN 1 WHEN 'concluido' THEN 2 ELSE 3 END,
                CASE s.prioridade WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
                s.criado_em DESC`,
            valores
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar itens de sprint' });
    } finally {
        client.release();
    }
});

// POST /sprint — cria um item novo (melhoria ou bug).
router.post('/', async (req, res) => {
    const { tipo, titulo, descricao, area, prioridade } = req.body;

    if (!TIPOS_VALIDOS.includes(tipo)) {
        return res.status(400).json({ erro: 'Tipo inválido (use melhoria ou bug)' });
    }
    if (!titulo || !titulo.trim()) {
        return res.status(400).json({ erro: 'Informe um título' });
    }
    if (!descricao || !descricao.trim()) {
        return res.status(400).json({ erro: 'Informe uma descrição' });
    }
    const prioridadeFinal = PRIORIDADES_VALIDAS.includes(prioridade) ? prioridade : 'media';

    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `INSERT INTO sprint_itens (tipo, titulo, descricao, area, prioridade, criado_por)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [tipo, titulo.trim(), descricao.trim(), (area || '').trim() || null, prioridadeFinal, req.superAdmin.id]
        );
        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar item de sprint' });
    } finally {
        client.release();
    }
});

// PUT /sprint/:id — edita título/descrição/área/prioridade/tipo.
router.put('/:id', async (req, res) => {
    const { tipo, titulo, descricao, area, prioridade } = req.body;

    if (!TIPOS_VALIDOS.includes(tipo)) {
        return res.status(400).json({ erro: 'Tipo inválido (use melhoria ou bug)' });
    }
    if (!titulo || !titulo.trim()) {
        return res.status(400).json({ erro: 'Informe um título' });
    }
    if (!descricao || !descricao.trim()) {
        return res.status(400).json({ erro: 'Informe uma descrição' });
    }
    const prioridadeFinal = PRIORIDADES_VALIDAS.includes(prioridade) ? prioridade : 'media';

    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `UPDATE sprint_itens
             SET tipo = $1, titulo = $2, descricao = $3, area = $4, prioridade = $5, atualizado_em = now()
             WHERE id = $6
             RETURNING *`,
            [tipo, titulo.trim(), descricao.trim(), (area || '').trim() || null, prioridadeFinal, req.params.id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Item não encontrado' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar item de sprint' });
    } finally {
        client.release();
    }
});

// PATCH /sprint/:id/status — muda só o status (fluxo principal de uso: mover
// pendente -> em_andamento -> concluido, ou cancelado). notas_aplicacao é
// preenchido ao concluir, pra registrar o que foi feito/onde.
router.patch('/:id/status', async (req, res) => {
    const { status, notas_aplicacao } = req.body;

    if (!STATUS_VALIDOS.includes(status)) {
        return res.status(400).json({ erro: 'Status inválido' });
    }

    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `UPDATE sprint_itens
             SET status = $1,
                 notas_aplicacao = COALESCE($2, notas_aplicacao),
                 concluido_em = CASE WHEN $1 = 'concluido' THEN now() ELSE NULL END,
                 atualizado_em = now()
             WHERE id = $3
             RETURNING *`,
            [status, notas_aplicacao || null, req.params.id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Item não encontrado' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao atualizar status' });
    } finally {
        client.release();
    }
});

// DELETE /sprint/:id
router.delete('/:id', async (req, res) => {
    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(`DELETE FROM sprint_itens WHERE id = $1 RETURNING id`, [req.params.id]);
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Item não encontrado' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir item de sprint' });
    } finally {
        client.release();
    }
});

module.exports = router;
