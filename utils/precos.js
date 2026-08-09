// utils/precos.js
// Preços por plano — valor-base + valor por associado ativo. São placeholders
// de negócio: revisar com o usuário antes de considerar definitivos.
const PRECOS_PLANO = {
    trial: { base: 0, porAssociado: 0 },
    basico: { base: 49.90, porAssociado: 2.00 },
    intermediario: { base: 99.90, porAssociado: 1.50 },
    avancado: { base: 199.90, porAssociado: 1.00 },
};

// Faixa de associados de cada porte, só informativa (avisa a associação
// que está perto do limite do plano contratado) -- NÃO bloqueia o cadastro
// de novos associados, é decisão de produto (upsell, não trava). null =
// sem teto. Ver GET /plano (routes/plano.js).
const LIMITE_ASSOCIADOS_PLANO = { trial: null, basico: 50, intermediario: 200, avancado: null };

// Hierarquia de planos pra gating de funcionalidades (item 29/07/2026,
// "Fase 2" do backlog de melhorias). Trial recebe o nível mais alto de
// propósito -- a promessa comercial é "acesso completo a todos os
// recursos" durante o período de avaliação, ver painel/landing.html.
const NIVEL_PLANO = { trial: 99, basico: 1, intermediario: 2, avancado: 3 };

// Usado por middleware/auth.js (exigirPlano) e pelas rotas que fazem a
// checagem condicional (ex.: routes/usuarios.js, ao atribuir um papel
// granular). planoAtual pode vir undefined/null (não deveria, mas por
// segurança nesse caso nunca atende nenhum nível mínimo > 0).
function planoAtendeNivel(planoAtual, nivelMinimo) {
    const nivelAtual = NIVEL_PLANO[planoAtual] != null ? NIVEL_PLANO[planoAtual] : 0;
    const nivelExigido = NIVEL_PLANO[nivelMinimo] != null ? NIVEL_PLANO[nivelMinimo] : 0;
    return nivelAtual >= nivelExigido;
}

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

// Alerta inteligente de renovação (item de sprint 1.4, painel/index.html):
// diz se/quão urgente é o card de vencimento do Dashboard da associação.
// null = não mostrar alerta (fora da janela configurada, ou plano pago sem
// vencimento definido). Independente de statusAssinatura() acima -- aquela
// função usa `dias_alerta_vencimento` (cobranças de associados, ver
// comentário na migration) só pra rotular a linha na lista do Super Admin;
// esta usa a coluna dedicada `dias_alerta_assinatura`.
function alertaAssinatura(associacao, hoje) {
    const dataHoje = hoje || new Date();

    if (associacao.plano === 'trial') {
        if (!associacao.trial_expira_em) return null;
        const diasRestantes = Math.ceil((new Date(associacao.trial_expira_em) - dataHoje) / 86400000);
        if (diasRestantes > 7) return null;
        return {
            tipo: 'trial',
            dias_restantes: diasRestantes,
            nivel: diasRestantes <= 3 ? 'critico' : 'alerta',
        };
    }

    if (!associacao.vencimento_assinatura) return null;
    const diasAlerta = associacao.dias_alerta_assinatura != null ? associacao.dias_alerta_assinatura : 30;
    const vencimento = new Date(associacao.vencimento_assinatura).setHours(0, 0, 0, 0);
    const diasRestantes = Math.round((vencimento - new Date(dataHoje).setHours(0, 0, 0, 0)) / 86400000);
    if (diasRestantes > diasAlerta) return null;

    let nivel;
    if (diasRestantes <= 0) nivel = 'critico';
    else if (diasRestantes <= Math.ceil(diasAlerta / 3)) nivel = 'alerta';
    else nivel = 'atencao';

    return { tipo: 'assinatura', dias_restantes: diasRestantes, nivel: nivel };
}

// Tolerância antes de BLOQUEAR acesso por assinatura paga vencida
// (auditoria de segurança Fase 3, 08/08/2026 -- SEC-015). Diferente de
// statusAssinatura() acima, que já marca 'vencida' no dia 0 (usado só como
// badge informativo no Dashboard/Super Admin) -- essa função é o cálculo
// separado que decide bloqueio de acesso de verdade, com folga porque a
// cobrança é manual (Pix + comprovante + aprovação do Super Admin), não
// instantânea.
const DIAS_TOLERANCIA_ASSINATURA_VENCIDA = 5;

