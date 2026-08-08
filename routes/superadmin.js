// routes/superadmin.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const config = require('../config/env');
const { autenticarSuperAdmin, autorizarSuperAdmin, comConexaoSuperAdmin } = require('../middleware/auth');
const { limiteLogin } = require('../middleware/rateLimiter');
const { emailValido, gerarSenhaProvisoria, cpfValido, senhaForte, imagemBase64Valida, inteiroPositivo } = require('../utils/validacao');
const { registrarEventoAuth } = require('../utils/authLog');
const { registrarLogAuditoria } = require('../utils/auditoria');
const { calcularValorMensalidade, statusAssinatura } = require('../utils/precos');
const { gerarPdfLogs } = require('../utils/exportarLogs');

const FORMAS_COBRANCA_VALIDAS = ['pix', 'boleto', 'cartao', 'dinheiro', 'outro'];
// Opções fechadas (não é um intervalo livre) -- pedido explícito do item de
// sprint 1.4, pra manter o dropdown do formulário previsível.
const DIAS_ALERTA_ASSINATURA_VALIDOS = [30, 20, 15, 10, 7, 3];
const PAPEIS_SUPERADMIN_VALIDOS = ['super_admin', 'administrador', 'suporte'];

// Modelo de permissão dos níveis da plataforma (menor privilégio):
//
//   super_admin   -- tudo, inclusive o que é irreversível ou dá acesso à conta
//                    de um cliente (excluir associação, gerenciar admins,
//                    configurar o Pix de recebimento da plataforma).
//   administrador -- operação do dia a dia: cadastra/edita associação, aprova
//                    contratação, exporta relatório. NÃO exclui associação.
//   suporte       -- diagnóstico: enxerga tudo (dashboard, associações, logs),
//                    mas não altera nada nem baixa dados em massa.
//
// Antes disso, só /admins e /configuracoes-plataforma checavam o nível -- na
// prática 'suporte' conseguia excluir uma associação inteira (com todos os
// associados/cobranças/comunicados, em cascata) e redefinir a senha do admin
// de qualquer cliente, recebendo a senha nova na resposta.
const GESTAO = ['super_admin', 'administrador'];

const paramUuid = require('../middleware/paramUuid');
const router = express.Router();
// Rejeita :id que nao seja uuid com 400, em vez de deixar virar 500 no Postgres
router.param('id', paramUuid);
const JWT_SECRET = config.jwtSecret;

// Compara em tempo constante para não vazar, por timing, quantos caracteres
// do segredo o chamador acertou.
function segredoValido(recebido, esperado) {
    if (!recebido || !esperado) return false;
    const bufRecebido = Buffer.from(recebido);
    const bufEsperado = Buffer.from(esperado);
    if (bufRecebido.length !== bufEsperado.length) return false;
    return crypto.timingSafeEqual(bufRecebido, bufEsperado);
}

// POST /superadmin/bootstrap
// Cria o PRIMEIRO super-admin. Além de só funcionar se ainda não existir
// nenhum (autodesabilita depois do primeiro uso), exige o segredo de setup
// definido em BOOTSTRAP_SECRET — sem isso, quem descobrisse essa rota antes
// de você rodar o bootstrap se tornaria dono da plataforma inteira.
// super_admins não tem RLS, então pool.query direto é seguro aqui.
router.post('/bootstrap', async (req, res) => {
    const { nome, email, senha, bootstrap_secret } = req.body;

    if (!segredoValido(bootstrap_secret, config.bootstrapSecret)) {
        return res.status(403).json({ erro: 'Segredo de bootstrap inválido ou não configurado' });
    }
    if (!nome || !email || !senha) {
        return res.status(400).json({ erro: 'nome, email e senha são obrigatórios' });
    }
    if (!emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail inválido' });
    }
    if (senha.length < 6) {
        return res.status(400).json({ erro: 'senha deve ter ao menos 6 caracteres' });
    }

    try {
        const existentes = await pool.query(`SELECT id FROM super_admins LIMIT 1`);
        if (existentes.rows.length > 0) {
            return res.status(403).json({ erro: 'Já existe um super-admin cadastrado. Use /superadmin/login.' });
        }

        const senhaHash = await bcrypt.hash(senha, 10);
        const resultado = await pool.query(
            `INSERT INTO super_admins (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id, nome, email`,
            [nome, email, senhaHash]
        );
        res.status(201).json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar super-admin' });
    }
});

