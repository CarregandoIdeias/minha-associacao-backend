// routes/auditoria.js
// Auditoria da própria associação (item de sprint 4, etapa 2) -- mesma
// tabela/ideia da tela "Auditoria" do Super Admin (routes/superadmin.js),
// só que aqui já filtrado pelo tenant (via comConexaoTenant + RLS
// logs_auditoria_select_tenant, ver supabase/migrations/20260726110000_logs_auditoria.sql)
// em vez de cross-tenant. Só admin/diretoria vêem (mesmo nível de acesso
// de Usuários).
const express = require('express');
const { autenticar, bloquearSenhaProvisoria, bloquearTrialExpirado, autorizar, comConexaoTenant } = require('../middleware/auth');
const { registrarLogAuditoria } = require('../utils/auditoria');
const { gerarExcelLogs, gerarPdfLogs } = require('../utils/exportarLogs');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);
router.use(bloquearTrialExpirado);

const LIMITE_EXPORTACAO = 5000;

function construirFiltros(query, associacaoId) {
    const { usuario, modulo, tipo_acao, data_inicio, data_fim } = query;
    const condicoes = ['l.associacao_id = $1'];
    const valores = [associacaoId];

    if (usuario) {
        valores.push('%' + usuario + '%');
        condicoes.push(`(l.usuario_nome ILIKE $${valores.length} OR l.usuario_email ILIKE $${valores.length})`);
    }
    if (modulo) {
        valores.push(modulo);
        condicoes.push(`l.modulo = $${valores.length}`);
    }
    if (tipo_acao) {
        valores.push(tipo_acao);
        condicoes.push(`l.tipo_acao = $${valores.length}::tipo_acao_auditoria`);
    }
    if (data_inicio) {
        valores.push(data_inicio);
        condicoes.push(`l.criado_em >= $${valores.length}::date`);
    }
    if (data_fim) {
        valores.push(data_fim);
        condicoes.push(`l.criado_em < $${valores.length}::date + interval '1 day'`);
    }

    return { where: 'WHERE ' + condicoes.join(' AND '), valores };
}

// GET /auditoria — lista paginada com filtros (admin/diretoria)
router.get('/', autorizar('admin', 'diretoria', 'financeiro', 'atendimento', 'operador', 'consulta'), async (req, res) => {
    const { pagina, por_pagina, ordenar } = req.query;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const { where, valores } = construirFiltros(req.query, req.usuario.associacao_id);
        const direcao = ordenar === 'asc' ? 'ASC' : 'DESC';
        const limite = Math.min(parseInt(por_pagina, 10) || 50, 200);
        const paginaAtual = Math.max(parseInt(pagina, 10) || 1, 1);
        const offset = (paginaAtual - 1) * limite;

        const total = await client.query(
            `SELECT COUNT(*) AS total FROM logs_auditoria l ${where}`,
            valores
        );

        const valoresPagina = [...valores, limite, offset];
        const resultado = await client.query(
            `SELECT l.id, l.criado_em, l.usuario_nome, l.usuario_email, l.super_admin_nome, l.super_admin_email,
                    l.modulo, l.tipo_acao, l.descricao, l.dados_anteriores, l.dados_novos, l.ip, l.user_agent
             FROM logs_auditoria l
             ${where}
             ORDER BY l.criado_em ${direcao}
             LIMIT $${valoresPagina.length - 1} OFFSET $${valoresPagina.length}`,
            valoresPagina
        );

        res.json({
            registros: resultado.rows,
            total: parseInt(total.rows[0].total, 10),
            pagina: paginaAtual,
            por_pagina: limite,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar logs de auditoria' });
    } finally {
        client.release();
    }
});

// GET /auditoria/exportar/:formato — mesmos filtros, sem paginação
router.get('/exportar/:formato', autorizar('admin', 'diretoria', 'financeiro', 'atendimento', 'operador', 'consulta'), async (req, res) => {
    const { formato } = req.params;
    if (!['excel', 'pdf'].includes(formato)) {
        return res.status(400).json({ erro: 'formato deve ser "excel" ou "pdf"' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const { where, valores } = construirFiltros(req.query, req.usuario.associacao_id);
        const valoresLimitados = [...valores, LIMITE_EXPORTACAO];
        const resultado = await client.query(
            `SELECT l.criado_em, l.usuario_nome, l.usuario_email, l.super_admin_nome, l.super_admin_email,
                    l.modulo, l.tipo_acao, l.descricao, l.ip
             FROM logs_auditoria l
             ${where}
             ORDER BY l.criado_em DESC
             LIMIT $${valoresLimitados.length}`,
            valoresLimitados
        );

        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'auditoria', tipoAcao: 'exportacao',
            descricao: req.usuario.nome + ' exportou os logs de auditoria em ' + formato.toUpperCase() + ' (' + resultado.rows.length + ' linhas)',
            req,
        });

        if (formato === 'excel') {
            const buffer = await gerarExcelLogs(resultado.rows);
            res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.set('Content-Disposition', 'attachment; filename="auditoria.xlsx"');
            return res.send(Buffer.from(buffer));
        }

        const buffer = await gerarPdfLogs(resultado.rows);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'attachment; filename="auditoria.pdf"');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao exportar logs de auditoria' });
    } finally {
        client.release();
    }
});

module.exports = router;
