// routes/superadmin.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const config = require('../config/env');
const { autenticarSuperAdmin, comConexaoSuperAdmin } = require('../middleware/auth');
const { limiteLogin } = require('../middleware/rateLimiter');
const { emailValido, gerarSenhaProvisoria } = require('../utils/validacao');
const { registrarEventoAuth } = require('../utils/authLog');

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
            `SELECT id, nome, email, senha_hash FROM super_admins WHERE email = $1`,
            [email]
        );
        const admin = resultado.rows[0];
        if (!admin) {
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

        res.json({ token, nome: admin.nome });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao autenticar' });
    }
});

// A partir daqui, todas as rotas exigem token de super-admin
router.use(autenticarSuperAdmin);

// GET /superadmin/associacoes — lista todas as associações com contadores agregados e filtros
// Toca associados/cobrancas (têm RLS) -> usa conexão de bypass do super-admin
router.get('/associacoes', async (req, res) => {
    const { busca, cidade, plano, status } = req.query;
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
        if (plano) {
            valores.push(plano);
            condicoes.push(`a.plano = $${valores.length}`);
        }
        if (status === 'ativo') condicoes.push(`a.ativo = true`);
        if (status === 'inativo') condicoes.push(`a.ativo = false`);

        const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

        const resultado = await client.query(`
            SELECT a.id, a.nome, a.tipo, a.email, a.telefone, a.endereco, a.cidade, a.estado, a.cnpj,
                   a.plano, a.ativo, a.criado_em,
                   (SELECT COUNT(*) FROM associados ass WHERE ass.associacao_id = a.id) AS total_associados,
                   (SELECT COUNT(*) FROM cobrancas c WHERE c.associacao_id = a.id AND c.status = 'pendente') AS cobrancas_pendentes,
                   (SELECT COUNT(*) FROM cobrancas c WHERE c.associacao_id = a.id AND c.status = 'pendente' AND c.vencimento < CURRENT_DATE) AS cobrancas_atrasadas
            FROM associacoes a
            ${where}
            ORDER BY a.criado_em DESC
        `, valores);
        res.json(resultado.rows);
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
            `SELECT id, nome, email, ativo, criado_em FROM usuarios WHERE associacao_id = $1 AND papel = 'admin' LIMIT 1`,
            [id]
        );

        const financeiro = await client.query(`
            SELECT
                (SELECT COALESCE(SUM(p.valor_pago), 0) FROM pagamentos p
                   JOIN cobrancas c ON c.id = p.cobranca_id WHERE c.associacao_id = $1) AS total_recebido,
                (SELECT COALESCE(SUM(valor), 0) FROM cobrancas WHERE associacao_id = $1 AND status = 'pendente') AS total_a_receber,
                (SELECT MIN(vencimento) FROM cobrancas WHERE associacao_id = $1 AND status = 'pendente') AS proximo_vencimento
        `, [id]);

        res.json({
            ...associacao.rows[0],
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

    const client = await comConexaoSuperAdmin();
    try {
        const senhaProvisoria = gerarSenhaProvisoria();
        const senhaHash = await bcrypt.hash(senhaProvisoria, 10);
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
            FROM generate_series(date_trunc('month', now()) - interval '6 months', date_trunc('month', now()), interval '1 month') AS mes
            LEFT JOIN associacoes a ON date_trunc('month', a.criado_em) = mes
            GROUP BY mes ORDER BY mes
        `);

        const novosAssociados = await client.query(`
            SELECT to_char(mes, 'YYYY-MM') AS mes, COUNT(ass.id) AS total
            FROM generate_series(date_trunc('month', now()) - interval '6 months', date_trunc('month', now()), interval '1 month') AS mes
            LEFT JOIN associados ass ON date_trunc('month', ass.criado_em) = mes
            GROUP BY mes ORDER BY mes
        `);

        res.json({
            ...kpis.rows[0],
            crescimento_associacoes: crescimentoAssociacoes.rows,
            novos_associados: novosAssociados.rows
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
        nome_associacao, tipo, email, telefone, endereco, cidade, estado, cnpj,
        nome_admin
    } = req.body;

    if (!nome_associacao || !nome_admin || !email) {
        return res.status(400).json({ erro: 'nome_associacao, nome_admin e email são obrigatórios' });
    }
    if (!emailValido(email)) {
        return res.status(400).json({ erro: 'e-mail da associação inválido' });
    }

    const client = await comConexaoSuperAdmin();
    try {
        await client.query('BEGIN');

        const associacao = await client.query(
            `INSERT INTO associacoes (nome, tipo, email, telefone, endereco, cidade, estado, cnpj)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [nome_associacao, tipo || 'outra', email, telefone || null, endereco || null, cidade || null, estado || null, cnpj || null]
        );
        const associacaoId = associacao.rows[0].id;

        const senhaProvisoria = gerarSenhaProvisoria();
        const senhaHash = await bcrypt.hash(senhaProvisoria, 10);

        const usuario = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel, deve_trocar_senha)
             VALUES ($1, $2, $3, $4, 'admin', true) RETURNING id, nome, email`,
            [associacaoId, nome_admin, email, senhaHash]
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
    const { nome, tipo, email, telefone, endereco, cidade, estado, cnpj, ativo } = req.body;

    if (!nome || !nome.trim()) {
        return res.status(400).json({ erro: 'nome é obrigatório' });
    }

    const client = await comConexaoSuperAdmin();
    try {
        const resultado = await client.query(
            `UPDATE associacoes
             SET nome = $1, tipo = COALESCE($2, tipo), email = $3, telefone = $4,
                 endereco = $5, cidade = $6, estado = $7, cnpj = $8, ativo = COALESCE($9, ativo)
             WHERE id = $10
             RETURNING id, nome, tipo, email, telefone, endereco, cidade, estado, cnpj, ativo`,
            [nome.trim(), tipo || null, email || null, telefone || null, endereco || null, cidade || null, estado || null, cnpj || null, ativo, id]
        );
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }
        res.json(resultado.rows[0]);
    } catch (err) {
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
