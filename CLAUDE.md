# CLAUDE.md — backend

Contexto rápido para sessões de IA trabalhando neste repositório. Para o
quadro completo (rotas, modelo de dados, roadmap), ver `README.md`. Para
tudo sobre migrações e RLS, ver `supabase/README.md`.

## O que é

API multi-tenant (Node/Express + Postgres/Supabase) para gestão de
associações — Super Admin cadastra associações-clientes, cada uma com seu
admin/diretoria/associados isolados das outras. Front-end em
`../painel` (HTML/JS puro, repositório separado), consome essa API.

## Regra mais importante deste repositório

**O banco de produção (Supabase) é o mesmo banco que o desenvolvimento
local usa — não existe staging separado.** Qualquer migração/teste local
com um `DATABASE_URL` real afeta produção diretamente. Migrações
aditivas (novas tabelas/colunas/policies sem `FORCE`) são seguras a
qualquer momento; mudanças que afetam quem já está conectado (trocar
`DATABASE_URL` em produção, `FORCE ROW LEVEL SECURITY`) precisam ser
coordenadas com o deploy — ver `supabase/README.md`, seção RLS, que
documenta um incidente real causado por não seguir essa ordem.

## Arquitetura em uma imagem

- `server.js` → monta as rotas, `config/env.js` valida env vars e derruba
  o processo se algo obrigatório faltar em produção
- `db.js` → pool de conexão, usa a role `app_runtime` (não-dona das
  tabelas) e valida o certificado SSL do Supabase de verdade
  (`config/supabase-ca.pem`)
- `middleware/auth.js` → `autenticar` (valida JWT + revalida contra o
  banco a cada request), `autorizar(papeis...)`, e os helpers de conexão
  com bypass de RLS: `comConexaoTenant` (isolamento normal),
  `comConexaoSuperAdmin` (bypass para rotas do super-admin),
  `comConexaoAuth` (bypass só para login/redefinição de senha, que
  legitimamente não sabem o tenant de antemão)
- `routes/*.js` → uma rota por recurso, todas usando um dos helpers acima
  para tocar o banco (nunca `pool.query` direto em tabela com RLS, exceto
  `super_admins`, que não tem RLS)
- `supabase/migrations/*.sql` → schema, aplicado manualmente (sem
  ferramenta automatizada) — ver `supabase/README.md`

## Isolamento entre tenants (RLS) — já está ativo

Não é só disciplina de código (`WHERE associacao_id = $1` em toda query,
que também existe) — o Postgres recusa fisicamente misturar dados entre
associações, porque `app_runtime` não é dona das tabelas e as policies
estão com `FORCE ROW LEVEL SECURITY`. Testado em produção: dois tenants
de teste, admin de um não conseguia ver dado do outro.

## Convenções

- Sem framework de teste automatizado — verificação é feita rodando o
  servidor local (`node server.js`) e testando fluxos reais via
  `fetch`/API, geralmente contra o mesmo banco de produção (é seguro
  desde que os dados de teste sejam limpos depois — sempre limpar).
- Front-end sem build step — `painel/index.html` e `painel/superadmin.html`
  são editados direto, `API_URL` no topo do `<script>` aponta para
  produção; ao testar localmente contra `localhost:3000`, lembrar de
  reverter antes de commitar.
- Commits em português, imperativo, sem prefixo tipo `feat:`/`fix:`.
- Segredos (senhas de role, `JWT_SECRET`, etc.) nunca em arquivo
  versionado — só em `.env` (git-ignored) ou entregues ao usuário uma
  única vez no chat, nunca reescritos em commits/migrations.

## Variáveis de ambiente obrigatórias em produção

`DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS` — servidor derruba na
inicialização se faltar alguma (ver `config/env.js`). `BOOTSTRAP_SECRET`
é opcional (rota de bootstrap fica bloqueada por padrão sem ela).