// POST /superadmin/login
router.post('/login', limiteLogin, async (req, res) => {
    const { email, senha } = req.body;

    if (!email || !senha) {
        return res.status(400).json({ erro: 'email e senha são obrigatórios' });
    }

    try {
        const resultado = await pool.query(
            `SELECT id, nome, email, senha_hash, papel, ativo, deve_trocar_senha FROM super_admins WHERE email = $1`,
            [email]
        );
        const admin = resultado.rows[0];
        if (!admin || !admin.ativo) {
            await registrarLogAuditoria(pool, {
                superAdminEmail: email, modulo: 'autenticacao', tipoAcao: 'login',
                descricao: 'tentativa de login de super-admin falhou para ' + email, req,
            });
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }

        const senhaCorreta = await bcrypt.compare(senha, admin.senha_hash);
        if (!senhaCorreta) {
            await registrarLogAuditoria(pool, {
                superAdminId: admin.id, superAdminNome: admin.nome, superAdminEmail: admin.email,
                modulo: 'autenticacao', tipoAcao: 'login',
                descricao: 'tentativa de login com senha incorreta para ' + admin.nome, req,
            });
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }

        const token = jwt.sign(
            { id: admin.id, email: admin.email, tipo: 'superadmin' },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        await registrarLogAuditoria(pool, {
            superAdminId: admin.id, superAdminNome: admin.nome, superAdminEmail: admin.email,
            modulo: 'autenticacao', tipoAcao: 'login',
            descricao: admin.nome + ' (super-admin) realizou login', req,
        });

        res.json({
            token,
            id: admin.id,
            nome: admin.nome,
            papel: admin.papel,
            deve_trocar_senha: admin.deve_trocar_senha,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao autenticar' });
    }
});

// A partir daqui, todas as rotas exigem token de super-admin
router.use(autenticarSuperAdmin);

// ---------- Gerenciamento de administradores da plataforma ----------
// Restrito a quem tem papel 'super_admin' -- administrador/suporte são
// níveis mais baixos, preparados para restrições futuras.

// GET /superadmin/admins — lista os administradores da plataforma
router.get('/admins', autorizarSuperAdmin('super_admin'), async (req, res) => {
    try {
        const limite = inteiroPositivo(req.query.limite, 100, 1000);
        const resultado = await pool.query(
            `SELECT id, nome, email, papel, ativo, criado_em FROM super_admins ORDER BY criado_em DESC LIMIT $1`,
            [limite]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar administradores' });
    }
});

// POST /superadmin/admins — cria um novo administrador da plataforma, com
// senha provisória (mesmo padrão de usuarios/associações: exibida uma única
// vez, troca obrigatória no primeiro login).
router.post('/admins', autorizarSuperAdmin('super_admin'), async (req, res) => {
    const { nome, email, papel } = req.body;

    if (!nome || !nome.trim() || !email) {
        return res.status(400).json({ erro: 'nome e email são obrigatórios' });
    }
    if (!emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail inválido' });
    }
    if (papel && !PAPEIS_SUPERADMIN_VALIDOS.includes(papel)) {
        return res.status(400).json({ erro: 'papel inválido' });
    }

    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    try {
        const resultado = await pool.query(
            `INSERT INTO super_admins (nome, email, senha_hash, papel, deve_trocar_senha)
             VALUES ($1, $2, $3, $4, true) RETURNING id, nome, email, papel, ativo, criado_em`,
            [nome.trim(), email, senhaHash, papel || 'administrador']
        );
        await registrarLogAuditoria(pool, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'administradores', tipoAcao: 'criacao',
            descricao: req.superAdmin.nome + ' criou o administrador ' + resultado.rows[0].nome + ' (' + resultado.rows[0].papel + ')',
            dadosNovos: resultado.rows[0], req,
        });
        res.status(201).json({ admin: resultado.rows[0], senha_provisoria: senhaProvisoria });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'Já existe um administrador com esse e-mail' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar administrador' });
    }
});

// PUT /superadmin/admins/:id — edita nome/e-mail/papel de um administrador
router.put('/admins/:id', autorizarSuperAdmin('super_admin'), async (req, res) => {
    const { id } = req.params;
    const { nome, email, papel } = req.body;

    if (!nome || !nome.trim()) {
        return res.status(400).json({ erro: 'nome é obrigatório' });
    }
    if (email && !emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail inválido' });
    }
    if (papel && !PAPEIS_SUPERADMIN_VALIDOS.includes(papel)) {
        return res.status(400).json({ erro: 'papel inválido' });
    }
    if (papel && id === req.superAdmin.id && papel !== req.superAdmin.papel) {
        return res.status(400).json({ erro: 'Não é possível alterar o próprio nível de permissão' });
    }

    try {
        const anterior = await pool.query(`SELECT id, nome, email, papel FROM super_admins WHERE id = $1`, [id]);
        if (anterior.rows.length === 0) {
            return res.status(404).json({ erro: 'Administrador não encontrado' });
        }

        const resultado = await pool.query(
            `UPDATE super_admins SET nome = $1, email = COALESCE($2, email), papel = COALESCE($3, papel)
             WHERE id = $4 RETURNING id, nome, email, papel, ativo, criado_em`,
            [nome.trim(), email || null, papel || null, id]
        );

        const mudouPapel = papel && papel !== anterior.rows[0].papel;
        await registrarLogAuditoria(pool, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'administradores', tipoAcao: mudouPapel ? 'alteracao_permissoes' : 'edicao',
            descricao: req.superAdmin.nome + ' editou o administrador ' + resultado.rows[0].nome,
            dadosAnteriores: anterior.rows[0], dadosNovos: resultado.rows[0], req,
        });

        res.json(resultado.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'E-mail já cadastrado para outro administrador' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar administrador' });
    }
});

// PATCH /superadmin/admins/:id/status — ativa/desativa um administrador.
// Bloqueia desativar a própria conta e desativar o último super_admin ativo
// (evitaria travar o acesso administrativo da plataforma inteira).
router.patch('/admins/:id/status', autorizarSuperAdmin('super_admin'), async (req, res) => {
    const { id } = req.params;
    const { ativo } = req.body;

    if (typeof ativo !== 'boolean') {
        return res.status(400).json({ erro: 'ativo (boolean) é obrigatório' });
    }
    if (id === req.superAdmin.id && !ativo) {
        return res.status(400).json({ erro: 'Não é possível desativar sua própria conta' });
    }

    try {
        if (!ativo) {
            const alvo = await pool.query(`SELECT papel FROM super_admins WHERE id = $1`, [id]);
            if (alvo.rows.length === 0) {
                return res.status(404).json({ erro: 'Administrador não encontrado' });
            }
            if (alvo.rows[0].papel === 'super_admin') {
                const restantes = await pool.query(
                    `SELECT COUNT(*) AS total FROM super_admins WHERE papel = 'super_admin' AND ativo = true AND id != $1`,
                    [id]
                );
                if (parseInt(restantes.rows[0].total, 10) === 0) {
                    return res.status(400).json({ erro: 'Não é possível desativar o único super-admin ativo da plataforma' });
                }
            }
        }

        const resultado = await pool.query(
            `UPDATE super_admins SET ativo = $1 WHERE id = $2 RETURNING id, nome, email, papel, ativo`,
            [ativo, id]
        );
        await registrarLogAuditoria(pool, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'administradores', tipoAcao: 'edicao',
            descricao: req.superAdmin.nome + ' ' + (ativo ? 'ativou' : 'desativou') + ' o administrador ' + resultado.rows[0].nome,
            dadosAnteriores: { ativo: !ativo }, dadosNovos: { ativo }, req,
        });
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao alterar status do administrador' });
    }
});

// PATCH /superadmin/admins/:id/senha — redefine a senha de outro administrador
// (senha provisória gerada, exibida uma única vez, troca obrigatória no
// próximo login -- mesmo padrão de resetar-senha-admin de associações)
router.patch('/admins/:id/senha', autorizarSuperAdmin('super_admin'), async (req, res) => {
    const { id } = req.params;
    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    try {
        const resultado = await pool.query(
            `UPDATE super_admins SET senha_hash = $1, deve_trocar_senha = true, senha_alterada_em = now() WHERE id = $2 RETURNING id, nome, email`,
            [senhaHash, id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Administrador não encontrado' });
        }
        await registrarLogAuditoria(pool, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'administradores', tipoAcao: 'alteracao_senha',
            descricao: req.superAdmin.nome + ' redefiniu a senha do administrador ' + resultado.rows[0].nome,
            req,
        });
        res.json({ ok: true, email: resultado.rows[0].email, senha_provisoria: senhaProvisoria });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao redefinir senha' });
    }
});

// PUT /superadmin/perfil/senha — o próprio administrador troca sua senha
// (qualquer nível de permissão pode usar essa rota para si mesmo)
router.put('/perfil/senha', async (req, res) => {
    const { senha_atual, senha_nova } = req.body;

    if (!senha_atual || !senha_nova) {
        return res.status(400).json({ erro: 'senha_atual e senha_nova são obrigatórios' });
    }
    if (!senhaForte(senha_nova)) {
        return res.status(400).json({ erro: 'A nova senha deve ter ao menos 8 caracteres, com letra maiúscula, minúscula e número' });
    }

    try {
        const resultado = await pool.query(`SELECT senha_hash FROM super_admins WHERE id = $1`, [req.superAdmin.id]);
        const admin = resultado.rows[0];
        if (!admin) {
            return res.status(404).json({ erro: 'Administrador não encontrado' });
        }

        const senhaCorreta = await bcrypt.compare(senha_atual, admin.senha_hash);
        if (!senhaCorreta) {
            return res.status(401).json({ erro: 'Senha atual incorreta' });
        }

        const novoHash = await bcrypt.hash(senha_nova, 10);
        await pool.query(
            `UPDATE super_admins SET senha_hash = $1, deve_trocar_senha = false, senha_alterada_em = now() WHERE id = $2`,
            [novoHash, req.superAdmin.id]
        );
        await registrarLogAuditoria(pool, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'administradores', tipoAcao: 'alteracao_senha',
            descricao: req.superAdmin.nome + ' alterou a própria senha', req,
        });

        // Reemite o token -- o antigo acabou de virar inválido (ver
        // senha_alterada_em em middleware/auth.js), senão a própria pessoa
        // ficaria "deslogada" na próxima ação sem nenhum aviso.
        const novoToken = jwt.sign(
            { id: req.superAdmin.id, email: req.superAdmin.email, tipo: 'superadmin' },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({ ok: true, token: novoToken });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao trocar senha' });
    }
});

// GET /superadmin/associacoes — lista todas as associações com contadores agregados e filtros
// Toca associados/cobrancas (têm RLS) -> usa conexão de bypass do super-admin
router.get('/associacoes', async (req, res) => {
    const { busca, cidade, estado, plano, status, limite } = req.query;
    const client = await comConexaoSuperAdmin();
    try {
        const condicoes = [];
        const valores = [];

        if (busca) {
            valores.push('%' + busca + '%');
            condicoes.push(`a.nome ILIKE $${valores.length}`);
        }
        if (cidade) {
            valores.push('%' + cidade + '%');
            condicoes.push(`a.cidade ILIKE $${valores.length}`);
        }
        if (estado) {
            valores.push(estado);
            condicoes.push(`a.estado = $${valores.length}`);
        }
        if (plano) {
            valores.push(plano);
            condicoes.push(`a.plano = $${valores.length}`);
        }
        if (status === 'ativo') condicoes.push(`a.ativo = true`);
        if (status === 'inativo') condicoes.push(`a.ativo = false`);

        const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
        const limiteSql = limite ? `LIMIT ${inteiroPositivo(limite, 100, 1000)}` : '';

        const resultado = await client.query(`
            SELECT a.id, a.nome, a.tipo, a.email, a.telefone, a.endereco, a.cidade, a.estado, a.cep, a.site, a.cnpj,
                   a.plano, a.ativo, a.criado_em, a.valor_mensalidade_manual, a.vencimento_assinatura,
                   a.forma_cobranca, a.dias_alerta_vencimento,
                   (SELECT nome FROM usuarios u WHERE u.associacao_id = a.id AND u.papel = 'admin' LIMIT 1) AS responsavel_nome,
                   (SELECT COUNT(*) FROM associados ass WHERE ass.associacao_id = a.id) AS total_associados,
                   (SELECT COUNT(*) FROM cobrancas c WHERE c.associacao_id = a.id AND c.status = 'pendente') AS cobrancas_pendentes,
                   (SELECT COUNT(*) FROM cobrancas c WHERE c.associacao_id = a.id AND c.status = 'pendente' AND c.vencimento < CURRENT_DATE) AS cobrancas_atrasadas
            FROM associacoes a
            ${where}
            ORDER BY a.criado_em DESC
            ${limiteSql}
        `, valores);

        const hoje = new Date();
        const linhas = resultado.rows.map((a) => ({
            ...a,
            total_associados: parseInt(a.total_associados, 10),
            valor_mensalidade: calcularValorMensalidade(a.plano, parseInt(a.total_associados, 10), a.valor_mensalidade_manual),
            status_assinatura: statusAssinatura(a, hoje),
        }));

        res.json(linhas);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar associações' });
    } finally {
        client.release();
    }
});

// GET /superadmin/associacoes/:id — detalhe completo de uma associação
router.get('/associacoes/:id', async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoSuperAdmin();
    try {
        const associacao = await client.query(`SELECT * FROM associacoes WHERE id = $1`, [id]);
        if (associacao.rows.length === 0) {
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }

        const admin = await client.query(
            `SELECT id, nome, email, cpf, ativo, criado_em FROM usuarios WHERE associacao_id = $1 AND papel = 'admin' LIMIT 1`,
            [id]
        );

        const financeiro = await client.query(`
            SELECT
                (SELECT COALESCE(SUM(p.valor_pago), 0) FROM pagamentos p
                   JOIN cobrancas c ON c.id = p.cobranca_id WHERE c.associacao_id = $1) AS total_recebido,
                (SELECT COALESCE(SUM(valor), 0) FROM cobrancas WHERE associacao_id = $1 AND status = 'pendente') AS total_a_receber,
                (SELECT MIN(vencimento) FROM cobrancas WHERE associacao_id = $1 AND status = 'pendente') AS proximo_vencimento
        `, [id]);

        const totalAssociados = await client.query(`SELECT COUNT(*) AS total FROM associados WHERE associacao_id = $1`, [id]);
        const dadosAssociacao = associacao.rows[0];
        const qtdAssociados = parseInt(totalAssociados.rows[0].total, 10);

        res.json({
            ...dadosAssociacao,
            total_associados: qtdAssociados,
            valor_mensalidade: calcularValorMensalidade(dadosAssociacao.plano, qtdAssociados, dadosAssociacao.valor_mensalidade_manual),
            status_assinatura: statusAssinatura(dadosAssociacao, new Date()),
            admin: admin.rows[0] || null,
            financeiro: financeiro.rows[0]
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar detalhes da associação' });
    } finally {
        client.release();
    }
});

// GET /superadmin/associacoes/:id/associados — lista só-leitura dos associados dessa associação
router.get('/associacoes/:id/associados', async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `SELECT id, nome_completo, cpf, telefone, categoria, status, data_ingresso
             FROM associados WHERE associacao_id = $1 ORDER BY nome_completo`,
            [id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar associados' });
    } finally {
        client.release();
    }
});

// GET /superadmin/associacoes/:id/cobrancas — lista só-leitura das cobranças dessa associação
router.get('/associacoes/:id/cobrancas', async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `SELECT c.id, c.descricao, c.valor, c.vencimento, c.status, a.nome_completo AS associado_nome
             FROM cobrancas c JOIN associados a ON a.id = c.associado_id
             WHERE c.associacao_id = $1 ORDER BY c.vencimento DESC LIMIT 200`,
            [id]
        );
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar cobranças' });
    } finally {
        client.release();
    }
});

