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

module.exports = router;
