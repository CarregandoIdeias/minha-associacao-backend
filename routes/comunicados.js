// routes/comunicados.js
const express = require('express');
const { autenticar, bloquearSenhaProvisoria, bloquearTrialExpirado, autorizar, comConexaoTenant } = require('../middleware/auth');
const { registrarAtividade } = require('../utils/atividadeLog');
const { registrarLogAuditoria } = require('../utils/auditoria');
const { gerarExcelLeituras, gerarPdfLeituras } = require('../utils/exportarLeiturasComunicado');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);
router.use(bloquearTrialExpirado);

// GET /comunicados — lista comunicados (comportamento varia por papel)
// Admin/diretoria: veem tudo (inclusive inativos/agendados), com busca e filtro de status,
//                  e contagem de quantos associados já visualizaram cada um.
// Associado: só veem os "ativo" já publicados (publicado_em no passado), com flag "lido".
router.get('/', async (req, res) => {
    const { busca, status } = req.query;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const ehGestor = ['admin', 'diretoria', 'financeiro', 'atendimento', 'operador', 'consulta'].includes(req.usuario.papel);
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
            `SELECT c.id, c.titulo, c.conteudo, c.categoria_alvo, c.publicado_em, c.status, c.destaque, c.origem_plataforma,
                    u.nome AS autor_nome,
                    (cl.id IS NOT NULL) AS lido,
                    (SELECT COUNT(DISTINCT cl2.usuario_id)
                       FROM comunicado_leituras cl2
                       JOIN usuarios u2 ON u2.id = cl2.usuario_id
                      WHERE cl2.comunicado_id = c.id AND u2.papel = 'associado') AS leituras_associados,
                    (SELECT COUNT(*) FROM usuarios u3
                      WHERE u3.associacao_id = c.associacao_id AND u3.papel = 'associado' AND u3.ativo) AS total_destinatarios
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
router.post('/', autorizar('admin', 'diretoria', 'atendimento', 'operador'), async (req, res) => {
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

        await registrarAtividade(client, {
            associacaoId: req.usuario.associacao_id,
            usuarioId: req.usuario.id,
            usuarioNome: req.usuario.nome,
            tipo: 'comunicado_publicado',
            descricao: 'publicou o comunicado "' + resultado.rows[0].titulo + '"',
        });
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'comunicados', tipoAcao: 'criacao',
            descricao: req.usuario.nome + ' publicou o comunicado "' + resultado.rows[0].titulo + '"',
            dadosNovos: resultado.rows[0], req,
        });

        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar comunicado' });
    } finally {
        client.release();
    }
});

// PUT /comunicados/:id — edita um comunicado (só admin/diretoria)
router.put('/:id', autorizar('admin', 'diretoria', 'atendimento', 'operador'), async (req, res) => {
    const { id } = req.params;
    const { titulo, conteudo, categoria_alvo, destaque, publicado_em, status } = req.body;

    if (!titulo || !conteudo) {
        return res.status(400).json({ erro: 'titulo e conteudo são obrigatórios' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const anterior = await client.query(
            `SELECT id, titulo, conteudo, categoria_alvo, publicado_em, status, destaque, origem_plataforma FROM comunicados WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (anterior.rows.length === 0) {
            return res.status(404).json({ erro: 'Comunicado não encontrado' });
        }
        // Comunicado enviado pelo Super Admin pra todas as associações --
        // a diretoria não pode editar o texto oficial da plataforma.
        if (anterior.rows[0].origem_plataforma) {
            return res.status(403).json({ erro: 'Este é um comunicado oficial da plataforma e não pode ser editado' });
        }

        const resultado = await client.query(
            `UPDATE comunicados
             SET titulo = $1, conteudo = $2, categoria_alvo = $3, destaque = $4,
                 publicado_em = COALESCE($5, publicado_em), status = COALESCE($6, status)
             WHERE id = $7 AND associacao_id = $8
             RETURNING id, titulo, conteudo, categoria_alvo, publicado_em, status, destaque`,
            [titulo, conteudo, categoria_alvo || null, !!destaque, publicado_em || null, status || null, id, req.usuario.associacao_id]
        );
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'comunicados', tipoAcao: 'edicao',
            descricao: req.usuario.nome + ' editou o comunicado "' + resultado.rows[0].titulo + '"',
            dadosAnteriores: anterior.rows[0], dadosNovos: resultado.rows[0], req,
        });
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar comunicado' });
    } finally {
        client.release();
    }
});