// PATCH /superadmin/associacoes/:id/resetar-senha-admin — gera uma nova senha
// provisória para o admin da associação (mesmo padrão das outras contas:
// senha aleatória, exibida uma única vez, troca obrigatória no próximo login)
router.patch('/associacoes/:id/resetar-senha-admin', autorizarSuperAdmin(...GESTAO), async (req, res) => {
    const { id } = req.params;

    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = true, senha_alterada_em = now()
             WHERE associacao_id = $2 AND papel = 'admin'
             RETURNING id, email`,
            [senhaHash, id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Admin dessa associação não encontrado' });
        }

        await registrarEventoAuth(client, {
            usuarioId: resultado.rows[0].id,
            associacaoId: id,
            emailTentado: resultado.rows[0].email,
            evento: 'senha_provisoria_criada',
            req,
        });
        await registrarLogAuditoria(client, {
            associacaoId: id, superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'associacoes', tipoAcao: 'alteracao_senha',
            descricao: req.superAdmin.nome + ' redefiniu a senha do admin da associação',
            req,
        });

        res.json({ ok: true, email: resultado.rows[0].email, senha_provisoria: senhaProvisoria });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao redefinir senha' });
    } finally {
        client.release();
    }
});

// GET /superadmin/dashboard — KPIs agregados de toda a plataforma
router.get('/dashboard', async (req, res) => {
    const client = await comConexaoSuperAdmin();
    try {
        const kpis = await client.query(`
            SELECT
                (SELECT COUNT(*) FROM associacoes) AS total_associacoes,
                (SELECT COUNT(*) FROM associacoes WHERE ativo = true) AS associacoes_ativas,
                (SELECT COUNT(*) FROM associacoes WHERE ativo = false) AS associacoes_bloqueadas,
                (SELECT COUNT(*) FROM associados) AS total_associados,
                (SELECT COUNT(*) FROM cobrancas WHERE status = 'pendente') AS total_pendentes,
                (SELECT COUNT(*) FROM cobrancas WHERE status = 'pendente' AND vencimento < CURRENT_DATE) AS total_atrasadas,
                (SELECT COUNT(*) FROM cobrancas WHERE status = 'aguardando_confirmacao') AS total_aguardando_confirmacao,
                (SELECT COALESCE(SUM(p.valor_pago), 0) FROM pagamentos p WHERE p.pago_em >= date_trunc('month', now())) AS receita_mensal
        `);

        const crescimentoAssociacoes = await client.query(`
            SELECT to_char(mes, 'YYYY-MM') AS mes, COUNT(a.id) AS total
            FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS mes
            LEFT JOIN associacoes a ON date_trunc('month', a.criado_em) = mes
            GROUP BY mes ORDER BY mes
        `);

        const novosAssociados = await client.query(`
            SELECT to_char(mes, 'YYYY-MM') AS mes, COUNT(ass.id) AS total
            FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS mes
            LEFT JOIN associados ass ON date_trunc('month', ass.criado_em) = mes
            GROUP BY mes ORDER BY mes
        `);

        // Receita efetivamente recebida por mês (pagamentos.valor_pago), não a
        // projeção de MRR — não há como reconstruir a contagem histórica de
        // associados por associação pra recalcular o MRR de meses passados.
        const receitaHistorico = await client.query(`
            SELECT to_char(mes, 'YYYY-MM') AS mes, COALESCE(SUM(p.valor_pago), 0) AS total
            FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS mes
            LEFT JOIN pagamentos p ON date_trunc('month', p.pago_em) = mes
            GROUP BY mes ORDER BY mes
        `);

        const distribuicaoPlanos = await client.query(`
            SELECT plano, COUNT(*) AS total FROM associacoes GROUP BY plano ORDER BY plano
        `);

        const ultimasAssociacoes = await client.query(`
            SELECT id, nome, cidade, estado, plano, ativo, criado_em
            FROM associacoes ORDER BY criado_em DESC LIMIT 5
        `);

        // MRR calculado: soma de calcularValorMensalidade() de cada associação
        // ativa, usando a contagem real de associados de cada uma.
        const associacoesAtivas = await client.query(`
            SELECT a.plano, a.valor_mensalidade_manual,
                   (SELECT COUNT(*) FROM associados ass WHERE ass.associacao_id = a.id) AS total_associados
            FROM associacoes a WHERE a.ativo = true
        `);
        const mrr = associacoesAtivas.rows.reduce((soma, a) => {
            return soma + calcularValorMensalidade(a.plano, parseInt(a.total_associados, 10), a.valor_mensalidade_manual);
        }, 0);

        // Alertas: assinaturas vencidas/vencendo (janela por associação via
        // dias_alerta_vencimento) e associações novas nos últimos 7 dias.
        const assinaturasAtencao = await client.query(`
            SELECT nome, vencimento_assinatura,
                   (vencimento_assinatura < CURRENT_DATE) AS vencida
            FROM associacoes
            WHERE ativo = true AND plano != 'trial' AND vencimento_assinatura IS NOT NULL
              AND vencimento_assinatura <= CURRENT_DATE + (dias_alerta_vencimento || ' days')::interval
            ORDER BY vencimento_assinatura ASC LIMIT 10
        `);
        const associacoesNovas = await client.query(`
            SELECT nome, criado_em FROM associacoes
            WHERE criado_em >= now() - interval '7 days'
            ORDER BY criado_em DESC LIMIT 10
        `);
        const solicitacoesPendentes = await client.query(`
            SELECT COUNT(*) AS total FROM solicitacoes_plano WHERE status = 'pendente'
        `);

        const alertas = [];
        const totalSolicitacoesPendentes = parseInt(solicitacoesPendentes.rows[0].total, 10);
        if (totalSolicitacoesPendentes > 0) {
            alertas.push({ nivel: 'alerta', texto: `${totalSolicitacoesPendentes} solicitação(ões) de contratação de plano aguardando aprovação` });
        }
        const totalAtrasadas = parseInt(kpis.rows[0].total_atrasadas, 10);
        if (totalAtrasadas > 0) {
            alertas.push({ nivel: 'alerta', texto: `${totalAtrasadas} mensalidade(s) atrasada(s) na plataforma` });
        }
        assinaturasAtencao.rows.forEach((a) => {
            const dataFmt = new Date(a.vencimento_assinatura).toLocaleDateString('pt-BR');
            alertas.push({
                nivel: a.vencida ? 'perigo' : 'alerta',
                texto: a.vencida
                    ? `Assinatura de "${a.nome}" venceu em ${dataFmt}`
                    : `Assinatura de "${a.nome}" vence em ${dataFmt}`,
            });
        });
        associacoesNovas.rows.forEach((a) => {
            alertas.push({ nivel: 'info', texto: `"${a.nome}" foi cadastrada recentemente` });
        });

        res.json({
            ...kpis.rows[0],
            receita_mrr: mrr,
            crescimento_associacoes: crescimentoAssociacoes.rows,
            novos_associados: novosAssociados.rows,
            receita_historico: receitaHistorico.rows,
            distribuicao_planos: distribuicaoPlanos.rows,
            ultimas_associacoes: ultimasAssociacoes.rows,
            solicitacoes_pendentes_plano: totalSolicitacoesPendentes,
            alertas: alertas.slice(0, 10),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar dashboard' });
    } finally {
        client.release();
    }
});

// POST /superadmin/associacoes — cria uma nova associação + admin inicial dela.
// O e-mail principal da associação é o mesmo usado para o primeiro login do
// admin — a senha é gerada automaticamente e devolvida uma única vez nesta
// resposta (enquanto não há envio de e-mail integrado).
router.post('/associacoes', autorizarSuperAdmin(...GESTAO), async (req, res) => {
    const {
        nome_associacao, tipo, email, telefone, endereco, cidade, estado, cep, site, cnpj, logo_base64,
        nome_admin, cpf,
        plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca, trial_dias, dias_alerta_assinatura
    } = req.body;

    if (!nome_associacao || !nome_admin || !email) {
        return res.status(400).json({ erro: 'nome_associacao, nome_admin e email são obrigatórios' });
    }
    if (!emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail da associação inválido' });
    }
    if (cpf && !cpfValido(cpf)) {
        return res.status(400).json({ erro: 'CPF do responsável inválido' });
    }
    if (forma_cobranca && !FORMAS_COBRANCA_VALIDAS.includes(forma_cobranca)) {
        return res.status(400).json({ erro: 'forma_cobranca inválida' });
    }
    const diasTrial = trial_dias ? parseInt(trial_dias, 10) : 15;
    if (isNaN(diasTrial) || diasTrial < 1 || diasTrial > 365) {
        return res.status(400).json({ erro: 'trial_dias deve ser um número entre 1 e 365' });
    }
    const diasAlertaAssinatura = dias_alerta_assinatura ? parseInt(dias_alerta_assinatura, 10) : 30;
    if (!DIAS_ALERTA_ASSINATURA_VALIDOS.includes(diasAlertaAssinatura)) {
        return res.status(400).json({ erro: 'dias_alerta_assinatura deve ser um destes valores: ' + DIAS_ALERTA_ASSINATURA_VALIDOS.join(', ') });
    }
    // Limite de ~2MB em base64, mesmo padrão de PUT /configuracoes/logo
    // (achado na auditoria de segurança de 29/07/2026 -- essa rota aceitava
    // logo de qualquer tamanho, inconsistente com toda outra rota de
    // upload de imagem do sistema).
    if (logo_base64 && logo_base64.length > 2_800_000) {
        return res.status(400).json({ erro: 'Imagem muito grande. Escolha uma logo menor.' });
    }
    if (logo_base64 && !imagemBase64Valida(logo_base64)) {
        return res.status(400).json({ erro: 'Logo inválida. Envie PNG, JPG, GIF ou WEBP.' });
    }

    // Gerado/hasheado antes de pegar a conexão -- ver comentário equivalente
    // em routes/associados.js (POST /).
    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    const client = await comConexaoSuperAdmin();
    try {
        await client.query('BEGIN');

        // trial_expira_em só faz sentido pra quem nasce em trial -- planos
        // pagos criados direto (raro, mas possível) não têm expiração de trial.
        // Calculado aqui em JS (não em SQL) porque reusar o mesmo parâmetro
        // ($12) tanto pro INSERT quanto numa comparação de tipo diferente
        // dentro da mesma query dá erro no Postgres ("inconsistent types
        // deduced for parameter", 42P08 -- texto vs enum plano_assinatura).
        const planoFinal = plano || 'trial';
        const trialExpiraEm = planoFinal === 'trial' ? new Date(Date.now() + diasTrial * 24 * 60 * 60 * 1000) : null;
        const associacao = await client.query(
            `INSERT INTO associacoes (nome, tipo, email, telefone, endereco, cidade, estado, cep, site, cnpj, logo_url,
                                       plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca,
                                       trial_dias, trial_expira_em, dias_alerta_assinatura)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
             RETURNING id`,
            [nome_associacao, tipo || 'outra', email, telefone || null, endereco || null, cidade || null, estado || null,
                cep || null, site || null, cnpj || null, logo_base64 || null,
                planoFinal, valor_mensalidade_manual || null, vencimento_assinatura || null, forma_cobranca || null,
                diasTrial, trialExpiraEm, diasAlertaAssinatura]
        );
        const associacaoId = associacao.rows[0].id;

        const usuario = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel, deve_trocar_senha, cpf)
             VALUES ($1, $2, $3, $4, 'admin', true, $5) RETURNING id, nome, email`,
            [associacaoId, nome_admin, email, senhaHash, cpf || null]
        );

        await registrarEventoAuth(client, {
            usuarioId: usuario.rows[0].id,
            associacaoId,
            emailTentado: email,
            evento: 'senha_provisoria_criada',
            req,
        });
        await registrarLogAuditoria(client, {
            associacaoId, superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'associacoes', tipoAcao: 'criacao',
            descricao: req.superAdmin.nome + ' criou a associação "' + nome_associacao + '"',
            dadosNovos: { id: associacaoId, nome: nome_associacao, plano: plano || 'trial' }, req,
        });

        await client.query('COMMIT');
        res.status(201).json({
            associacao_id: associacaoId,
            admin: usuario.rows[0],
            senha_provisoria: senhaProvisoria,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            if (err.constraint === 'usuarios_email_unique_idx') {
                return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail na plataforma' });
            }
            return res.status(409).json({ erro: 'CNPJ ou e-mail já cadastrado' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar associação' });
    } finally {
        client.release();
    }
});

// PUT /superadmin/associacoes/:id — edita os dados de uma associação
// (associacoes agora tem RLS real -> precisa da conexão de bypass do super-admin)
router.put('/associacoes/:id', autorizarSuperAdmin(...GESTAO), async (req, res) => {
    const { id } = req.params;
    const {
        nome, tipo, email, telefone, endereco, cidade, estado, cep, site, cnpj, logo_base64, ativo,
        plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca, cpf, trial_dias, trial_expira_em,
        dias_alerta_assinatura
    } = req.body;

    if (!nome || !nome.trim()) {
        return res.status(400).json({ erro: 'nome é obrigatório' });
    }
    if (cpf && !cpfValido(cpf)) {
        return res.status(400).json({ erro: 'CPF do responsável inválido' });
    }
    if (forma_cobranca && !FORMAS_COBRANCA_VALIDAS.includes(forma_cobranca)) {
        return res.status(400).json({ erro: 'forma_cobranca inválida' });
    }
    if (trial_dias !== undefined && trial_dias !== null && (isNaN(parseInt(trial_dias, 10)) || trial_dias < 1 || trial_dias > 365)) {
        return res.status(400).json({ erro: 'trial_dias deve ser um número entre 1 e 365' });
    }
    if (dias_alerta_assinatura !== undefined && dias_alerta_assinatura !== null
        && !DIAS_ALERTA_ASSINATURA_VALIDOS.includes(parseInt(dias_alerta_assinatura, 10))) {
        return res.status(400).json({ erro: 'dias_alerta_assinatura deve ser um destes valores: ' + DIAS_ALERTA_ASSINATURA_VALIDOS.join(', ') });
    }
    // Limite de ~2MB em base64, mesmo padrão de PUT /configuracoes/logo
    // (achado na auditoria de segurança de 29/07/2026).
    if (logo_base64 && logo_base64.length > 2_800_000) {
        return res.status(400).json({ erro: 'Imagem muito grande. Escolha uma logo menor.' });
    }
    if (logo_base64 && !imagemBase64Valida(logo_base64)) {
        return res.status(400).json({ erro: 'Logo inválida. Envie PNG, JPG, GIF ou WEBP.' });
    }

    const client = await comConexaoSuperAdmin();
    try {
        await client.query('BEGIN');

        const anterior = await client.query(
            `SELECT nome, tipo, email, telefone, endereco, cidade, estado, cnpj, ativo,
                    cep, site, plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca,
                    trial_dias, trial_expira_em, dias_alerta_assinatura
             FROM associacoes WHERE id = $1`,
            [id]
        );
        if (anterior.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }

        const resultado = await client.query(
            `UPDATE associacoes
             SET nome = $1, tipo = COALESCE($2, tipo), email = $3, telefone = $4,
                 endereco = $5, cidade = $6, estado = $7, cnpj = $8, ativo = COALESCE($9, ativo),
                 cep = $10, site = $11, logo_url = COALESCE($12, logo_url),
                 plano = COALESCE($13, plano), valor_mensalidade_manual = $14,
                 vencimento_assinatura = $15, forma_cobranca = $16,
                 trial_dias = COALESCE($18, trial_dias), trial_expira_em = COALESCE($19, trial_expira_em),
                 dias_alerta_assinatura = COALESCE($20, dias_alerta_assinatura)
             WHERE id = $17
             RETURNING id, nome, tipo, email, telefone, endereco, cidade, estado, cnpj, ativo,
                       cep, site, logo_url, plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca,
                       trial_dias, trial_expira_em, dias_alerta_assinatura`,
            [nome.trim(), tipo || null, email || null, telefone || null, endereco || null, cidade || null, estado || null, cnpj || null, ativo,
                cep || null, site || null, logo_base64 || null,
                plano || null, valor_mensalidade_manual || null, vencimento_assinatura || null, forma_cobranca || null, id,
                trial_dias || null, trial_expira_em || null, dias_alerta_assinatura ? parseInt(dias_alerta_assinatura, 10) : null]
        );

        if (cpf) {
            await client.query(
                `UPDATE usuarios SET cpf = $1 WHERE associacao_id = $2 AND papel = 'admin'`,
                [cpf, id]
            );
        }

        // logo_url fora do log de auditoria de propósito (achado na
        // auditoria de segurança de 29/07/2026) -- é a logo inteira em
        // base64 (pode ter MBs), gravada em logs_auditoria.dados_novos a
        // cada edição mesmo quando a edição não mexeu na logo, e
        // logs_auditoria nunca é limpa (associacao_id usa ON DELETE SET
        // NULL, não CASCADE). `anterior` já nem seleciona logo_url, por
        // isso; aqui precisa excluir explicitamente do RETURNING da UPDATE.
        const { logo_url, ...dadosNovosSemLogo } = resultado.rows[0];
        await registrarLogAuditoria(client, {
            associacaoId: id, superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'associacoes', tipoAcao: 'edicao',
            descricao: req.superAdmin.nome + ' editou a associação "' + resultado.rows[0].nome + '"',
            dadosAnteriores: anterior.rows[0], dadosNovos: dadosNovosSemLogo, req,
        });

        await client.query('COMMIT');
        res.json(resultado.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'CNPJ já cadastrado em outra associação' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao editar associação' });
    } finally {
        client.release();
    }
});

// DELETE /superadmin/associacoes/:id — remove a associação e tudo que pertence a ela
// O ON DELETE CASCADE toca associados/cobrancas/usuarios/comunicados/pagamentos
// (todas com RLS) -> precisa da conexão de bypass do super-admin
router.delete('/associacoes/:id', autorizarSuperAdmin('super_admin'), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(`DELETE FROM associacoes WHERE id = $1 RETURNING id, nome`, [id]);
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }
        await registrarLogAuditoria(client, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'associacoes', tipoAcao: 'exclusao',
            descricao: req.superAdmin.nome + ' excluiu a associação "' + resultado.rows[0].nome + '"',
            dadosAnteriores: resultado.rows[0], req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir associação' });
    } finally {
        client.release();
    }
});

// ---------- Auditoria (tela central de logs, cross-tenant) ----------

// Monta as condições de filtro compartilhadas por GET /logs e pelas duas
// rotas de exportação -- evita repetir a mesma lógica três vezes.
function construirFiltrosLogs(query) {
    const { usuario, associacao, modulo, tipo_acao, data_inicio, data_fim } = query;
    const condicoes = [];
    const valores = [];

    if (usuario) {
        valores.push('%' + usuario + '%');
        condicoes.push(`(l.usuario_nome ILIKE $${valores.length} OR l.usuario_email ILIKE $${valores.length}
                         OR l.super_admin_nome ILIKE $${valores.length} OR l.super_admin_email ILIKE $${valores.length})`);
    }
    if (associacao) {
        valores.push('%' + associacao + '%');
        condicoes.push(`a.nome ILIKE $${valores.length}`);
    }
    if (modulo) {
        valores.push(modulo);
        condicoes.push(`l.modulo = $${valores.length}`);
    }
    if (tipo_acao) {
        valores.push(tipo_acao);
        condicoes.push(`l.tipo_acao = $${valores.length}::tipo_acao_auditoria`);
    }
    if (data_inicio) {
        valores.push(data_inicio);
        condicoes.push(`l.criado_em >= $${valores.length}::date`);
    }
    if (data_fim) {
        valores.push(data_fim);
        condicoes.push(`l.criado_em < $${valores.length}::date + interval '1 day'`);
    }

    return { where: condicoes.length ? 'WHERE ' + condicoes.join(' AND ') : '', valores };
}

// Limite de linhas por exportação -- evita que um filtro amplo demais gere um
// arquivo gigante e derrube a instância por memória.
const LIMITE_EXPORTACAO = 5000;

// GET /superadmin/logs — lista paginada com filtros (qualquer nível de
// permissão pode consultar; é só leitura)
router.get('/logs', async (req, res) => {
    const { pagina, por_pagina, ordenar, limite: limiteQuery } = req.query;
    const client = await comConexaoSuperAdmin();
    try {
        const { where, valores } = construirFiltrosLogs(req.query);
        const direcao = ordenar === 'asc' ? 'ASC' : 'DESC';
        // Se passou 'limite', usa como atalho pra simples listagem sem paginação;
        // senão, usa paginação normal com por_pagina/pagina.
        const usandoLimiteSimples = limiteQuery && !pagina && !por_pagina;
        const limite = usandoLimiteSimples
            ? inteiroPositivo(limiteQuery, 100, 100)
            : inteiroPositivo(por_pagina, 50, 200);
        const paginaAtual = usandoLimiteSimples ? 1 : Math.max(parseInt(pagina, 10) || 1, 1);
        const offset = (paginaAtual - 1) * limite;

        const total = await client.query(
            `SELECT COUNT(*) AS total FROM logs_auditoria l LEFT JOIN associacoes a ON a.id = l.associacao_id ${where}`,
            valores
        );

        const valoresPagina = [...valores, limite, offset];
        const resultado = await client.query(
            `SELECT l.id, l.criado_em, l.usuario_nome, l.usuario_email, l.super_admin_nome, l.super_admin_email,
                    l.modulo, l.tipo_acao, l.descricao, l.dados_anteriores, l.dados_novos, l.ip, l.user_agent,
                    a.nome AS associacao_nome
             FROM logs_auditoria l
             LEFT JOIN associacoes a ON a.id = l.associacao_id
             ${where}
             ORDER BY l.criado_em ${direcao}
             LIMIT $${valoresPagina.length - 1} OFFSET $${valoresPagina.length}`,
            valoresPagina
        );

        res.json({
            registros: resultado.rows,
            total: parseInt(total.rows[0].total, 10),
            pagina: paginaAtual,
            por_pagina: limite,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar logs de auditoria' });
    } finally {
        client.release();
    }
});

// GET /superadmin/logs/exportar/:formato — respeita os mesmos filtros da
// listagem, sem paginação (limitado a LIMITE_EXPORTACAO linhas), e registra a
// própria exportação como uma linha de auditoria (tipo_acao 'exportacao').
router.get('/logs/exportar/:formato', autorizarSuperAdmin(...GESTAO), async (req, res) => {
    const { formato } = req.params;
    if (formato !== 'pdf') {
        return res.status(400).json({ erro: 'formato deve ser "pdf"' });
    }

    const client = await comConexaoSuperAdmin();
    try {
        const { where, valores } = construirFiltrosLogs(req.query);
        const valoresLimitados = [...valores, LIMITE_EXPORTACAO];
        const resultado = await client.query(
            `SELECT l.criado_em, l.usuario_nome, l.usuario_email, l.super_admin_nome, l.super_admin_email,
                    l.modulo, l.tipo_acao, l.descricao, l.ip
             FROM logs_auditoria l
             LEFT JOIN associacoes a ON a.id = l.associacao_id
             ${where}
             ORDER BY l.criado_em DESC
             LIMIT $${valoresLimitados.length}`,
            valoresLimitados
        );

        await registrarLogAuditoria(client, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'auditoria', tipoAcao: 'exportacao',
            descricao: req.superAdmin.nome + ' exportou os logs de auditoria em ' + formato.toUpperCase() + ' (' + resultado.rows.length + ' linhas)',
            req,
        });

        const buffer = await gerarPdfLogs(resultado.rows);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'attachment; filename="logs-auditoria.pdf"');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao exportar logs de auditoria' });
    } finally {
        client.release();
    }
});

// ---------- Solicitações de contratação/upgrade de plano ----------

// GET /superadmin/solicitacoes-plano — lista solicitações (padrão: só as
// pendentes, ?status=todas pra ver aprovadas/rejeitadas também). Qualquer
// nível de permissão pode ver/aprovar -- é operacional, não gestão de acesso.
router.get('/solicitacoes-plano', async (req, res) => {
    const { status } = req.query;
    const client = await comConexaoSuperAdmin();
    try {
        const where = status === 'todas' ? '' : `WHERE sp.status = 'pendente'`;
        const resultado = await client.query(`
            SELECT sp.id, sp.plano_solicitado, sp.valor_referencia, sp.status, sp.solicitado_em,
                   sp.respondido_em, sp.observacao_resposta,
                   a.id AS associacao_id, a.nome AS associacao_nome,
                   u.nome AS solicitado_por_nome
            FROM solicitacoes_plano sp
            JOIN associacoes a ON a.id = sp.associacao_id
            LEFT JOIN usuarios u ON u.id = sp.solicitado_por
            ${where}
            ORDER BY sp.solicitado_em DESC
            LIMIT 200
        `);
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar solicitações de plano' });
    } finally {
        client.release();
    }
});

// GET /superadmin/solicitacoes-plano/:id/comprovante — comprovante enviado
// junto com a solicitação (mesmo padrão de GET /cobrancas/:id/comprovante).
router.get('/solicitacoes-plano/:id/comprovante', async (req, res) => {
    const { id } = req.params;
    res.set('Cache-Control', 'no-store');
    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `SELECT comprovante_base64 FROM solicitacoes_plano WHERE id = $1`,
            [id]
        );
        if (resultado.rows.length === 0 || !resultado.rows[0].comprovante_base64) {
            return res.status(404).json({ erro: 'Comprovante não encontrado' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar comprovante' });
    } finally {
        client.release();
    }
});

// PATCH /superadmin/solicitacoes-plano/:id/aprovar — ativa o plano solicitado
// na associação (vencimento padrão de 30 dias a partir de hoje, mesmo se já
// tinha um vencimento anterior -- é uma contratação nova).
router.patch('/solicitacoes-plano/:id/aprovar', autorizarSuperAdmin(...GESTAO), async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoSuperAdmin();
    try {
        await client.query('BEGIN');

        const solicitacao = await client.query(
            `SELECT id, associacao_id, plano_solicitado, status FROM solicitacoes_plano WHERE id = $1`,
            [id]
        );
        if (solicitacao.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ erro: 'Solicitação não encontrada' });
        }
        if (solicitacao.rows[0].status !== 'pendente') {
            await client.query('ROLLBACK');
            return res.status(409).json({ erro: 'Essa solicitação já foi respondida' });
        }
        const { associacao_id, plano_solicitado } = solicitacao.rows[0];

        await client.query(
            `UPDATE solicitacoes_plano SET status = 'aprovada', respondido_em = now(), respondido_por = $1 WHERE id = $2`,
            [req.superAdmin.id, id]
        );
        const associacao = await client.query(
            `UPDATE associacoes SET plano = $1, ativo = true, vencimento_assinatura = CURRENT_DATE + interval '30 days'
             WHERE id = $2 RETURNING nome`,
            [plano_solicitado, associacao_id]
        );

        await registrarLogAuditoria(client, {
            associacaoId: associacao_id, superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'planos', tipoAcao: 'edicao',
            descricao: req.superAdmin.nome + ' aprovou a contratação do plano ' + plano_solicitado + ' para "' + associacao.rows[0].nome + '"',
            dadosNovos: { plano: plano_solicitado }, req,
        });

        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ erro: 'Erro ao aprovar solicitação' });
    } finally {
        client.release();
    }
});

