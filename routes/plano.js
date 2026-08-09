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
const { limiteUpload } = require('../middleware/rateLimiter');
const {
    calcularValorMensalidade, statusAssinatura, alertaAssinatura, LIMITE_ASSOCIADOS_PLANO,
    PROXIMO_PLANO, alertaLimiteAssociados, planosGerenciaveis, planoMinimoParaComportar,
    assinaturaBloqueadaPorVencimento,
} = require('../utils/precos');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);

const PLANOS_CONTRATAVEIS = ['basico', 'intermediario', 'avancado'];

// GET /plano — dados de plano/trial da associação logada, pra montar o card
// do Dashboard (trial em andamento, plano pago ativo, ou trial expirado) e a
// tela de contratação. Admin e diretoria podem ver (a tela de bloqueio
// precisa aparecer pra qualquer um que logar), só admin pode de fato contratar.
router.get('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const associacao = await client.query(
            `SELECT nome, plano, ativo, trial_dias, trial_expira_em, vencimento_assinatura,
                    valor_mensalidade_manual, dias_alerta_vencimento, dias_alerta_assinatura
             FROM associacoes WHERE id = $1`,
            [req.usuario.associacao_id]
        );
        if (associacao.rows.length === 0) {
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }
        const a = associacao.rows[0];

        // Flag de "já viu o modal de boas-vindas" -- vive em usuarios (é por
        // usuário, não por associação), buscada aqui pra reaproveitar a
        // mesma chamada que já roda logo após o login (ver entrarNoDashboard,
        // painel/index.html) em vez de criar uma rota só pra isso.
        const usuarioRow = await client.query(
            `SELECT boas_vindas_visto_em FROM usuarios WHERE id = $1`,
            [req.usuario.id]
        );
        const boasVindasPendente = usuarioRow.rows.length > 0 && usuarioRow.rows[0].boas_vindas_visto_em === null;

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

        // Controle de limite de associados (item 2, 30/07/2026) -- desde
        // essa data o cadastro É bloqueado ao atingir 100% (ver POST
        // /associados, routes/associados.js), decisão de produto confirmada
        // com o usuário (reverte o "só avisa" documentado antes disso).
        // "Perto do limite" (perto_do_limite, >=90%) é mantido por
        // compatibilidade com quem já consumia esse campo; alerta_limite
        // abaixo é a versão nova, com as 3 faixas (80/90/100%).
        const limiteAssociados = LIMITE_ASSOCIADOS_PLANO[a.plano] != null ? LIMITE_ASSOCIADOS_PLANO[a.plano] : null;
        const pertoDoLimite = limiteAssociados != null && total >= limiteAssociados * 0.9;
        const alertaLimite = alertaLimiteAssociados(a.plano, total);

        // Renovação inteligente (item 6): só preenchido quando o total atual
        // já não cabe mais no plano contratado -- normalmente não deveria
        // acontecer com o bloqueio de cadastro ativo, mas cobre o caso de o
        // Super Admin ter reduzido o plano manualmente com a associação já
        // maior que o novo teto.
        let planoRenovacaoSugerido = null;
        if (limiteAssociados != null && total > limiteAssociados) {
            const sugestao = planoMinimoParaComportar(total);
            if (sugestao !== a.plano) planoRenovacaoSugerido = sugestao;
        }

        res.json({
            nome_associacao: a.nome,
            boas_vindas_pendente: boasVindasPendente,
            plano: a.plano,
            trial_dias: a.trial_dias,
            trial_expira_em: a.trial_expira_em,
            vencimento_assinatura: a.vencimento_assinatura,
            valor_mensalidade: calcularValorMensalidade(a.plano, total, a.valor_mensalidade_manual),
            total_associados: total,
            limite_associados: limiteAssociados,
            perto_do_limite: pertoDoLimite,
            alerta_limite: alertaLimite,
            proximo_plano: PROXIMO_PLANO[a.plano] || null,
            planos_gerenciaveis: planosGerenciaveis(a.plano),
            plano_renovacao_sugerido: planoRenovacaoSugerido,
            status: statusAssinatura(a),
            alerta: alertaAssinatura(a),
            // Fonte única de verdade pro front decidir quando mostrar a tela
            // de bloqueio por assinatura vencida (SEC-015, 08/08/2026) --
            // mesma função usada por bloquearAssinaturaVencida
            // (middleware/auth.js), sem duplicar o cálculo de data no
            // cliente. Diferente de status === 'vencida' (que já é true no
            // dia 0, só informativo).
            bloqueio_assinatura_vencida: assinaturaBloqueadaPorVencimento(a.plano, a.vencimento_assinatura),
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
router.post('/solicitar-contratacao', autorizar('admin'), limiteUpload, async (req, res) => {
    const { plano_solicitado, comprovante_base64 } = req.body;

    if (!plano_solicitado || !PLANOS_CONTRATAVEIS.includes(plano_solicitado)) {
        return res.status(400).json({ erro: 'plano_solicitado deve ser "basico", "intermediario" ou "avancado"' });
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
        // 23505 = unique_violation -- índice único parcial
        // solicitacoes_plano_pendente_unica (migration 20260729020000) é a
        // garantia de verdade contra a race condition de duas requisições
        // simultâneas passarem os dois pelo SELECT acima antes de qualquer
        // uma inserir; o SELECT continua existindo só como saída rápida no
        // caso comum (evita a viagem extra ao banco na maioria das vezes).
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe uma solicitação de contratação aguardando aprovação' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao enviar solicitação de contratação' });
    } finally {
        client.release();
    }
});

module.exports = router;
