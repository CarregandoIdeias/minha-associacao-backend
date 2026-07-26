// utils/precos.js
// Preços por plano — valor-base + valor por associado ativo. São placeholders
// de negócio: revisar com o usuário antes de considerar definitivos.
const PRECOS_PLANO = {
    trial: { base: 0, porAssociado: 0 },
    basico: { base: 49.90, porAssociado: 2.00 },
    profissional: { base: 99.90, porAssociado: 1.50 },
    enterprise: { base: 199.90, porAssociado: 1.00 },
};

// valorManual (associacoes.valor_mensalidade_manual) sempre tem prioridade —
// é a sobrescrita usada pra cobrança negociada fora da fórmula padrão.
function calcularValorMensalidade(plano, totalAssociados, valorManual) {
    if (valorManual !== null && valorManual !== undefined) {
        return parseFloat(valorManual);
    }
    const precos = PRECOS_PLANO[plano] || PRECOS_PLANO.trial;
    return precos.base + precos.porAssociado * (totalAssociados || 0);
}

// Deriva o status da assinatura a partir de ativo/plano/vencimento — não é
// uma coluna própria pra não dessincronizar do que está de fato gravado.
function statusAssinatura(associacao, hoje) {
    if (!associacao.ativo) return 'bloqueada';
    if (associacao.plano === 'trial') {
        const dataAgora = hoje || new Date();
        if (associacao.trial_expira_em && new Date(associacao.trial_expira_em) < dataAgora) {
            return 'trial_expirado';
        }
        return 'trial';
    }
    if (!associacao.vencimento_assinatura) return 'ativa';

    const dataHoje = hoje || new Date();
    const vencimento = new Date(associacao.vencimento_assinatura);
    const diasAlerta = associacao.dias_alerta_vencimento != null ? associacao.dias_alerta_vencimento : 3;
    const diffMs = vencimento.setHours(0, 0, 0, 0) - new Date(dataHoje).setHours(0, 0, 0, 0);
    const diffDias = Math.round(diffMs / 86400000);

    if (diffDias < 0) return 'vencida';
    if (diffDias <= diasAlerta) return 'vencendo';
    return 'ativa';
}

module.exports = { PRECOS_PLANO, calcularValorMensalidade, statusAssinatura };