// PATCH /superadmin/solicitacoes-plano/:id/rejeitar
router.patch('/solicitacoes-plano/:id/rejeitar', autorizarSuperAdmin(...GESTAO), async (req, res) => {
    const { id } = req.params;
    const { motivo } = req.body;
    const client = await comConexaoSuperAdmin();
    try {
        await client.query('BEGIN');

        const solicitacao = await client.query(
            `SELECT sp.id, sp.status, sp.plano_solicitado, a.nome AS associacao_nome
             FROM solicitacoes_plano sp JOIN associacoes a ON a.id = sp.associacao_id
             WHERE sp.id = $1`,
            [id]
        );
        if (solicitacao.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ erro: 'Solicitação não encontrada' });
        }
        if (solicitacao.rows[0].status !== 'pendente') {
            await client.query('ROLLBACK');
            return res.status(409).json({ erro: 'Essa solicitação já foi respondida' });
        }

        await client.query(
            `UPDATE solicitacoes_plano
             SET status = 'rejeitada', respondido_em = now(), respondido_por = $1, observacao_resposta = $2
             WHERE id = $3`,
            [req.superAdmin.id, motivo || null, id]
        );

        await registrarLogAuditoria(client, {
            associacaoId: null, superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'planos', tipoAcao: 'edicao',
            descricao: req.superAdmin.nome + ' rejeitou a contratação do plano ' + solicitacao.rows[0].plano_solicitado + ' para "' + solicitacao.rows[0].associacao_nome + '"',
            req,
        });

        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ erro: 'Erro ao rejeitar solicitação' });
    } finally {
        client.release();
    }
});

