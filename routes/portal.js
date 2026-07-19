// routes/portal.js
// Rotas exclusivas para o papel "associado" — cada um só vê os próprios dados.
const express = require('express');
const { autenticar, autorizar, comConexaoTenant } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);
router.use(autorizar('associado'));

// GET /portal/meus-dados — dados do associado vinculado ao usuário logado
router.get('/meus-dados', async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT id, nome_completo, cpf, telefone, categoria, status, data_ingresso, foto_base64
             FROM associados
             WHERE usuario_id = $1`,
            [req.usuario.id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Nenhum cadastro de associado vinculado a esse login' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar seus dados' });
    } finally {
        client.release();
    }
});

// PUT /portal/minha-foto — atualiza a foto do associado vinculado ao usuário logado
router.put('/minha-foto', async (req, res) => {
    const { foto_base64 } = req.body;

    if (!foto_base64) {
        return res.status(400).json({ erro: 'foto_base64 é obrigatório' });
    }
    // Limite de ~2MB em base64, para não sobrecarregar o banco
    if (foto_base64.length > 2_800_000) {
        return res.status(400).json({ erro: 'Imagem muito grande. Escolha uma foto menor.' });
    }
    if (!foto_base64.startsWith('data:image/')) {
        return res.status(400).json({ erro: 'Formato de imagem inválido' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `UPDATE associados SET foto_base64 = $1 WHERE usuario_id = $2 RETURNING id`,
            [foto_base64, req.usuario.id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Nenhum cadastro de associado vinculado a esse login' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao salvar foto' });
    } finally {
        client.release();
    }
});

// GET /portal/minhas-cobrancas — cobranças do associado vinculado ao usuário logado
router.get('/minhas-cobrancas', async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const associado = await client.query(
            `SELECT id FROM associados WHERE usuario_id = $1`,
            [req.usuario.id]
        );
        if (associado.rows.length === 0) {
            return res.status(404).json({ erro: 'Nenhum cadastro de associado vinculado a esse login' });
        }

        const resultado = await client.query(
            `SELECT id, descricao, valor, vencimento, status, metodo
             FROM cobrancas
             WHERE associado_id = $1
             ORDER BY vencimento DESC`,
            [associado.rows[0].id]
        );

        const hoje = new Date().toISOString().substring(0, 10);
        const linhas = resultado.rows.map((linha) => {
            if (linha.status === 'pendente' && linha.vencimento.toISOString().substring(0, 10) < hoje) {
                return { ...linha, status_exibicao: 'atrasado' };
            }
            return { ...linha, status_exibicao: linha.status };
        });

        res.json(linhas);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar suas cobranças' });
    } finally {
        client.release();
    }
});

module.exports = router;
