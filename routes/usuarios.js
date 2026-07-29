// routes/usuarios.js
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { autenticar, bloquearSenhaProvisoria, bloquearTrialExpirado, autorizar, comConexaoTenant } = require('../middleware/auth');
const { emailValido, nomeValido, gerarSenhaProvisoria } = require('../utils/validacao');
const { planoAtendeNivel } = require('../utils/precos');

// Perfis de acesso granulares (item 5 do backlog, 28/07/2026) são
// diferencial do plano Intermediário+ na landing page (29/07/2026) --
// gating por plano, com grandfathering: só bloqueia ATRIBUIR um desses
// papéis agora (criar ou editar); usuário que já tinha um desses papéis
// antes de a associação estar num plano que não permite continua
// funcionando normalmente (a checagem não roda em cima de dado existente,
// só na hora de gravar um valor novo).
const PAPEIS_GRANULARES = ['financeiro', 'atendimento', 'operador', 'consulta'];
const { registrarEventoAuth } = require('../utils/authLog');
const { registrarAtividade } = require('../utils/atividadeLog');
const { registrarLogAuditoria } = require('../utils/auditoria');

const router = express.Router();
router.use(autenticar);
router.use(bloquearSenhaProvisoria);
router.use(bloquearTrialExpirado);

// GET /usuarios — lista os usuários da associação (só admin)
router.get('/', autorizar('admin'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT u.id, u.nome, u.email, u.papel, u.ativo, u.criado_em,
                    (SELECT MAX(l.criado_em) FROM auth_logs l
                      WHERE l.usuario_id = u.id AND l.evento = 'login_sucesso') AS ultimo_acesso
             FROM usuarios u
             WHERE u.associacao_id = $1
             ORDER BY u.criado_em`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar usuários' });
    } finally {
        client.release();
    }
});

// POST /usuarios — convida/cria um novo usuário na mesma associação (só admin).
// A senha é sempre gerada automaticamente e devolvida uma única vez nesta
// resposta — o convidado troca por uma senha própria no primeiro login.
router.post('/', autorizar('admin'), async (req, res) => {
    const { nome, email, papel, associado_id } = req.body;

    if (!nome || !email || !papel) {
        return res.status(400).json({ erro: 'nome, email e papel são obrigatórios' });
    }
    if (!nomeValido(nome)) {
        return res.status(400).json({ erro: 'nome inválido (máximo 120 caracteres, sem caracteres de controle)' });
    }
    if (!emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail inválido' });
    }
    if (!['diretoria', 'financeiro', 'atendimento', 'operador', 'consulta', 'associado'].includes(papel)) {
        return res.status(400).json({ erro: 'papel inválido' });
    }
    if (papel === 'associado' && !associado_id) {
        return res.status(400).json({ erro: 'associado_id é obrigatório para o papel "associado"' });
    }
    if (PAPEIS_GRANULARES.includes(papel) && !planoAtendeNivel(req.usuario.plano, 'intermediario')) {
        return res.status(403).json({
            erro: 'Perfis de acesso granulares (Financeiro, Atendimento, Operador, Somente Consulta) exigem o plano Intermediário ou superior.',
            codigo: 'PLANO_INSUFICIENTE',
            plano_necessario: 'intermediario',
        });
    }

    // Gerado/hasheado antes de pegar a conexão -- ver mesmo comentário em
    // routes/associados.js (POST /).
    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        await client.query('BEGIN');

        const resultado = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel, deve_trocar_senha)
             VALUES ($1, $2, $3, $4, $5, true)
             RETURNING id, nome, email, papel, ativo, criado_em`,
            [req.usuario.associacao_id, nome.trim(), email, senhaHash, papel]
        );
        const novoUsuario = resultado.rows[0];

        if (papel === 'associado') {
            const vinculo = await client.query(
                `UPDATE associados SET usuario_id = $1 WHERE id = $2 AND usuario_id IS NULL AND associacao_id = $3 RETURNING id`,
                [novoUsuario.id, associado_id, req.usuario.associacao_id]
            );
            if (vinculo.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ erro: 'Esse associado não existe ou já tem um login vinculado' });
            }
        }

        await registrarEventoAuth(client, {
            usuarioId: novoUsuario.id,
            associacaoId: req.usuario.associacao_id,
            emailTentado: email,
            evento: 'senha_provisoria_criada',
            req,
        });

        await registrarAtividade(client, {
            associacaoId: req.usuario.associacao_id,
            usuarioId: req.usuario.id,
            usuarioNome: req.usuario.nome,
            tipo: 'usuario_convidado',
            descricao: 'convidou ' + novoUsuario.nome + ' como ' + papel,
        });
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'usuarios', tipoAcao: 'criacao',
            descricao: req.usuario.nome + ' convidou ' + novoUsuario.nome + ' como ' + papel,
            dadosNovos: novoUsuario, req,
        });

        await client.query('COMMIT');
        res.status(201).json({ ...novoUsuario, senha_provisoria: senhaProvisoria });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail na plataforma' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar usuário' });
    } finally {
        client.release();
    }
});

