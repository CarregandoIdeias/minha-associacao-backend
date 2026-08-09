// middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db');
const config = require('../config/env');
const { planoAtendeNivel, assinaturaBloqueadaPorVencimento } = require('../utils/precos');

const JWT_SECRET = config.jwtSecret;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pequena espera entre tentativas de reconexão (ver comConexaoComSessao/
// autenticar abaixo) -- dar um instante pro PgBouncer trocar de conexão
// física antes de tentar de novo, em vez de bater imediatamente na mesma
// conexão suspeita.
function aguardar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Compara o iat do token (segundos, padrão do JWT) com um timestamp de
// "invalidação" vindo do banco (milissegundos) -- usado tanto por
// senha_alterada_em quanto por sessoes_invalidas_antes_de (logout real,
// auditoria de segurança Fase 2, 08/08/2026). Arredondar os dois pro
// mesmo segundo (Math.floor do lado do timestamp) evita rejeitar um token
// novo emitido no mesmo segundo em que a invalidação aconteceu -- bug real
// já encontrado e corrigido nesse ponto (ver PUT /auth/senha/PUT
// /superadmin/perfil/senha, que reemitem token). Extraído aqui pra não
// repetir essa conta 4 vezes (2 timestamps x 2 funções de autenticação) e
// arriscar reintroduzir o mesmo bug numa cópia.
function tokenInvalidadoPor(payload, timestampInvalidacao) {
    return !!timestampInvalidacao && payload.iat < Math.floor(new Date(timestampInvalidacao).getTime() / 1000);
}

// Verifica o token e disponibiliza os dados do usuário em req.usuario.
// Também revalida contra o banco a cada requisição (usuário/associação
// ainda ativos, papel em dia) — sem isso, desativar alguém ou bloquear a
// associação só valeria depois do token expirar (até 8h depois).
async function autenticar(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const token = header.split(' ')[1];

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }

    // Guarda defensiva: se o id do payload não for um uuid válido, trata como
    // sessão inválida (401) em vez de deixar o Postgres rejeitar o parâmetro
    // com um erro de tipo (500) — visto acontecer em produção de forma
    // intermitente, causa exata ainda não confirmada.
    if (!payload || !payload.id || !UUID_REGEX.test(payload.id)) {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }

    // Falhas transitórias de conexão (instabilidade pontual do pooler do
    // Supabase, ver CLAUDE.md) já foram vistas derrubando essa consulta com
    // um erro estranho mesmo com um payload válido. 3 tentativas (era 2),
    // com uma pequena espera crescente entre elas e uma conexão nova do pool
    // a cada vez, resolve o caso comum sem esconder uma falha real (só
    // desiste depois da terceira).
    const MAX_TENTATIVAS = 3;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        const client = await comConexaoAuth();
        try {
            const resultado = await client.query(
                `SELECT u.ativo, u.papel, u.nome, u.associacao_id, u.senha_alterada_em,
                        u.sessoes_invalidas_antes_de,
                        a.ativo AS associacao_ativa, a.plano, a.trial_expira_em, a.vencimento_assinatura
                 FROM usuarios u
                 JOIN associacoes a ON a.id = u.associacao_id
                 WHERE u.id = $1`,
                [payload.id]
            );
            const usuario = resultado.rows[0];
            if (!usuario || !usuario.ativo || !usuario.associacao_ativa) {
                return res.status(401).json({ erro: 'Token inválido ou expirado' });
            }

            // Token emitido ANTES da última troca de senha não vale mais --
            // sem isso, um token roubado continuava válido até expirar (até
            // 8h) mesmo depois do dono trocar a senha por suspeitar de
            // acesso indevido. payload.iat vem em segundos inteiros (padrão
            // do jwt), senha_alterada_em em milissegundos -- comparar os
            // dois arredondados pro mesmo segundo (Math.floor do lado do
            // timestamp) evita rejeitar o próprio token novo emitido no
            // mesmo request que troca a senha, quando os dois caem no mesmo
            // segundo (bug real encontrado testando: o token reemitido por
            // PUT /auth/senha/PUT /superadmin/perfil/senha vinha inválido).
            // Cobre os dois motivos de invalidação -- troca de senha e logout
            // real (sessoes_invalidas_antes_de, Fase 2 da auditoria de
            // segurança, 08/08/2026). Ver tokenInvalidadoPor() acima.
            if (tokenInvalidadoPor(payload, usuario.senha_alterada_em) || tokenInvalidadoPor(payload, usuario.sessoes_invalidas_antes_de)) {
                return res.status(401).json({ erro: 'Token inválido ou expirado' });
            }

            // { id, associacao_id, papel, email, deve_trocar_senha, nome, plano,
            // trial_expira_em } — papel/nome/plano/trial_expira_em vêm frescos do
            // banco, não do token, para uma troca de papel, nome ou a expiração do
            // trial valerem na hora (nome também usado pro snapshot em
            // atividades, ver utils/atividadeLog.js; plano/trial_expira_em usados
            // por bloquearTrialExpirado abaixo).
            //
            // associacao_id TAMBÉM vem do banco desde a auditoria de 07/08/2026.
            // Antes era o único campo do token que ficava valendo sem
            // revalidação -- e é justamente a chave do isolamento entre tenants
            // (vira o SET de RLS em comConexaoTenant e o `WHERE associacao_id`
            // de toda query). Não era explorável (o token é assinado, ninguém
            // forja esse valor), mas era o campo onde ficar desatualizado
            // significaria uma associação enxergando dado de outra -- caro
            // demais pra depender de "nada muda esse campo hoje".
            req.usuario = {
                ...payload,
                associacao_id: usuario.associacao_id,
                papel: usuario.papel,
                nome: usuario.nome,
                plano: usuario.plano,
                trial_expira_em: usuario.trial_expira_em,
                vencimento_assinatura: usuario.vencimento_assinatura,
            };
            return next();
        } catch (err) {
            if (tentativa === MAX_TENTATIVAS) {
                console.error(err);
                return res.status(500).json({ erro: 'Erro ao validar sessão' });
            }
            console.error('autenticar: tentativa ' + tentativa + ' falhou, tentando de novo com conexao nova:', err.message);
            await aguardar(150 * tentativa);
        } finally {
            client.release();
        }
    }
}

