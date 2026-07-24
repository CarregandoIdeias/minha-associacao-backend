// routes/portal.js
// Rotas exclusivas para o papel "associado" — cada um só vê os próprios dados.
const express = require('express');
const { autenticar, bloquearSenhaProvisoria, autorizar, comConexaoTenant } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);
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

        const configAssociacao = await client.query(
            `SELECT dias_alerta_vencimento FROM associacoes WHERE id = $1`,
            [req.usuario.associacao_id]
        );
        const diasAlerta = configAssociacao.rows[0] ? configAssociacao.rows[0].dias_alerta_vencimento : 3;

        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        const linhas = resultado.rows.map((linha) => {
            if (linha.status !== 'pendente') {
                return { ...linha, status_exibicao: linha.status, dias_restantes: null };
            }
            const vencimento = new Date(linha.vencimento);
            vencimento.setHours(0, 0, 0, 0);
            const diasRestantes = Math.round((vencimento - hoje) / (1000 * 60 * 60 * 24));

            if (diasRestantes < 0) {
                return { ...linha, status_exibicao: 'atrasado', dias_restantes: diasRestantes };
            }
            if (diasRestantes <= diasAlerta) {
                return { ...linha, status_exibicao: 'vencendo_em_breve', dias_restantes: diasRestantes };
            }
            return { ...linha, status_exibicao: 'pendente', dias_restantes: diasRestantes };
        });

        res.json(linhas);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar suas cobranças' });
    } finally {
        client.release();
    }
});

// PUT /portal/minhas-cobrancas/:id/comprovante — associado envia comprovante de pagamento
router.put('/minhas-cobrancas/:id/comprovante', async (req, res) => {
    const { id } = req.params;
    const { comprovante_base64 } = req.body;

    if (!comprovante_base64) {
        return res.status(400).json({ erro: 'comprovante_base64 é obrigatório' });
    }
    if (comprovante_base64.length > 2_800_000) {
        return res.status(400).json({ erro: 'Arquivo muito grande. Escolha uma imagem menor.' });
    }
    if (!comprovante_base64.startsWith('data:image/') && !comprovante_base64.startsWith('data:application/pdf')) {
        return res.status(400).json({ erro: 'Envie uma imagem ou PDF do comprovante' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const associado = await client.query(`SELECT id FROM associados WHERE usuario_id = $1`, [req.usuario.id]);
        if (associado.rows.length === 0) {
            return res.status(404).json({ erro: 'Nenhum cadastro de associado vinculado a esse login' });
        }

        const cobranca = await client.query(
            `SELECT id, status FROM cobrancas WHERE id = $1 AND associado_id = $2`,
            [id, associado.rows[0].id]
        );
        if (cobranca.rows.length === 0) {
            return res.status(404).json({ erro: 'Cobrança não encontrada' });
        }
        if (cobranca.rows[0].status === 'pago') {
            return res.status(409).json({ erro: 'Essa cobrança já está paga' });
        }

        await client.query(
            `UPDATE cobrancas
             SET comprovante_base64 = $1, comprovante_enviado_em = now(), status = 'aguardando_confirmacao'
             WHERE id = $2`,
            [comprovante_base64, id]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao enviar comprovante' });
    } finally {
        client.release();
    }
});

module.exports = router;