// GET /usuarios/associados-sem-login — lista associados que ainda não têm usuário vinculado (só admin)
router.get('/associados-sem-login', autorizar('admin'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT id, nome_completo FROM associados WHERE usuario_id IS NULL AND associacao_id = $1 ORDER BY nome_completo`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar associados sem login' });
    } finally {
        client.release();
    }
});

// GET /usuarios/logs-autenticacao — histórico de eventos de autenticação da
// associação (login, logout, troca/redefinição de senha), mais recente primeiro
router.get('/logs-autenticacao', autorizar('admin'), async (req, res) => {
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `SELECT l.id, l.evento, l.email_tentado, l.ip, l.criado_em, u.nome AS usuario_nome
             FROM auth_logs l
             LEFT JOIN usuarios u ON u.id = l.usuario_id
             WHERE l.associacao_id = $1
             ORDER BY l.criado_em DESC
             LIMIT 200`,
            [req.usuario.associacao_id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar logs de autenticação' });
    } finally {
        client.release();
    }
});

// POST /usuarios/:id/gerar-link-redefinicao — admin gera um link de redefinição
// de senha para outro usuário da mesma associação (correção da vulnerabilidade
// que permitia qualquer pessoa gerar esse link só com e-mail + associacao_id)
router.post('/:id/gerar-link-redefinicao', autorizar('admin'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const usuario = await client.query(
            `SELECT id FROM usuarios WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (usuario.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }

        const tokenBruto = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(tokenBruto).digest('hex');
        const expiraEm = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

        await client.query(
            `INSERT INTO password_resets (usuario_id, token_hash, expira_em) VALUES ($1, $2, $3)`,
            [id, tokenHash, expiraEm]
        );

        res.json({ ok: true, token: tokenBruto });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao gerar link de redefinição' });
    } finally {
        client.release();
    }
});