// Bloqueia rotas normais enquanto o usuário estiver com senha provisória
// pendente de troca (primeiro acesso). Usar logo depois de autenticar() em
// cada router, exceto na rota de troca de senha em si.
function bloquearSenhaProvisoria(req, res, next) {
    if (req.usuario && req.usuario.deve_trocar_senha) {
        return res.status(403).json({
            erro: 'Você precisa definir uma nova senha antes de continuar',
            codigo: 'SENHA_PROVISORIA_PENDENTE',
        });
    }
    next();
}

// Bloqueia rotas normais quando o trial da associação já expirou (mantém
// dados preservados, só nega acesso). Usar logo depois de autenticar() em
// cada router, exceto em routes/plano.js (que precisa continuar funcionando
// pra associação conseguir contratar um plano e sair do bloqueio).
function bloquearTrialExpirado(req, res, next) {
    if (req.usuario && req.usuario.plano === 'trial' && req.usuario.trial_expira_em && new Date(req.usuario.trial_expira_em) < new Date()) {
        return res.status(403).json({
            erro: 'Seu período de avaliação terminou. Contrate um plano para continuar usando a plataforma.',
            codigo: 'TRIAL_EXPIRADO',
        });
    }
    next();
}

// Bloqueia rotas normais quando uma assinatura PAGA está vencida há mais de
// DIAS_TOLERANCIA_ASSINATURA_VENCIDA dias (auditoria de segurança Fase 3,
// 08/08/2026 -- SEC-015). Antes disso, uma associação em plano pago com a
// assinatura vencida continuava com acesso integral -- só o trial vencido
// bloqueava de fato. Mesmo raciocínio de bloquearTrialExpirado (mantém
// dados, só nega acesso); não usar em routes/plano.js, que precisa
// continuar funcionando pra associação regularizar e sair do bloqueio.
function bloquearAssinaturaVencida(req, res, next) {
    if (req.usuario && assinaturaBloqueadaPorVencimento(req.usuario.plano, req.usuario.vencimento_assinatura)) {
        return res.status(403).json({
            erro: 'Sua assinatura está vencida. Regularize o pagamento para continuar usando a plataforma.',
            codigo: 'ASSINATURA_VENCIDA',
        });
    }
    next();
}

