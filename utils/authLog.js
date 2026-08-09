// utils/authLog.js
// Grava eventos de autenticação (login, logout, troca/redefinição de senha)
// para auditoria. Recebe o client já aberto pelo chamador (pool direto ou
// conexão de tenant), então a policy de RLS de auth_logs se aplica igual às
// outras tabelas.

async function registrarEventoAuth(client, { usuarioId, associacaoId, emailTentado, evento, req }) {
    // req.ip (não o header X-Forwarded-For manualmente) -- Express já resolve
    // o IP de verdade do cliente respeitando app.set('trust proxy', 1)
    // (server.js), que confia só no hop mais próximo do Render. Pegar o
    // header direto permitiria o próprio cliente forjar o IP registrado
    // (X-Forwarded-For é livre pra escrever, e proxies normalmente
    // *acrescentam* o IP real ao invés de sobrescrever).
    const ip = req ? (req.ip || req.socket?.remoteAddress || null) : null;
    const userAgent = req ? (req.headers['user-agent'] || null) : null;

    try {
        await client.query(
            `INSERT INTO auth_logs (usuario_id, associacao_id, email_tentado, evento, ip, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [usuarioId || null, associacaoId || null, emailTentado || null, evento, ip, userAgent]
        );
    } catch (err) {
        // Falha ao logar não pode derrubar o fluxo de autenticação em si.
        console.error('Erro ao registrar evento de autenticação:', err);
    }
}

module.exports = { registrarEventoAuth };
