// routes/configuracoes.js
const express = require('express');
const { autenticar, bloquearSenhaProvisoria, bloquearTrialExpirado, exigirPlano, autorizar, comConexaoTenant } = require('../middleware/auth');
const { registrarLogAuditoria } = require('../utils/auditoria');
const { imagemBase64Valida } = require('../utils/validacao');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);
router.use(bloquearTrialExpirado);

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
        const anterior = await client.query(
            `SELECT chave_pix, nome_recebedor_pix, cidade_pix FROM associacoes WHERE id = $1`,
            [req.usuario.associacao_id]
        );
        await client.query(
            `UPDATE associacoes SET chave_pix = $1, nome_recebedor_pix = $2, cidade_pix = $3 WHERE id = $4`,
            [chave_pix, nome_recebedor_pix, cidade_pix, req.usuario.associacao_id]
        );
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'configuracoes', tipoAcao: 'edicao',
            descricao: req.usuario.nome + ' atualizou a configuração de Pix',
            dadosAnteriores: anterior.rows[0] || null, dadosNovos: { chave_pix, nome_recebedor_pix, cidade_pix }, req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao salvar configuração de Pix' });
    } finally {
        client.release();
    }
});

// GET /configuracoes/identidade — nome e logo da própria associação, pra
// exibir no cabeçalho do Dashboard (ver painel/index.html). Qualquer usuário
// autenticado pode ler, mesmo padrão de /pix.
router.get('/identidade', async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT nome, logo_url FROM associacoes WHERE id = $1`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar identidade da associação' });
    } finally {
        client.release();
    }
});

// PUT /configuracoes/logo — só admin troca a logo da própria associação
router.put('/logo', autorizar('admin'), async (req, res) => {
    const { logo_base64 } = req.body;

    if (!logo_base64) {
        return res.status(400).json({ erro: 'logo_base64 é obrigatório' });
    }
    // Limite de ~2MB em base64, mesmo padrão de /portal/minha-foto
    if (logo_base64.length > 2_800_000) {
        return res.status(400).json({ erro: 'Imagem muito grande. Escolha uma logo menor.' });
    }
    // Valida o data URL inteiro, não só o prefixo -- ver utils/validacao.js.
    if (!imagemBase64Valida(logo_base64)) {
        return res.status(400).json({ erro: 'Formato de imagem inválido. Envie PNG, JPG, GIF ou WEBP.' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query(
            `UPDATE associacoes SET logo_url = $1 WHERE id = $2`,
            [logo_base64, req.usuario.associacao_id]
        );
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'configuracoes', tipoAcao: 'edicao',
            descricao: req.usuario.nome + ' atualizou a logo da associação',
            dadosAnteriores: null, dadosNovos: null, req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao salvar a logo' });
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

// PUT /configuracoes/alertas — só admin configura, e só a partir do plano
// Intermediário (gating por plano, 29/07/2026 — landing page anuncia
// "Alertas automáticos de vencimento" como diferencial a partir daí; no
// Básico o valor fica travado no default, ler GET acima continua liberado
// pra qualquer papel/plano, só a edição é bloqueada).
router.put('/alertas', autorizar('admin'), exigirPlano('intermediario'), async (req, res) => {
    const { dias_alerta_vencimento } = req.body;
    const dias = parseInt(dias_alerta_vencimento, 10);

    if (isNaN(dias) || dias < 0 || dias > 30) {
        return res.status(400).json({ erro: 'dias_alerta_vencimento deve ser um número entre 0 e 30' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const anterior = await client.query(
            `SELECT dias_alerta_vencimento FROM associacoes WHERE id = $1`,
            [req.usuario.associacao_id]
        );
        await client.query(
            `UPDATE associacoes SET dias_alerta_vencimento = $1 WHERE id = $2`,
            [dias, req.usuario.associacao_id]
        );
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'configuracoes', tipoAcao: 'edicao',
            descricao: req.usuario.nome + ' atualizou a configuração de alertas de vencimento',
            dadosAnteriores: anterior.rows[0] || null, dadosNovos: { dias_alerta_vencimento: dias }, req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao salvar configuração de alertas' });
    } finally {
        client.release();
    }
});

module.exports = router;
