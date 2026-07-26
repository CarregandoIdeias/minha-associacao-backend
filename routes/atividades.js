// routes/atividades.js
const express = require('express');
const { autenticar, bloquearSenhaProvisoria, bloquearTrialExpirado, autorizar, comConexaoTenant } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);
router.use(bloquearTrialExpirado);

// GET /atividades — últimas atividades da associação (cadastro/edição de
// associado, pagamento registrado, comunicado publicado, usuário convidado),
// mais recente primeiro. Alimenta o card "Atividades recentes" do Dashboard.
router.get('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT id, tipo, descricao, usuario_nome, criado_em
             FROM atividades
             WHERE associacao_id = $1
             ORDER BY criado_em DESC
             LIMIT 15`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar atividades' });
    } finally {
        client.release();
    }
});

module.exports = router;
