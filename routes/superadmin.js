// routes/superadmin.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const config = require('../config/env');
const { autenticarSuperAdmin, autorizarSuperAdmin, comConexaoSuperAdmin } = require('../middleware/auth');
const { limiteLogin } = require('../middleware/rateLimiter');
const { emailValido, gerarSenhaProvisoria, cpfValido, senhaForte } = require('../utils/validacao');
const { registrarEventoAuth } = require('../utils/authLog');
const { calcularValorMensalidade, statusAssinatura } = require('../utils/precos');

const FORMAS_COBRANCA_VALIDAS = ['pix', 'boleto', 'cartao', 'dinheiro', 'outro'];
const PAPEIS_SUPERADMIN_VALIDOS = ['super_admin', 'administrador', 'suporte'];

const router = express.Router();
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
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }

        const senhaCorreta = await bcrypt.compare(senha, admin.senha_hash);
        if (!senhaCorreta) {
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }

        const token = jwt.sign(
            { id: admin.id, email: admin.email, tipo: 'superadmin' },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

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
        const resultado = await pool.query(
            `SELECT id, nome, email, papel, ativo, criado_em FROM super_admins ORDER BY criado_em DESC`
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
        const resultado = await pool.query(
            `UPDATE super_admins SET nome = $1, email = COALESCE($2, email), papel = COALESCE($3, papel)
             WHERE id = $4 RETURNING id, nome, email, papel, ativo, criado_em`,
            [nome.trim(), email || null, papel || null, id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Administrador não encontrado' });
        }
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
            `UPDATE super_admins SET senha_hash = $1, deve_trocar_senha = true WHERE id = $2 RETURNING id, email`,
            [senhaHash, id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Administrador não encontrado' });
        }
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
            `UPDATE super_admins SET senha_hash = $1, deve_trocar_senha = false WHERE id = $2`,
            [novoHash, req.superAdmin.id]
        );

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao trocar senha' });
    }
});

// GET /superadmin/associacoes — lista todas as associações com contadores agregados e filtros
// Toca associados/cobrancas (têm RLS) -> usa conexão de bypass do super-admin
router.get('/associacoes', async (req, res) => {
    const { busca, cidade, estado, plano, status } = req.query;
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
router.patch('/associacoes/:id/resetar-senha-admin', async (req, res) => {
    const { id } = req.params;

    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = true
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

        const alertas = [];
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
router.post('/associacoes', async (req, res) => {
    const {
        nome_associacao, tipo, email, telefone, endereco, cidade, estado, cep, site, cnpj, logo_base64,
        nome_admin, cpf,
        plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca
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

    // Gerado/hasheado antes de pegar a conexão -- ver comentário equivalente
    // em routes/associados.js (POST /).
    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

    const client = await comConexaoSuperAdmin();
    try {
        await client.query('BEGIN');

        const associacao = await client.query(
            `INSERT INTO associacoes (nome, tipo, email, telefone, endereco, cidade, estado, cep, site, cnpj, logo_url,
                                       plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
            [nome_associacao, tipo || 'outra', email, telefone || null, endereco || null, cidade || null, estado || null,
                cep || null, site || null, cnpj || null, logo_base64 || null,
                plano || 'trial', valor_mensalidade_manual || null, vencimento_assinatura || null, forma_cobranca || null]
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
router.put('/associacoes/:id', async (req, res) => {
    const { id } = req.params;
    const {
        nome, tipo, email, telefone, endereco, cidade, estado, cep, site, cnpj, logo_base64, ativo,
        plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca, cpf
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

    const client = await comConexaoSuperAdmin();
    try {
        await client.query('BEGIN');

        const resultado = await client.query(
            `UPDATE associacoes
             SET nome = $1, tipo = COALESCE($2, tipo), email = $3, telefone = $4,
                 endereco = $5, cidade = $6, estado = $7, cnpj = $8, ativo = COALESCE($9, ativo),
                 cep = $10, site = $11, logo_url = COALESCE($12, logo_url),
                 plano = COALESCE($13, plano), valor_mensalidade_manual = $14,
                 vencimento_assinatura = $15, forma_cobranca = $16
             WHERE id = $17
             RETURNING id, nome, tipo, email, telefone, endereco, cidade, estado, cnpj, ativo,
                       cep, site, logo_url, plano, valor_mensalidade_manual, vencimento_assinatura, forma_cobranca`,
            [nome.trim(), tipo || null, email || null, telefone || null, endereco || null, cidade || null, estado || null, cnpj || null, ativo,
                cep || null, site || null, logo_base64 || null,
                plano || null, valor_mensalidade_manual || null, vencimento_assinatura || null, forma_cobranca || null, id]
        );
        if (resultado.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }

        if (cpf) {
            await client.query(
                `UPDATE usuarios SET cpf = $1 WHERE associacao_id = $2 AND papel = 'admin'`,
                [cpf, id]
            );
        }

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
router.delete('/associacoes/:id', async (req, res) => {
    const { id } = req.params;
    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(`DELETE FROM associacoes WHERE id = $1 RETURNING id`, [id]);
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir associação' });
    } finally {
        client.release();
    }
});

module.exports = router;
