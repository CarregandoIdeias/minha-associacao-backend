// routes/associados.js
// CRUD completo já usando o isolamento por tenant (RLS).
const express = require('express');
const bcrypt = require('bcryptjs');
const { autenticar, bloquearSenhaProvisoria, bloquearTrialExpirado, autorizar, comConexaoTenant } = require('../middleware/auth');
const { cpfValido, emailValido, gerarSenhaProvisoria } = require('../utils/validacao');
const { registrarEventoAuth } = require('../utils/authLog');
const { registrarAtividade } = require('../utils/atividadeLog');
const { registrarLogAuditoria } = require('../utils/auditoria');

const router = express.Router();

// Todas as rotas abaixo exigem estar logado
router.use(autenticar);
router.use(bloquearSenhaProvisoria);
router.use(bloquearTrialExpirado);

// GET /associados — lista os associados da associação do usuário logado (só admin/diretoria)
//
// Paginação é opt-in via ?pagina=/?por_pagina= -- sem esses parâmetros, o
// comportamento é idêntico ao de sempre (array completo), porque o
// Dashboard (KPIs, gráficos de 12 meses, "últimos associados") e a busca
// instantânea da lista dependem hoje de ter o array inteiro no cliente
// (associadosCache em painel/index.html). Adicionar LIMIT/OFFSET sem essa
// distinção quebraria tudo isso -- a paginação de verdade na tela de
// Associados (e mover a busca pro backend) é um passo futuro, separado.
router.get('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const { pagina, por_pagina } = req.query;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const camposSelect = `id, nome_completo, cpf, telefone, categoria, status, data_ingresso, observacao, criado_em,
                    rg, endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
                    endereco_bairro, endereco_cidade, endereco_estado`;

        if (pagina == null && por_pagina == null) {
            const resultado = await client.query(
                `SELECT ${camposSelect} FROM associados WHERE associacao_id = $1 ORDER BY nome_completo`,
                [req.usuario.associacao_id]
            );
            return res.json(resultado.rows);
        }

        const limite = Math.min(parseInt(por_pagina, 10) || 50, 200);
        const paginaAtual = Math.max(parseInt(pagina, 10) || 1, 1);
        const offset = (paginaAtual - 1) * limite;

        const total = await client.query(
            `SELECT COUNT(*) AS total FROM associados WHERE associacao_id = $1`,
            [req.usuario.associacao_id]
        );
        const resultado = await client.query(
            `SELECT ${camposSelect} FROM associados WHERE associacao_id = $1 ORDER BY nome_completo LIMIT $2 OFFSET $3`,
            [req.usuario.associacao_id, limite, offset]
        );

        res.json({
            registros: resultado.rows,
            total: parseInt(total.rows[0].total, 10),
            pagina: paginaAtual,
            por_pagina: limite,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar associados' });
    } finally {
        client.release();
    }
});

// POST /associados — cria um associado e já provisiona o login dele com uma
// senha gerada automaticamente (só admin/diretoria)
router.post('/', autorizar('admin', 'diretoria'), async (req, res) => {
    const {
        nome_completo, cpf, telefone, categoria, observacao, email, rg,
        endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
        endereco_bairro, endereco_cidade, endereco_estado,
    } = req.body;

    if (!nome_completo || !nome_completo.trim()) {
        return res.status(400).json({ erro: 'nome_completo é obrigatório' });
    }
    if (cpf && !cpfValido(cpf)) {
        return res.status(400).json({ erro: 'CPF inválido' });
    }
    if (!email || !emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail válido é obrigatório' });
    }

    // Gerado/hasheado antes de pegar a conexão -- bcrypt é deliberadamente
    // lento (~50-100ms de CPU) e não depende de nada do banco; fazer isso
    // com uma conexão do pool já emprestada (e uma transação já aberta)
    // seguraria essa conexão por mais tempo que o necessário sob carga.
    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query('BEGIN');

        const usuario = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel, deve_trocar_senha)
             VALUES ($1, $2, $3, $4, 'associado', true)
             RETURNING id`,
            [req.usuario.associacao_id, nome_completo.trim(), email.trim(), senhaHash]
        );

        const resultado = await client.query(
            `INSERT INTO associados (associacao_id, usuario_id, nome_completo, cpf, telefone, categoria, observacao,
                                      rg, endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
                                      endereco_bairro, endereco_cidade, endereco_estado)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             RETURNING id, nome_completo, cpf, telefone, categoria, status, data_ingresso, observacao, criado_em,
                       rg, endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
                       endereco_bairro, endereco_cidade, endereco_estado`,
            [req.usuario.associacao_id, usuario.rows[0].id, nome_completo.trim(), cpf || null, telefone || null, categoria || null, observacao || null,
                rg || null, endereco_cep || null, endereco_logradouro || null, endereco_numero || null, endereco_complemento || null,
                endereco_bairro || null, endereco_cidade || null, endereco_estado || null]
        );

        await registrarEventoAuth(client, {
            usuarioId: usuario.rows[0].id,
            associacaoId: req.usuario.associacao_id,
            emailTentado: email,
            evento: 'senha_provisoria_criada',
            req,
        });

        await registrarAtividade(client, {
            associacaoId: req.usuario.associacao_id,
            usuarioId: req.usuario.id,
            usuarioNome: req.usuario.nome,
            tipo: 'associado_criado',
            descricao: 'cadastrou o associado ' + resultado.rows[0].nome_completo,
        });
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'associados', tipoAcao: 'criacao',
            descricao: req.usuario.nome + ' cadastrou o associado ' + resultado.rows[0].nome_completo,
            dadosNovos: resultado.rows[0], req,
        });

        await client.query('COMMIT');
        res.status(201).json({ ...resultado.rows[0], email: email.trim(), senha_provisoria: senhaProvisoria });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            if (err.constraint === 'associados_associacao_id_cpf_key') {
                return res.status(409).json({ erro: 'Já existe um associado com esse CPF nessa associação' });
            }
            if (err.constraint === 'usuarios_email_unique_idx') {
                return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail na plataforma' });
            }
            return res.status(409).json({ erro: 'Registro duplicado' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar associado' });
    } finally {
        client.release();
    }
});

