// utils/auditoria.js
// Grava na tabela central logs_auditoria (tela "Auditoria" do Super Admin,
// cross-tenant). Diferente de atividadeLog.js (feed leve do Dashboard de uma
// associação) e authLog.js (só login/logout/senha) -- este é o log completo
// pedido pra auditoria: quem, quando, de onde, o que mudou (antes/depois).
// Recebe o client já aberto pelo chamador (pool direto ou conexão de
// tenant/superadmin) -- a policy de INSERT de logs_auditoria é sempre
// permitida (WITH CHECK true), então funciona com qualquer conexão.

async function registrarLogAuditoria(client, {
    associacaoId,
    usuarioId, usuarioNome, usuarioEmail,
    superAdminId, superAdminNome, superAdminEmail,
    modulo, tipoAcao, descricao,
    dadosAnteriores, dadosNovos,
    req,
}) {
    const ip = req
        ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null
        : null;
    const userAgent = req ? (req.headers['user-agent'] || null) : null;

    try {
        await client.query(
            `INSERT INTO logs_auditoria
                (associacao_id, usuario_id, usuario_nome, usuario_email,
                 super_admin_id, super_admin_nome, super_admin_email,
                 modulo, tipo_acao, descricao, dados_anteriores, dados_novos, ip, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
                associacaoId || null,
                usuarioId || null, usuarioNome || null, usuarioEmail || null,
                superAdminId || null, superAdminNome || null, superAdminEmail || null,
                modulo, tipoAcao, descricao,
                dadosAnteriores ? JSON.stringify(dadosAnteriores) : null,
                dadosNovos ? JSON.stringify(dadosNovos) : null,
                ip, userAgent,
            ]
        );
    } catch (err) {
        // Falha ao logar não pode derrubar o fluxo principal, mesmo raciocínio
        // de registrarEventoAuth/registrarAtividade.
        console.error('Erro ao registrar log de auditoria:', err);
    }
}

module.exports = { registrarLogAuditoria };