// DELETE /comunicados/:id — remove um comunicado (só admin/diretoria)
router.delete('/:id', autorizar('admin', 'diretoria', 'atendimento', 'operador'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const existente = await client.query(
            `SELECT origem_plataforma FROM comunicados WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (existente.rows.length === 0) {
            return res.status(404).json({ erro: 'Comunicado não encontrado' });
        }
        if (existente.rows[0].origem_plataforma) {
            return res.status(403).json({ erro: 'Este é um comunicado oficial da plataforma e não pode ser excluído' });
        }

        const resultado = await client.query(
            `DELETE FROM comunicados WHERE id = $1 AND associacao_id = $2 RETURNING id, titulo`,
            [id, req.usuario.associacao_id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Comunicado não encontrado' });
        }
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'comunicados', tipoAcao: 'exclusao',
            descricao: req.usuario.nome + ' excluiu o comunicado "' + resultado.rows[0].titulo + '"',
            dadosAnteriores: resultado.rows[0], req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao remover comunicado' });
    } finally {
        client.release();
    }
});

// GET /comunicados/:id/leituras — quem já leu/ainda não leu esse comunicado
// (item de sprint 3, "Confirmação de Leitura"), só admin/diretoria.
// Universo de destinatários = usuarios papel 'associado' ativos da
// associação (mesmo critério do total_destinatarios em GET /comunicados) --
// categoria_alvo é só rótulo informativo, não filtra quem recebe (ver
// GET / acima, sem WHERE por categoria).
router.get('/:id/leituras', autorizar('admin', 'diretoria', 'financeiro', 'atendimento', 'operador', 'consulta'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const comunicado = await client.query(
            `SELECT id, titulo FROM comunicados WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (comunicado.rows.length === 0) {
            return res.status(404).json({ erro: 'Comunicado não encontrado' });
        }

        const resultado = await client.query(
            `SELECT u.id AS usuario_id, u.nome, u.email, (cl.id IS NOT NULL) AS lido, cl.criado_em AS lido_em
             FROM usuarios u
             LEFT JOIN comunicado_leituras cl ON cl.comunicado_id = $1 AND cl.usuario_id = u.id
             WHERE u.associacao_id = $2 AND u.papel = 'associado' AND u.ativo
             ORDER BY (cl.id IS NOT NULL) DESC, cl.criado_em ASC, u.nome`,
            [id, req.usuario.associacao_id]
        );
        res.json({ titulo: comunicado.rows[0].titulo, leituras: resultado.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar leituras do comunicado' });
    } finally {
        client.release();
    }
});

// GET /comunicados/:id/leituras/exportar/:formato — mesma lista acima, em
// Excel/PDF; registra a exportação como linha de auditoria (mesmo padrão
// de GET /superadmin/logs/exportar/:formato).
router.get('/:id/leituras/exportar/:formato', autorizar('admin', 'diretoria', 'financeiro', 'atendimento', 'operador', 'consulta'), async (req, res) => {
    const { id, formato } = req.params;
    if (!['excel', 'pdf'].includes(formato)) {
        return res.status(400).json({ erro: 'formato deve ser "excel" ou "pdf"' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const comunicado = await client.query(
            `SELECT id, titulo FROM comunicados WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (comunicado.rows.length === 0) {
            return res.status(404).json({ erro: 'Comunicado não encontrado' });
        }

        const resultado = await client.query(
            `SELECT u.nome, u.email, (cl.id IS NOT NULL) AS lido, cl.criado_em AS lido_em
             FROM usuarios u
             LEFT JOIN comunicado_leituras cl ON cl.comunicado_id = $1 AND cl.usuario_id = u.id
             WHERE u.associacao_id = $2 AND u.papel = 'associado' AND u.ativo
             ORDER BY (cl.id IS NOT NULL) DESC, cl.criado_em ASC, u.nome`,
            [id, req.usuario.associacao_id]
        );

        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'comunicados', tipoAcao: 'exportacao',
            descricao: req.usuario.nome + ' exportou a lista de leituras do comunicado "' + comunicado.rows[0].titulo + '" em ' + formato.toUpperCase(),
            req,
        });

        if (formato === 'excel') {
            const buffer = await gerarExcelLeituras(comunicado.rows[0].titulo, resultado.rows);
            res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.set('Content-Disposition', 'attachment; filename="leituras-comunicado.xlsx"');
            return res.send(Buffer.from(buffer));
        }

        const buffer = await gerarPdfLeituras(comunicado.rows[0].titulo, resultado.rows);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'attachment; filename="leituras-comunicado.pdf"');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao exportar leituras do comunicado' });
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