// PUT /associados/:id — edita um associado existente (só admin/diretoria)
router.put('/:id', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    const {
        nome_completo, cpf, telefone, categoria, status, observacao, rg,
        endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
        endereco_bairro, endereco_cidade, endereco_estado,
    } = req.body;

    if (!nome_completo || !nome_completo.trim()) {
        return res.status(400).json({ erro: 'nome_completo é obrigatório' });
    }
    if (cpf && !cpfValido(cpf)) {
        return res.status(400).json({ erro: 'CPF inválido' });
    }
    const statusValidos = ['ativo', 'inadimplente', 'desligado', 'suspenso'];
    if (status && !statusValidos.includes(status)) {
        return res.status(400).json({ erro: 'status inválido' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const anterior = await client.query(
            `SELECT id, nome_completo, cpf, telefone, categoria, status, observacao,
                    rg, endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
                    endereco_bairro, endereco_cidade, endereco_estado
             FROM associados WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (anterior.rows.length === 0) {
            return res.status(404).json({ erro: 'Associado não encontrado' });
        }

        const resultado = await client.query(
            `UPDATE associados
             SET nome_completo = $1, cpf = $2, telefone = $3, categoria = $4,
                 status = COALESCE($5, status), observacao = $6,
                 rg = $9, endereco_cep = $10, endereco_logradouro = $11, endereco_numero = $12,
                 endereco_complemento = $13, endereco_bairro = $14, endereco_cidade = $15, endereco_estado = $16
             WHERE id = $7 AND associacao_id = $8
             RETURNING id, nome_completo, cpf, telefone, categoria, status, data_ingresso, observacao, criado_em,
                       rg, endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
                       endereco_bairro, endereco_cidade, endereco_estado`,
            [nome_completo.trim(), cpf || null, telefone || null, categoria || null, status || null, observacao || null, id, req.usuario.associacao_id,
                rg || null, endereco_cep || null, endereco_logradouro || null, endereco_numero || null,
                endereco_complemento || null, endereco_bairro || null, endereco_cidade || null, endereco_estado || null]
        );

        await registrarAtividade(client, {
            associacaoId: req.usuario.associacao_id,
            usuarioId: req.usuario.id,
            usuarioNome: req.usuario.nome,
            tipo: 'associado_editado',
            descricao: 'atualizou o cadastro de ' + resultado.rows[0].nome_completo,
        });
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'associados', tipoAcao: 'edicao',
            descricao: req.usuario.nome + ' atualizou o cadastro de ' + resultado.rows[0].nome_completo,
            dadosAnteriores: anterior.rows[0], dadosNovos: resultado.rows[0], req,
        });

        res.json(resultado.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe um associado com esse CPF nessa associação' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar associado' });
    } finally {
        client.release();
    }
});

// GET /associados/:id/comunicados — histórico de comunicados enviados a
// esse associado específico, com status de leitura (item de sprint 2.3).
// Mesma regra de visibilidade que o associado teria no portal dele (só
// comunicados 'ativo' já publicados — ver routes/comunicados.js).
router.get('/:id/comunicados', autorizar('admin', 'diretoria'), async (req, res) => {
    const { id } = req.params;
    const { lido } = req.query; // 'lidos' | 'nao_lidos' | ausente (todos)
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const associado = await client.query(
            `SELECT usuario_id FROM associados WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (associado.rows.length === 0) {
            return res.status(404).json({ erro: 'Associado não encontrado' });
        }

        const condicoes = [`c.associacao_id = $1`, `c.status = 'ativo'`, `c.publicado_em <= now()`];
        if (lido === 'lidos') condicoes.push(`cl.id IS NOT NULL`);
        if (lido === 'nao_lidos') condicoes.push(`cl.id IS NULL`);

        const resultado = await client.query(
            `SELECT c.id, c.titulo, c.publicado_em, cl.criado_em AS lido_em, (cl.id IS NOT NULL) AS lido
             FROM comunicados c
             LEFT JOIN comunicado_leituras cl ON cl.comunicado_id = c.id AND cl.usuario_id = $2
             WHERE ${condicoes.join(' AND ')}
             ORDER BY c.publicado_em DESC`,
            [req.usuario.associacao_id, associado.rows[0].usuario_id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar comunicados do associado' });
    } finally {
        client.release();
    }
});

// DELETE /associados/:id — remove um associado e suas cobranças (só admin)
router.delete('/:id', autorizar('admin'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `DELETE FROM associados WHERE id = $1 AND associacao_id = $2 RETURNING id, nome_completo, cpf`,
            [id, req.usuario.associacao_id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Associado não encontrado' });
        }
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'associados', tipoAcao: 'exclusao',
            descricao: req.usuario.nome + ' excluiu o associado ' + resultado.rows[0].nome_completo,
            dadosAnteriores: resultado.rows[0], req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir associado' });
    } finally {
        client.release();
    }
});

module.exports = router;
