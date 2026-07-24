// routes/comunicados.js
const express = require('express');
const { autenticar, bloquearSenhaProvisoria, autorizar, comConexaoTenant } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);

// GET /comunicados — lista comunicados (comportamento varia por papel)
// Admin/diretoria: veem tudo (inclusive inativos/agendados), com busca e filtro de status,
//                  e contagem de quantos associados já visualizaram cada um.
// Associado: só veem os "ativo" já publicados (publicado_em no passado), com flag "lido".
router.get('/', async (req, res) => {
    const { busca, status } = req.query;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const ehGestor = req.usuario.papel === 'admin' || req.usuario.papel === 'diretoria';
        const condicoes = [];
        const valores = [];

        valores.push(req.usuario.associacao_id);
        condicoes.push(`c.associacao_id = $${valores.length}`);

        if (ehGestor) {
            if (busca) {
                valores.push('%' + busca + '%');
                condicoes.push(`c.titulo ILIKE $${valores.length}`);
            }
            if (status) {
                valores.push(status);
                condicoes.push(`c.status = $${valores.length}`);
            }
        } else {
            condicoes.push(`c.status = 'ativo'`);
            condicoes.push(`c.publicado_em <= now()`);
        }

        const where = `WHERE ${condicoes.join(' AND ')}`;

        valores.push(req.usuario.id);
        const idxUsuario = valores.length;

        const resultado = await client.query(
            `SELECT c.id, c.titulo, c.conteudo, c.categoria_alvo, c.publicado_em, c.status, c.destaque,
                    u.nome AS autor_nome,
                    (cl.id IS NOT NULL) AS lido,
                    (SELECT COUNT(DISTINCT cl2.usuario_id)
                       FROM comunicado_leituras cl2
                       JOIN usuarios u2 ON u2.id = cl2.usuario_id
                      WHERE cl2.comunicado_id = c.id AND u2.papel = 'associado') AS leituras_associados
             FROM comunicados c
             LEFT JOIN usuarios u ON u.id = c.autor_id
             LEFT JOIN comunicado_leituras cl ON cl.comunicado_id = c.id AND cl.usuario_id = $${idxUsuario}
             ${where}
             ORDER BY c.destaque DESC, c.publicado_em DESC`,
            valores
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
    const { titulo, conteudo, categoria_alvo, destaque, publicado_em, status } = req.body;

    if (!titulo || !conteudo) {
        return res.status(400).json({ erro: 'titulo e conteudo são obrigatórios' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `INSERT INTO comunicados (associacao_id, autor_id, titulo, conteudo, categoria_alvo, destaque, publicado_em, status)
             VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($8, 'ativo'))
             RETURNING id, titulo, conteudo, categoria_alvo, publicado_em, status, destaque`,
            [req.usuario.associacao_id, req.usuario.id, titulo, conteudo, categoria_alvo || null, !!destaque, publicado_em || null, status || null]
        );
        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar comunicado' });
    } finally {
        client.release();
    }
});

// PUT /comunicados/:id — edita um comunicado (só admin/diretoria)
router.put('/:id', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    const { titulo, conteudo, categoria_alvo, destaque, publicado_em, status } = req.body;

    if (!titulo || !conteudo) {
        return res.status(400).json({ erro: 'titulo e conteudo são obrigatórios' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `UPDATE comunicados
             SET titulo = $1, conteudo = $2, categoria_alvo = $3, destaque = $4,
                 publicado_em = COALESCE($5, publicado_em), status = COALESCE($6, status)
             WHERE id = $7 AND associacao_id = $8
             RETURNING id, titulo, conteudo, categoria_alvo, publicado_em, status, destaque`,
            [titulo, conteudo, categoria_alvo || null, !!destaque, publicado_em || null, status || null, id, req.usuario.associacao_id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Comunicado não encontrado' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar comunicado' });
    } finally {
        client.release();
    }
});

// DELETE /comunicados/:id — remove um comunicado (só admin/diretoria)
router.delete('/:id', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query(`DELETE FROM comunicados WHERE id = $1 AND associacao_id = $2`, [id, req.usuario.associacao_id]);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao remover comunicado' });
    } finally {
        client.release();
    }
});

// POST /comunicados/:id/marcar-lido — registra que o usuário logado visualizou esse comunicado
router.post('/:id/marcar-lido', async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query(
            `INSERT INTO comunicado_leituras (comunicado_id, usuario_id)
             SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM comunicados WHERE id = $1 AND associacao_id = $3)
             ON CONFLICT (comunicado_id, usuario_id) DO NOTHING`,
            [id, req.usuario.id, req.usuario.associacao_id]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao marcar como lido' });
    } finally {
        client.release();
    }
});

module.exports = router;