// PATCH /usuarios/:id/desativar — desativa um usuário (só admin, não pode desativar a si mesmo)
router.patch('/:id/desativar', autorizar('admin'), async (req, res) => {
    const { id } = req.params;

    if (id === req.usuario.id) {
        return res.status(400).json({ erro: 'Você não pode desativar seu próprio usuário' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `UPDATE usuarios SET ativo = false WHERE id = $1 AND associacao_id = $2 RETURNING id, nome`,
            [id, req.usuario.associacao_id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'usuarios', tipoAcao: 'edicao',
            descricao: req.usuario.nome + ' desativou o usuário ' + resultado.rows[0].nome,
            dadosAnteriores: { ativo: true }, dadosNovos: { ativo: false }, req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao desativar usuário' });
    } finally {
        client.release();
    }
});

// PATCH /usuarios/:id/reativar — reativa um usuário desativado (só admin)
router.patch('/:id/reativar', autorizar('admin'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `UPDATE usuarios SET ativo = true WHERE id = $1 AND associacao_id = $2 RETURNING id, nome`,
            [id, req.usuario.associacao_id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'usuarios', tipoAcao: 'edicao',
            descricao: req.usuario.nome + ' reativou o usuário ' + resultado.rows[0].nome,
            dadosAnteriores: { ativo: false }, dadosNovos: { ativo: true }, req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao reativar usuário' });
    } finally {
        client.release();
    }
});

// PATCH /usuarios/:id/redefinir-senha — admin gera uma senha provisória nova
// pra outro usuário da associação (mesmo padrão de "credenciais geradas" já
// usado em POST /associados e PATCH .../resetar-senha-admin do superadmin --
// mais direto que o link por e-mail de POST /:id/gerar-link-redefinicao, que
// não tem consumidor no front hoje).
router.patch('/:id/redefinir-senha', autorizar('admin'), async (req, res) => {
    const { id } = req.params;

    // Gerado/hasheado fora da conexão do pool -- ver comentário equivalente
    // em routes/associados.js (POST /).
    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = true, senha_alterada_em = now()
             WHERE id = $2 AND associacao_id = $3 RETURNING id, nome, email`,
            [senhaHash, id, req.usuario.associacao_id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'usuarios', tipoAcao: 'alteracao_senha',
            descricao: req.usuario.nome + ' gerou uma senha provisória nova para ' + resultado.rows[0].nome,
            req,
        });
        res.json({ ...resultado.rows[0], senha_provisoria: senhaProvisoria });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao redefinir senha' });
    } finally {
        client.release();
    }
});

// PUT /usuarios/:id — edita nome e papel de um usuário (só admin, não pode alterar o próprio papel)
router.put('/:id', autorizar('admin'), async (req, res) => {
    const { id } = req.params;
    const { nome, papel } = req.body;

    if (!nome || !nome.trim()) {
        return res.status(400).json({ erro: 'nome é obrigatório' });
    }
    if (!nomeValido(nome)) {
        return res.status(400).json({ erro: 'nome inválido (máximo 120 caracteres, sem caracteres de controle)' });
    }
    if (papel && !['admin', 'diretoria', 'financeiro', 'atendimento', 'operador', 'consulta', 'associado'].includes(papel)) {
        return res.status(400).json({ erro: 'papel inválido' });
    }
    if (id === req.usuario.id && papel && papel !== 'admin') {
        return res.status(400).json({ erro: 'Você não pode alterar o seu próprio papel' });
    }
    // Gating por plano só quando um papel NOVO está sendo atribuído (ver
    // PAPEIS_GRANULARES acima) -- editar só o nome (papel undefined) nunca
    // passa por aqui, então um usuário já cadastrado num papel granular
    // continua com o papel intacto mesmo se a associação estiver num plano
    // que não permitiria atribuí-lo agora.
    if (papel && PAPEIS_GRANULARES.includes(papel) && !planoAtendeNivel(req.usuario.plano, 'intermediario')) {
        return res.status(403).json({
            erro: 'Perfis de acesso granulares (Financeiro, Atendimento, Operador, Somente Consulta) exigem o plano Intermediário ou superior.',
            codigo: 'PLANO_INSUFICIENTE',
            plano_necessario: 'intermediario',
        });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const anterior = await client.query(
            `SELECT id, nome, papel FROM usuarios WHERE id = $1 AND associacao_id = $2`,
            [id, req.usuario.associacao_id]
        );
        if (anterior.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }

        const resultado = await client.query(
            `UPDATE usuarios SET nome = $1, papel = COALESCE($2, papel)
             WHERE id = $3 AND associacao_id = $4
             RETURNING id, nome, email, papel, ativo, criado_em`,
            [nome.trim(), papel || null, id, req.usuario.associacao_id]
        );

        const mudouPapel = papel && papel !== anterior.rows[0].papel;
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'usuarios', tipoAcao: mudouPapel ? 'alteracao_permissoes' : 'edicao',
            descricao: req.usuario.nome + ' editou o usuário ' + resultado.rows[0].nome,
            dadosAnteriores: anterior.rows[0], dadosNovos: resultado.rows[0], req,
        });

        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar usuário' });
    } finally {
        client.release();
    }
});

// DELETE /usuarios/:id — remove permanentemente um usuário (só admin, não pode remover a si mesmo)
router.delete('/:id', autorizar('admin'), async (req, res) => {
    const { id } = req.params;

    if (id === req.usuario.id) {
        return res.status(400).json({ erro: 'Você não pode excluir seu próprio usuário' });
    }

    const client = await comConexaoTenant(req.usuario.associacao_id);
    try {
        const resultado = await client.query(
            `DELETE FROM usuarios WHERE id = $1 AND associacao_id = $2 RETURNING id, nome, email, papel`,
            [id, req.usuario.associacao_id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Usuário não encontrado' });
        }
        await registrarLogAuditoria(client, {
            associacaoId: req.usuario.associacao_id, usuarioId: req.usuario.id, usuarioNome: req.usuario.nome, usuarioEmail: req.usuario.email,
            modulo: 'usuarios', tipoAcao: 'exclusao',
            descricao: req.usuario.nome + ' excluiu o usuário ' + resultado.rows[0].nome,
            dadosAnteriores: resultado.rows[0], req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir usuário' });
    } finally {
        client.release();
    }
});

module.exports = router;
