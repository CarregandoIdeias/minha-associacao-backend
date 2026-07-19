// routes/cobrancas.js
const express = require('express');
const { autenticar, autorizar, comConexaoTenant } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// GET /cobrancas — lista cobranças da associação, com filtro opcional por status ou associado (só admin/diretoria)
router.get('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const { status, associado_id } = req.query;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const condicoes = [];
        const valores = [];

        if (status) {
            valores.push(status);
            condicoes.push(`c.status = $${valores.length}`);
        }
        if (associado_id) {
            valores.push(associado_id);
            condicoes.push(`c.associado_id = $${valores.length}`);
        }

        const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

        const resultado = await client.query(
            `SELECT c.id, c.descricao, c.valor, c.vencimento, c.status, c.metodo,
                    a.nome_completo AS associado_nome, c.associado_id,
                    (c.comprovante_base64 IS NOT NULL) AS tem_comprovante
             FROM cobrancas c
             JOIN associados a ON a.id = c.associado_id
             ${where}
             ORDER BY c.vencimento DESC`,
            valores
        );

        // Marca automaticamente como "atrasado" (somente na resposta) se venceu e ainda está pendente
        const hoje = new Date().toISOString().substring(0, 10);
        const linhas = resultado.rows.map((linha) => {
            if (linha.status === 'pendente' && linha.vencimento.toISOString().substring(0, 10) < hoje) {
                return { ...linha, status_exibicao: 'atrasado' };
            }
            return { ...linha, status_exibicao: linha.status };
        });

        res.json(linhas);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar cobranças' });
    } finally {
        client.release();
    }
});

// POST /cobrancas — cria uma nova cobrança (só admin/diretoria)
router.post('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const { associado_id, descricao, valor, vencimento } = req.body;

    if (!associado_id || !valor || !vencimento) {
        return res.status(400).json({ erro: 'associado_id, valor e vencimento são obrigatórios' });
    }
    if (isNaN(parseFloat(valor)) || parseFloat(valor) < 0) {
        return res.status(400).json({ erro: 'valor inválido' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `INSERT INTO cobrancas (associacao_id, associado_id, descricao, valor, vencimento)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, descricao, valor, vencimento, status`,
            [req.usuario.associacao_id, associado_id, descricao || 'Mensalidade', valor, vencimento]
        );
        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar cobrança' });
    } finally {
        client.release();
    }
});

// PATCH /cobrancas/:id/pagar — marca uma cobrança como paga manualmente
router.patch('/:id/pagar', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    const { metodo } = req.body;

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query('BEGIN');

        const cobranca = await client.query(
            `SELECT id, valor, status FROM cobrancas WHERE id = $1`,
            [id]
        );

        if (cobranca.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ erro: 'Cobrança não encontrada' });
        }
        if (cobranca.rows[0].status === 'pago') {
            await client.query('ROLLBACK');
            return res.status(409).json({ erro: 'Cobrança já está paga' });
        }

        await client.query(
            `UPDATE cobrancas SET status = 'pago', metodo = $1 WHERE id = $2`,
            [metodo || 'outro', id]
        );

        await client.query(
            `INSERT INTO pagamentos (cobranca_id, valor_pago, metodo)
             VALUES ($1, $2, $3)`,
            [id, cobranca.rows[0].valor, metodo || 'outro']
        );

        await client.query('COMMIT');
        res.json({ ok: true, id, status: 'pago' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ erro: 'Erro ao registrar pagamento' });
    } finally {
        client.release();
    }
});

// GET /cobrancas/:id/comprovante — retorna o comprovante enviado pelo associado (admin/diretoria)
router.get('/:id/comprovante', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    res.set('Cache-Control', 'no-store');
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT comprovante_base64, comprovante_enviado_em FROM cobrancas WHERE id = $1`,
            [id]
        );
        if (resultado.rows.length === 0 || !resultado.rows[0].comprovante_base64) {
            return res.status(404).json({ erro: 'Nenhum comprovante encontrado para essa cobrança' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar comprovante' });
    } finally {
        client.release();
    }
});

// PUT /cobrancas/:id — edita uma cobrança (só se ainda não estiver paga)
router.put('/:id', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    const { descricao, valor, vencimento } = req.body;

    if (!valor || !vencimento) {
        return res.status(400).json({ erro: 'valor e vencimento são obrigatórios' });
    }
    if (isNaN(parseFloat(valor)) || parseFloat(valor) < 0) {
        return res.status(400).json({ erro: 'valor inválido' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const atual = await client.query(`SELECT status FROM cobrancas WHERE id = $1`, [id]);
        if (atual.rows.length === 0) {
            return res.status(404).json({ erro: 'Cobrança não encontrada' });
        }
        if (atual.rows[0].status === 'pago') {
            return res.status(409).json({ erro: 'Não é possível editar uma cobrança já paga' });
        }

        const resultado = await client.query(
            `UPDATE cobrancas SET descricao = $1, valor = $2, vencimento = $3
             WHERE id = $4
             RETURNING id, descricao, valor, vencimento, status`,
            [descricao || 'Mensalidade', valor, vencimento, id]
        );
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar cobrança' });
    } finally {
        client.release();
    }
});

// DELETE /cobrancas/:id — remove uma cobrança (só admin)
router.delete('/:id', autorizar('admin'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(`DELETE FROM cobrancas WHERE id = $1 RETURNING id`, [id]);
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Cobrança não encontrada' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir cobrança' });
    } finally {
        client.release();
    }
});

module.exports = router;