// ---------- Configuração de Pix da própria plataforma ----------
// Chave usada no QR Code que a associação escaneia pra pagar a mensalidade
// da plataforma (diferente da chave Pix de cada associação, essa é única e
// global -- ver migration 20260727000000_plano_trial_e_contratacao.sql).

router.get('/configuracoes-plataforma', autorizarSuperAdmin('super_admin'), async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT chave_pix, nome_recebedor_pix, cidade_pix FROM configuracoes_plataforma WHERE id = true`
        );
        res.json(resultado.rows[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar configuração da plataforma' });
    }
});

router.put('/configuracoes-plataforma', autorizarSuperAdmin('super_admin'), async (req, res) => {
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

    // UPDATE aqui precisa da conexão de bypass -- a policy de UPDATE de
    // configuracoes_plataforma exige app.superadmin_bypass, senão a query
    // roda "com sucesso" mas afeta 0 linhas (RLS silenciosamente não acha a
    // linha pra atualizar).
    const client = await comConexaoSuperAdmin();
    try {
        await client.query(
            `UPDATE configuracoes_plataforma SET chave_pix = $1, nome_recebedor_pix = $2, cidade_pix = $3, atualizado_em = now() WHERE id = true`,
            [chave_pix, nome_recebedor_pix, cidade_pix]
        );
        await registrarLogAuditoria(client, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'configuracoes', tipoAcao: 'edicao',
            descricao: req.superAdmin.nome + ' atualizou a configuração de Pix da plataforma',
            req,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao salvar configuração da plataforma' });
    } finally {
        client.release();
    }
});

// POST /superadmin/comunicados-plataforma — envia um comunicado pra todas as
// associações ativas de uma vez (uma linha em `comunicados` por associação,
// reaproveitando a tabela e o mural que já existe em cada tenant -- nenhuma
// tela nova precisou ser criada em painel/index.html ou portal.html pra
// exibir). `autor_id` fica null (super-admin não é um usuario de tenant);
// `origem_plataforma = true` marca a origem, pra front mostrar "Comunicado
// oficial" e bloquear editar/excluir por conta da diretoria (ver
// routes/comunicados.js PUT/DELETE).
router.post('/comunicados-plataforma', autorizarSuperAdmin(...GESTAO), async (req, res) => {
    const { titulo, conteudo } = req.body;
    if (!titulo || !conteudo) {
        return res.status(400).json({ erro: 'titulo e conteudo são obrigatórios' });
    }

    const client = await comConexaoSuperAdmin();
    try {
        const associacoes = await client.query(`SELECT id FROM associacoes WHERE ativo = true`);

        for (const associacao of associacoes.rows) {
            await client.query(
                `INSERT INTO comunicados (associacao_id, autor_id, titulo, conteudo, origem_plataforma)
                 VALUES ($1, NULL, $2, $3, true)`,
                [associacao.id, titulo, conteudo]
            );
        }

        await registrarLogAuditoria(client, {
            superAdminId: req.superAdmin.id, superAdminNome: req.superAdmin.nome, superAdminEmail: req.superAdmin.email,
            modulo: 'comunicados', tipoAcao: 'criacao',
            descricao: req.superAdmin.nome + ' enviou um comunicado da plataforma pra ' + associacoes.rows.length + ' associação(ões): "' + titulo + '"',
            dadosNovos: { titulo, conteudo, total_associacoes: associacoes.rows.length },
            req,
        });

        res.status(201).json({ ok: true, total_associacoes: associacoes.rows.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao enviar comunicado da plataforma' });
    } finally {
        client.release();
    }
});

module.exports = router;