// Bloqueia uma funcionalidade que exige um plano superior ao contratado
// (gating por plano, 29/07/2026 — ver painel/CLAUDE.md/backend/CLAUDE.md,
// seção "Gating de funcionalidades por plano"). Usar depois de autorizar()
// nas rotas que só devem funcionar a partir de um plano mínimo. Diferente
// de bloquearTrialExpirado: aqui a associação continua com acesso normal
// à plataforma, só essa funcionalidade específica fica indisponível.
// req.usuario.plano já vem sempre fresco do banco (ver autenticar() acima).
function exigirPlano(nivelMinimo) {
    return (req, res, next) => {
        if (!req.usuario || !planoAtendeNivel(req.usuario.plano, nivelMinimo)) {
            return res.status(403).json({
                erro: 'Esse recurso não está disponível no seu plano atual. Faça upgrade para continuar.',
                codigo: 'PLANO_INSUFICIENTE',
                plano_necessario: nivelMinimo,
            });
        }
        next();
    };
}

// Garante que só determinados papéis acessem a rota
// Uso: autorizar('admin', 'diretoria')
function autorizar(...papeisPermitidos) {
    return (req, res, next) => {
        if (!req.usuario || !papeisPermitidos.includes(req.usuario.papel)) {
            return res.status(403).json({ erro: 'Acesso não permitido para esse papel' });
        }
        next();
    };
}

// Pega uma conexão do pool e roda nela o SET de sessão que liga o isolamento
// (RLS). Se essa primeira query falhar, é quase sempre porque o pool entregou
// uma conexão que o Supabase já tinha derrubado por ociosidade -- o cliente só
// descobre que está morto ao usar. Nesse caso a conexão é destruída (para não
// voltar quebrada ao pool) e a operação é repetida uma vez com uma conexão nova.
//
// Isso era a causa de instabilidade: como toda rota faz
// `const client = await comConexaoX()` ANTES do try, um erro aqui virava
// rejeição não tratada -- e o Express 4 não converte isso em resposta, então a
// requisição ficava pendurada até o timeout do navegador, sem erro nenhum.
// (A rede de segurança para qualquer outro caso está em server.js.)
async function comConexaoComSessao(sqlSet, valores) {
    const MAX_TENTATIVAS = 3;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        const client = await pool.connect();
        try {
            await client.query(sqlSet, valores);
            return client; // lembrar de chamar client.release() depois de usar
        } catch (err) {
            // destroy() em vez de release(): a conexão está suspeita, não pode
            // voltar para o pool e derrubar a próxima requisição também.
            client.release(err);
            if (tentativa === MAX_TENTATIVAS) throw err;
            console.error('conexao do pool veio inutilizavel, tentando outra (tentativa ' + tentativa + '):', err.message);
            await aguardar(150 * tentativa);
        }
    }
}

// Uuid sentinela para "nenhum tenant nesta conexão". Não dá pra usar NULL:
// set_config(x, NULL, false) equivale a um RESET, e um GUC customizado
// resetado passa a devolver STRING VAZIA -- que é exatamente a causa raiz da
// instabilidade histórica (ver migration 20260807000000). Um uuid que nunca
// existe casta sem erro e não casa nenhuma linha, com ou sem aquela migration
// aplicada.
const TENANT_NENHUM = '00000000-0000-0000-0000-000000000000';

