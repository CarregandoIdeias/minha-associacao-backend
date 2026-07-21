// routes/superadmin.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { autenticarSuperAdmin } = require('../middleware/auth');
const { emailValido } = require('../utils/validacao');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'troque-isso-em-producao';

// POST /superadmin/bootstrap
// Cria o PRIMEIRO super-admin. Só funciona se ainda não existir nenhum
// (autodesabilita depois do primeiro uso — não precisa de token para chamar essa vez).
router.post('/bootstrap', async (req, res) => {
    const { nome, email, senha } = req.body;

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
router.post('/login', async (req, res) => {
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

// GET /superadmin/associacoes — lista todas as associações com contadores agregados
router.get('/associacoes', async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT a.id, a.nome, a.tipo, a.email, a.telefone, a.endereco, a.cnpj,
                   a.plano, a.ativo, a.criado_em,
                   (SELECT COUNT(*) FROM associados ass WHERE ass.associacao_id = a.id) AS total_associados,
                   (SELECT COUNT(*) FROM cobrancas c WHERE c.associacao_id = a.id AND c.status = 'pendente') AS cobrancas_pendentes,
                   (SELECT COUNT(*) FROM cobrancas c WHERE c.associacao_id = a.id AND c.status = 'pendente' AND c.vencimento < CURRENT_DATE) AS cobrancas_atrasadas
            FROM associacoes a
            ORDER BY a.criado_em DESC
        `);
        res.json(resultado.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao listar associações' });
    }
});

// GET /superadmin/dashboard — KPIs agregados de toda a plataforma
router.get('/dashboard', async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM associacoes) AS total_associacoes,
                (SELECT COUNT(*) FROM associacoes WHERE ativo = true) AS associacoes_ativas,
                (SELECT COUNT(*) FROM associados) AS total_associados,
                (SELECT COUNT(*) FROM cobrancas WHERE status = 'pendente') AS total_pendentes,
                (SELECT COUNT(*) FROM cobrancas WHERE status = 'pendente' AND vencimento < CURRENT_DATE) AS total_atrasadas,
                (SELECT COUNT(*) FROM cobrancas WHERE status = 'aguardando_confirmacao') AS total_aguardando_confirmacao
        `);
        res.json(resultado.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar dashboard' });
    }
});

// POST /superadmin/associacoes — cria uma nova associação + admin inicial dela
router.post('/associacoes', async (req, res) => {
    const {
        nome_associacao, tipo, email, telefone, endereco, cnpj,
        nome_admin, email_admin, senha_admin
    } = req.body;

    if (!nome_associacao || !nome_admin || !email_admin || !senha_admin) {
        return res.status(400).json({ erro: 'nome_associacao, nome_admin, email_admin e senha_admin são obrigatórios' });
    }
    if (!emailValido(email_admin)) {
        return res.status(400).json({ erro: 'e-mail do admin inválido' });
    }
    if (senha_admin.length < 6) {
        return res.status(400).json({ erro: 'senha do admin deve ter ao menos 6 caracteres' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const associacao = await client.query(
            `INSERT INTO associacoes (nome, tipo, email, telefone, endereco, cnpj)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [nome_associacao, tipo || 'outra', email || null, telefone || null, endereco || null, cnpj || null]
        );
        const associacaoId = associacao.rows[0].id;

        const senhaHash = await bcrypt.hash(senha_admin, 10);

        const usuario = await client.query(
            `INSERT INTO usuarios (associacao_id, nome, email, senha_hash, papel)
             VALUES ($1, $2, $3, $4, 'admin') RETURNING id, nome, email`,
            [associacaoId, nome_admin, email_admin, senhaHash]
        );

        await client.query('COMMIT');
        res.status(201).json({ associacao_id: associacaoId, admin: usuario.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ erro: 'CNPJ ou e-mail já cadastrado' });
        }
        console.error(err);
        res.status(500).json({ erro: 'Erro ao criar associação' });
    } finally {
        client.release();
    }
});

// PUT /superadmin/associacoes/:id — edita os dados de uma associação
router.put('/associacoes/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, tipo, email, telefone, endereco, cnpj, ativo } = req.body;

    if (!nome || !nome.trim()) {
        return res.status(400).json({ erro: 'nome é obrigatório' });
    }

    try {
        const resultado = await pool.query(
            `UPDATE associacoes
             SET nome = $1, tipo = COALESCE($2, tipo), email = $3, telefone = $4,
                 endereco = $5, cnpj = $6, ativo = COALESCE($7, ativo)
             WHERE id = $8
             RETURNING id, nome, tipo, email, telefone, endereco, cnpj, ativo`,
            [nome.trim(), tipo || null, email || null, telefone || null, endereco || null, cnpj || null, ativo, id]
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
    }
});

// DELETE /superadmin/associacoes/:id — remove a associação e tudo que pertence a ela
router.delete('/associacoes/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const resultado = await pool.query(`DELETE FROM associacoes WHERE id = $1 RETURNING id`, [id]);
        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Associação não encontrada' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao excluir associação' });
    }
});

module.exports = router;
