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
  (`config/supabase-ca.pem`). Tem `pool.on('error', ...)` (obrigatório —
  ver seção "Instabilidade intermitente" abaixo) e `idleTimeoutMillis:
  30000` (30s, acima do padrão de 10s do `pg`, pra reduzir reconexões "a
  frio")
- `middleware/auth.js` → `autenticar` (valida JWT + revalida contra o
  banco a cada request, com guarda de UUID e retry — ver seção
  "Instabilidade intermitente"), `autorizar(papeis...)`, e os helpers de
  conexão com bypass de RLS: `comConexaoTenant` (isolamento normal),
  `comConexaoSuperAdmin` (bypass para rotas do super-admin),
  `comConexaoAuth` (bypass só para login/redefinição de senha, que
  legitimamente não sabem o tenant de antemão)
- `routes/*.js` → uma rota por recurso, todas usando um dos helpers acima
  para tocar o banco (nunca `pool.query` direto em tabela com RLS, exceto
  `super_admins`, que não tem RLS)
- `supabase/migrations/*.sql` → schema, aplicado manualmente (sem
  ferramenta automatizada) — ver `supabase/README.md`
- `utils/precos.js` (novo, 24/07/2026) → tabela de preços por plano e
  cálculo de MRR (receita mensal recorrente), reutilizado por todas as
  rotas que precisam calcular valor da mensalidade

## Super Admin — mudanças recentes (24/07/2026)

Reformulação completa trazendo conceitos de SaaS multi-tenant real:

- **Novo:** campos de plano/cobrança em `associacoes`: `plano` (enum trial/basico/profissional/enterprise), `valor_mensalidade_manual` (override de negociação), `vencimento_assinatura` (data), `forma_cobranca` (método), `cep`, `site`. Nova coluna em `usuarios`: `cpf`.
- **Novo:** `GET /superadmin/dashboard` retorna muito mais — KPIs com MRR, gráficos de crescimento/receita/distribuição (12 meses), alertas gerados por regras (vencimentos, clientes novos, mensalidades atrasadas).
- **Modificado:** `GET /superadmin/associacoes` agora retorna `valor_mensalidade` calculado + `status_assinatura` derivado (bloqueada/trial/vencida/vencendo/ativa), coluna de responsável (nome do admin), CPF.
- **Modificado:** `POST/PUT /superadmin/associacoes/:id` aceitam os novos campos.
- **Novo:** `utils/precos.js` com `calcularValorMensalidade()` (base + per-associate) e `statusAssinatura()` (derivado, nunca armazenado).

Esses valores de preço em `PRECOS_PLANO` são placeholders — revisar com o usuário (Julião) antes de considerar definitivos. Migration `20260724100000_plano_e_dados_associacao.sql` foi aditiva (todas colunas nullable, segura).

## Conexão com o banco — usar sempre o Session Pooler do Supabase (25/07/2026)

`DATABASE_URL` **precisa** apontar para o Session Pooler do Supabase
(`aws-1-sa-east-1.pooler.supabase.com:5432`, não a conexão direta
`db.<projeto>.supabase.co:5432`). Motivo: a conexão direta do Supabase
exige IPv6, e o Render **não suporta IPv6 de saída** — trocar para a
conexão direta derruba o serviço inteiro (502 em todas as rotas). Isso já
aconteceu nesta sessão (trocado por engano achando que corrigiria um bug,
revertido em minutos). Se for mexer nessa variável de novo: confirmar
antes que o ambiente de destino suporta IPv6, ou usar sempre o pooler.

## Instabilidade intermitente conhecida, ainda não resolvida (25/07/2026)

De vez em quando (mais depois de reconexões "a frio", ex. após um período
ocioso), `autenticar()` e a query de login do backend recebem do Postgres
`invalid input syntax for type uuid: ""` (`code: 22P02`) — inclusive em
consultas que **não têm nenhum parâmetro uuid** (a query de login só
compara e-mail). Isso é evidência forte de que é a resposta de **outra**
query concorrente vazando pela conexão (algo do lado do pooler do
Supabase, Session Pooler confirmado — não é bug óbvio no nosso código).
Não foi possível reproduzir de forma controlada (nem com 225+ chamadas
concorrentes simuladas direto contra o pooler).

**Mitigações já aplicadas** (não resolvem a causa raiz, deixam o sistema
se recuperar sozinho na maioria dos casos):
- `db.js`: `pool.on('error', ...)` — sem isso, um cliente ocioso derrubado
  pelo Supabase gerava um evento `'error'` não tratado que **derrubava o
  processo Node inteiro**, causando 500 em rajada em várias rotas ao mesmo
  tempo até o Render reiniciar sozinho. Esse era o bug mais grave e está
  corrigido.
- `middleware/auth.js` (`autenticar`): guarda de UUID antes de consultar
  (`payload.id` inválido → 401 limpo, não 500) + retry de uma tentativa
  com conexão nova antes de desistir.
- `routes/auth.js` (`buscarUsuarioPorEmail`, usado por `POST
  /auth/login`): mesmo retry de uma tentativa.

**Se voltar a acontecer em uso real** (não sob teste de carga pesado — ver
nota de cuidado abaixo): registrar o erro exato do log do Render com
horário e considerar abrir chamado com o suporte do Supabase citando esse
erro (`22P02`, `string_to_uuid`, parâmetro vazio em query sem parâmetro
uuid).

**Cuidado ao investigar**: testes de diagnóstico pesados (dezenas/centenas
de conexões em sequência rápida) contra a produção podem eles mesmos
causar ou piorar a instabilidade, possivelmente por esgotar conexões do
pooler — isso aconteceu nesta sessão. Preferir testes leves (uma
requisição de cada vez, espaçadas) ao investigar esse sintoma
especificamente.

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
- **`JWT_SECRET` do `.env` local é diferente do valor configurado no
  Render** (confirmado 25/07/2026) — um token assinado localmente (ex.
  rodando `node server.js` local e chamando `/auth/login` local) **não é
  aceito em produção** (dá 401 "Token inválido"). Pra testar contra
  produção de verdade, logar de fato via `/auth/login` de produção (ou
  pegar o token real do `localStorage` do navegador do usuário) — não dá
  pra forjar um token localmente e usar em produção.

## Variáveis de ambiente obrigatórias em produção

`DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS` — servidor derruba na
inicialização se faltar alguma (ver `config/env.js`). `BOOTSTRAP_SECRET`
é opcional (rota de bootstrap fica bloqueada por padrão sem ela).