// TODA conexão precisa declarar as três flags, sempre -- não só a sua.
//
// Achado no QA de 07/08/2026: as flags são de SESSÃO (is_local = false) e o
// client.release() devolve a conexão pro pool SEM limpar nada. Como o pool
// reaproveita a mesma conexão física, uma requisição de super-admin deixava
// `app.superadmin_bypass = 'true'` grudado, e a PRÓXIMA requisição de tenant
// naquela conexão rodava com o bypass ligado -- ou seja, com o RLS
// efetivamente desligado. Confirmado na prática: tenant A enxergando os
// associados de B.
//
// Nunca virou vazamento de dado porque toda query da aplicação também filtra
// por `WHERE associacao_id = $1` na mão. Mas o RLS é justamente a camada que
// deveria segurar quando esse filtro faltar (ou for esquecido numa rota nova),
// e ela estava valendo só por sorte.
function sqlSessao({ tenant = TENANT_NENHUM, superadmin = false, auth = false }) {
    return {
        sql: `SELECT set_config('app.current_associacao_id', $1, false),
                     set_config('app.superadmin_bypass', $2, false),
                     set_config('app.auth_bypass', $3, false)`,
        valores: [tenant, superadmin ? 'true' : 'false', auth ? 'true' : 'false'],
    };
}

// Abre uma conexão dedicada do pool e ativa o isolamento por tenant (RLS).
// Necessário porque "SET" é por conexão, não pode usar pool.query direto
// quando o isolamento depende de estado de sessão.
async function comConexaoTenant(associacaoId) {
    if (!UUID_REGEX.test(associacaoId)) {
        throw new Error('associacaoId inválido');
    }
    const { sql, valores } = sqlSessao({ tenant: associacaoId });
    return comConexaoComSessao(sql, valores);
}

// Verifica o token de SUPER-ADMIN (separado do login das associações) e
// revalida ativo/papel contra o banco a cada requisição -- sem isso,
// desativar um administrador só valeria depois do token expirar (até 8h
// depois), mesmo raciocínio de autenticar() acima. super_admins não tem RLS,
// então pool.query direto é seguro aqui.
async function autenticarSuperAdmin(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const token = header.split(' ')[1];

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
        if (payload.tipo !== 'superadmin') {
            return res.status(403).json({ erro: 'Acesso restrito ao super-admin' });
        }
    } catch (err) {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }

    if (!payload.id || !UUID_REGEX.test(payload.id)) {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }

    // Mesma instabilidade transitória do pooler documentada em autenticar()
    // acima -- esta rota não tinha retry nenhum antes, apesar de mostrar a
    // mesma mensagem "Erro ao validar sessão" quando falhava.
    const MAX_TENTATIVAS = 3;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        try {
            // queryNeutra (não pool.query) desde SEC-016 -- super_admins não
            // tem RLS, mas o invariante "toda conexão declara as três flags"
            // vale sem exceção agora, sem ninguém precisar lembrar por quê.
            const resultado = await queryNeutra(
                `SELECT nome, papel, ativo, deve_trocar_senha, senha_alterada_em, sessoes_invalidas_antes_de
                 FROM super_admins WHERE id = $1`,
                [payload.id]
            );
            const admin = resultado.rows[0];
            if (!admin || !admin.ativo) {
                return res.status(401).json({ erro: 'Token inválido ou expirado' });
            }

            // Mesmo raciocínio (e mesmo cuidado de arredondamento) de
            // autenticar() acima: token emitido antes da última troca de
            // senha não vale mais.
            if (tokenInvalidadoPor(payload, admin.senha_alterada_em) || tokenInvalidadoPor(payload, admin.sessoes_invalidas_antes_de)) {
                return res.status(401).json({ erro: 'Token inválido ou expirado' });
            }

            // { id, email, tipo, papel, nome } -- papel/nome vêm frescos do banco,
            // não do token, para uma troca de nível de permissão valer na hora.
            req.superAdmin = { ...payload, papel: admin.papel, nome: admin.nome };

            // Senha provisória pendente bloqueia tudo, menos a própria troca de
            // senha -- equivalente ao bloquearSenhaProvisoria dos usuários comuns.
            // Sem isso, a senha provisória (mostrada uma vez e repassada por fora,
            // por WhatsApp/e-mail) valia pra sempre via chamada direta à API, já
            // que só o front-end pedia a troca.
            if (admin.deve_trocar_senha && !(req.method === 'PUT' && req.path === '/perfil/senha')) {
                return res.status(403).json({
                    erro: 'Você precisa definir uma nova senha antes de continuar',
                    codigo: 'SENHA_PROVISORIA_PENDENTE',
                });
            }

            return next();
        } catch (err) {
            if (tentativa === MAX_TENTATIVAS) {
                console.error(err);
                return res.status(500).json({ erro: 'Erro ao validar sessão' });
            }
            console.error('autenticarSuperAdmin: tentativa ' + tentativa + ' falhou, tentando de novo:', err.message);
            await aguardar(150 * tentativa);
        }
    }
}

