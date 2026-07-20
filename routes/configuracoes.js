// routes/configuracoes.js
const express = require('express');
const { autenticar, autorizar, comConexaoTenant } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// GET /configuracoes/pix — qualquer usuário autenticado pode ler (precisa para montar o QR code)
router.get('/pix', async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT chave_pix, nome_recebedor_pix, cidade_pix FROM associacoes WHERE id = $1`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar configuração de Pix' });
    } finally {
        client.release();
    }
});

// PUT /configuracoes/pix — só admin configura
router.put('/pix', autorizar('admin'), async (req, res) => {
    const { chave_pix, nome_recebedor_pix, cidade_pix } = req.body;

    if (!chave_pix || !nome_recebedor_pix || !cidade_pix) {
        return res.status(400).json({ erro: 'chave_pix, nome_recebedor_pix e cidade_pix são obrigatórios' });
    }
    if (nome_recebedor_pix.length > 25) {
        return res.status(400).json({ erro: 'nome_recebedor_pix deve ter no máximo 25 caracteres' });
    }
    if (cidade_pix.length > 15) {
        return res.status(400).json({ erro: 'cidade_pix deve ter no máximo 15 caracteres' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query(
            `UPDATE associacoes SET chave_pix = $1, nome_recebedor_pix = $2, cidade_pix = $3 WHERE id = $4`,
            [chave_pix, nome_recebedor_pix, cidade_pix, req.usuario.associacao_id]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao salvar configuração de Pix' });
    } finally {
        client.release();
    }
});

// GET /configuracoes/alertas — qualquer usuário autenticado pode ler
router.get('/alertas', async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT dias_alerta_vencimento FROM associacoes WHERE id = $1`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows[0] || { dias_alerta_vencimento: 3 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar configuração de alertas' });
    } finally {
        client.release();
    }
});

// PUT /configuracoes/alertas — só admin configura
router.put('/alertas', autorizar('admin'), async (req, res) => {
    const { dias_alerta_vencimento } = req.body;
    const dias = parseInt(dias_alerta_vencimento, 10);

    if (isNaN(dias) || dias < 0 || dias > 30) {
        return res.status(400).json({ erro: 'dias_alerta_vencimento deve ser um número entre 0 e 30' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query(
            `UPDATE associacoes SET dias_alerta_vencimento = $1 WHERE id = $2`,
            [dias, req.usuario.associacao_id]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao salvar configuração de alertas' });
    } finally {
        client.release();
    }
});

module.exports = router;
