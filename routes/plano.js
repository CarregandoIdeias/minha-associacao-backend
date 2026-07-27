// routes/plano.js
// Status do plano/trial da associação + fluxo de contratação self-service
// (Pix da plataforma + comprovante, aprovado depois pelo Super Admin em
// routes/superadmin.js). De propósito SEM bloquearTrialExpirado — é
// justamente a rota que precisa continuar funcionando com o trial vencido,
// senão a associação nunca conseguiria contratar um plano pra sair do
// bloqueio.
const express = require('express');
const { autenticar, bloquearSenhaProvisoria, autorizar, comConexaoTenant } = require('../middleware/auth');
const { registrarLogAuditoria } = require('../utils/auditoria');
const { comprovanteBase64Valido } = require('../utils/validacao');
const { calcularValorMensalidade, statusAssinatura, alertaAssinatura } = require('../utils/precos');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);

const PLANOS_CONTRATAVEIS = ['basico', 'profissional', 'enterprise'];

// GET /plano — dados de plano/trial da associação logada, pra montar o card
// do Dashboard (trial em andamento, plano pago ativo, ou trial expirado) e a
// tela de contratação. Admin e diretoria podem ver (a tela de bloqueio
// precisa aparecer pra qualquer um que logar), só admin pode de fato contratar.
router.get('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const associacao = await client.query(
            `SELECT plano, ativo, trial_dias, trial_expira_em, vencimento_assinatura,
                    valor_mensalidade_manual, dias_alerta_vencimento, dias_alerta_assinatura
             FROM associacoes WHERE id = $1`,
            [req.usuario.associacao_id]
        );
        if (associacao.rows.length === 0) {
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }
        const a = associacao.rows[0];

        const totalAssociados = await client.query(
            `SELECT COUNT(*) AS total FROM associados WHERE associacao_id = $1`,
            [req.usuario.associacao_id]
        );
        const total = parseInt(totalAssociados.rows[0].total, 10);

        const pixPlataforma = await client.query(
            `SELECT chave_pix, nome_recebedor_pix, cidade_pix FROM configuracoes_plataforma WHERE id = true`
        );

        const solicitacaoPendente = await client.query(
            `SELECT id, plano_solicitado, valor_referencia, solicitado_em
             FROM solicitacoes_plano
             WHERE associacao_id = $1 AND status = 'pendente'
             ORDER BY solicitado_em DESC LIMIT 1`,
            [req.usuario.associacao_id]
        );

        res.json({
            plano: a.plano,
            trial_dias: a.trial_dias,
            trial_expira_em: a.trial_expira_em,
            vencimento_assinatura: a.vencimento_assinatura,
            valor_mensalidade: calcularValorMensalidade(a.plano, total, a.valor_mensalidade_manual),
            total_associados: total,
            status: statusAssinatura(a),
            alerta: alertaAssinatura(a),
            pix_plataforma: pixPlataforma.rows[0] || { chave_pix: null, nome_recebedor_pix: null, cidade_pix: null },
            solicitacao_pendente: solicitacaoPendente.rows[0] || null,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar dados do plano' });
    } finally {
        client.release();
    }
});

// POST /plano/solicitar-contratacao — associação envia comprovante de
// pagamento pra contratar (do trial) ou trocar de plano (upgrade). Fica
// "pendente" até o Super Admin aprovar (routes/superadmin.js).
router.post('/solicitar-contratacao', autorizar('admin'), async (req, res) => {
    const { plano_solicitado, comprovante_base64 } = req.body;

    if (!plano_solicitado || !PLANOS_CONTRATAVEIS.includes(plano_solicitado)) {
        return res.status(400).json({ erro: 'plano_solicitado deve ser "basico", "profissional" ou "enterprise"' });
    }
    if (!comprovante_base64) {
        return res.status(400).json({ erro: 'comprovante_base64 é obrigatório' });
    }
    if (comprovante_base64.length > 2_800_000) {
        return res.status(400).json({ erro: 'Arquivo muito grande. Escolha uma imagem menor.' });
    }
    // Valida o data URL inteiro, não só o prefixo -- ver comentário em
    // utils/validacao.js (era vetor de XSS armazenado contra o Super Admin).
    if (!comprovanteBase64Valido(comprovante_base64)) {
        return res.status(400).json({ erro: 'Envie uma imagem (PNG/JPG/GIF/WEBP) ou PDF válido do comprovante' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const pendente = await client.query(
            `SELECT id FROM solicitacoes_plano WHERE associacao_id = $1 AND status = 'pendente'`,
            [req.usuario.associacao_id]
        );
        if (pendente.rows.length > 0) {
            return res.status(409).json({ erro: 'Já existe uma solicitação de contratação aguardando aprovação' });
        }

        const totalAssociados = await client.query(
            `SELECT COUNT(*) AS total FROM associados WHERE associacao_id = $1`,
            [req.usuario.associacao_id]
        );
        const valorReferencia = calcularValorMensalidade(plano_solicitado, parseInt(totalAssociados.rows[0].total, 10), null);

        const resultado = await client.query(
            `INSERT INTO solicitacoes_plano (associacao_id, plano_solicitado, valor_referencia, comprovante_base64, solicitado_por)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, plano_solicitado, valor_referencia, solicitado_em`,
            [req.usuario.associacao_id, plano_solicitado, valorReferencia, comprovante_base64, req.usuario.id]
        );

        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'planos', tipoAcao: 'criacao',
            descricao: req.usuario.nome + ' solicitou a contratação do plano ' + plano_solicitado,
            dadosNovos: resultado.rows[0], req,
        });

        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao enviar solicitação de contratação' });
    } finally {
        client.release();
    }
});

module.exports = router;