// Verdadeiro quando o acesso deve ser bloqueado por assinatura paga vencida
// há mais de DIAS_TOLERANCIA_ASSINATURA_VENCIDA dias. Nunca bloqueia trial
// (isso é bloquearTrialExpirado, outro middleware) nem plano pago sem
// vencimento definido (associação legada/negociação manual).
function assinaturaBloqueadaPorVencimento(plano, vencimentoAssinatura, hoje) {
    if (plano === 'trial' || !vencimentoAssinatura) return false;
    const limite = new Date(vencimentoAssinatura);
    limite.setDate(limite.getDate() + DIAS_TOLERANCIA_ASSINATURA_VENCIDA);
    return limite < (hoje || new Date());
}

// Próximo plano pago sugerido a partir do atual -- usado na sugestão
// automática de upgrade (item 3, 30/07/2026). trial não entra aqui porque
// não tem "próximo" único: ao esgotar o trial a associação escolhe
// livremente entre os 3 (ver GET /plano -> planos_gerenciaveis).
const PROXIMO_PLANO = { trial: null, basico: 'intermediario', intermediario: 'avancado', avancado: null };

// Ordem dos planos pagos, usada por planoMinimoParaComportar abaixo.
const ORDEM_PLANOS_PAGOS = ['basico', 'intermediario', 'avancado'];

// Alerta de uso do limite de associados, por faixa (item 2, 30/07/2026):
// 80% = aviso discreto, 90% = atenção com vagas restantes, 100% = crítico.
// null quando o plano não tem teto (trial/avançado) ou uso < 80%.
function alertaLimiteAssociados(plano, totalAssociados) {
    const limite = LIMITE_ASSOCIADOS_PLANO[plano];
    if (limite == null || limite <= 0) return null;

    const percentual = Math.round((totalAssociados / limite) * 100);
    if (percentual < 80) return null;

    const vagasRestantes = Math.max(0, limite - totalAssociados);

    if (percentual >= 100) {
        return {
            nivel: 'critico',
            percentual: percentual,
            vagas_restantes: vagasRestantes,
            mensagem: 'Você atingiu o limite de associados permitido pelo seu plano.',
        };
    }
    if (percentual >= 90) {
        return {
            nivel: 'alerta',
            percentual: percentual,
            vagas_restantes: vagasRestantes,
            mensagem: 'Atenção! Restam apenas ' + vagasRestantes + (vagasRestantes === 1 ? ' vaga' : ' vagas') + ' para novos associados.',
        };
    }
    return {
        nivel: 'atencao',
        percentual: percentual,
        vagas_restantes: vagasRestantes,
        mensagem: 'Você já utilizou ' + percentual + '% da capacidade do seu plano.',
    };
}

// Quais planos aparecem no modal "Gerenciar Plano" (item 4, 30/07/2026) --
// nunca oferece downgrade pelo cliente (regra de negócio: downgrade só pelo
// Super Admin, depois de validar que a quantidade de associados é
// compatível). trial e básico mostram os 3 (básico ainda pode "ficar" nele
// mesmo, não é downgrade); intermediário só mostra avançado; avançado não
// tem opção nenhuma (front mostra "Pagar Plano" nesse caso, sem escolha).
function planosGerenciaveis(planoAtual) {
    if (planoAtual === 'trial' || planoAtual === 'basico') return ['basico', 'intermediario', 'avancado'];
    if (planoAtual === 'intermediario') return ['avancado'];
    return [];
}

// Menor plano pago que comporta a quantidade atual de associados (item 6,
// renovação inteligente) -- usado quando a associação cresceu além do
// limite do plano atual e precisa saber pra qual plano a renovação deve
// migrar. Sempre devolve algum plano (avançado nunca tem teto).
function planoMinimoParaComportar(totalAssociados) {
    for (let i = 0; i < ORDEM_PLANOS_PAGOS.length; i++) {
        const plano = ORDEM_PLANOS_PAGOS[i];
        const limite = LIMITE_ASSOCIADOS_PLANO[plano];
        if (limite == null || totalAssociados <= limite) return plano;
    }
    return 'avancado';
}

module.exports = {
    PRECOS_PLANO,
    LIMITE_ASSOCIADOS_PLANO,
    NIVEL_PLANO,
    PROXIMO_PLANO,
    DIAS_TOLERANCIA_ASSINATURA_VENCIDA,
    planoAtendeNivel,
    calcularValorMensalidade,
    statusAssinatura,
    alertaAssinatura,
    alertaLimiteAssociados,
    planosGerenciaveis,
    planoMinimoParaComportar,
    assinaturaBloqueadaPorVencimento,
};