// Restringe rotas de gerenciamento de administradores a determinados níveis
// de permissão. Uso: autorizarSuperAdmin('super_admin')
function autorizarSuperAdmin(...papeisPermitidos) {
    return (req, res, next) => {
        if (!req.superAdmin || !papeisPermitidos.includes(req.superAdmin.papel)) {
            return res.status(403).json({ erro: 'Acesso não permitido para esse nível de permissão' });
        }
        next();
    };
}

// Abre uma conexão dedicada com o bypass explícito de RLS para o super-admin.
// Usada nas rotas de routes/superadmin.js, que legitimamente precisam ver
// dados de todas as associações. A flag só é setada aqui, nunca a partir de
// input do usuário — é isso que torna o bypass seguro.
async function comConexaoSuperAdmin() {
    const { sql, valores } = sqlSessao({ superadmin: true });
    return comConexaoComSessao(sql, valores);
}

// Abre uma conexão dedicada com bypass para os fluxos públicos de
// autenticação (login por e-mail, redefinição de senha por token) — os
// únicos pontos que legitimamente precisam ler usuarios/associacoes antes
// de saber a qual tenant a requisição pertence (é isso que estão
// descobrindo). Mesmo princípio de segurança do comConexaoSuperAdmin: a
// flag nunca vem de input do usuário, só é setada por este código.
async function comConexaoAuth() {
    const { sql, valores } = sqlSessao({ auth: true });
    return comConexaoComSessao(sql, valores);
}

// Abre uma conexão SEM tenant e SEM nenhum bypass -- as três flags zeradas.
// Para queries que legitimamente não pertencem a tenant nenhum: `super_admins`
// (tabela sem RLS), leitura de `configuracoes_plataforma` (policy `USING
// (true)`) e a gravação dos logs (`WITH CHECK (true)`).
//
// Auditoria de segurança Fase 4, 08/08/2026 (SEC-016): esses pontos usavam
// `pool.query()` direto, que **não passa pelo sqlSessao()** -- ou seja,
// rodavam com o GUC que a requisição anterior tivesse deixado na conexão
// física (o pool reaproveita, e `release()` não limpa nada). Nunca houve
// risco real, porque nenhuma dessas queries toca tabela com isolamento por
// tenant. Mas o invariante "toda conexão declara as três flags" tinha esse
// furo, e uma rota nova que usasse `pool.query` numa tabela de tenant
// herdaria estado alheio -- exatamente a classe de bug do incidente de
// 07/08 (ver seção "RLS estava desligado na prática" no CLAUDE.md).
async function comConexaoSemTenant() {
    const { sql, valores } = sqlSessao({});
    return comConexaoComSessao(sql, valores);
}

// Mesma assinatura de `pool.query(sql, valores)`, mas numa conexão com as
// flags zeradas -- e cuidando do release sozinha. É o que permite a troca
// nos ~20 pontos ser um rename mecânico (`pool.query(` ->
// `conexaoNeutra.query(`), sem reestruturar try/finally em cada um, que é
// justamente onde uma conversão manual vazaria conexão.
async function queryNeutra(sql, valores) {
    const client = await comConexaoSemTenant();
    try {
        return await client.query(sql, valores);
    } finally {
        client.release();
    }
}

// Objeto com a mesma forma de um client do pg (só `.query`), pra poder ser
// passado onde os helpers de log esperam receber uma conexão
// (registrarLogAuditoria/registrarEventoAuth).
const conexaoNeutra = { query: queryNeutra };

module.exports = {
    autenticar,
    bloquearSenhaProvisoria,
    bloquearTrialExpirado,
    bloquearAssinaturaVencida,
    exigirPlano,
    autorizar,
    comConexaoTenant,
    autenticarSuperAdmin,
    autorizarSuperAdmin,
    comConexaoSuperAdmin,
    comConexaoAuth,
    comConexaoSemTenant,
    conexaoNeutra,
};
