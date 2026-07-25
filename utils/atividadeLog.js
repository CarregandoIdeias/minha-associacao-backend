// utils/atividadeLog.js
// Grava atividades (associado cadastrado/editado, cobrança paga, comunicado
// publicado, usuário convidado) para alimentar o card "Atividades recentes"
// do Dashboard. Recebe o client já aberto pelo chamador (mesma conexão de
// tenant da operação principal), então a policy de RLS de atividades se
// aplica igual às outras tabelas.

async function registrarAtividade(client, { associacaoId, usuarioId, usuarioNome, tipo, descricao }) {
    try {
        await client.query(
            `INSERT INTO atividades (associacao_id, usuario_id, usuario_nome, tipo, descricao)
             VALUES ($1, $2, $3, $4, $5)`,
            [associacaoId || null, usuarioId || null, usuarioNome || null, tipo, descricao]
        );
    } catch (err) {
        // Falha ao logar não pode derrubar o fluxo principal (criar/editar
        // associado, registrar pagamento, etc.).
        console.error('Erro ao registrar atividade:', err);
    }
}

module.exports = { registrarAtividade };
