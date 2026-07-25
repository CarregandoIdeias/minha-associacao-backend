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
  ver seção "Instabilidade intermitente" abaixo), `idleTimeoutMillis:
  30000` (30s, acima do padrão de 10s do `pg`, pra reduzir reconexões "a
  frio") e `max: config.poolMax` (env `DB_POOL_MAX`, default 10 — ver
  seção "Auditoria de escala" abaixo sobre por que isso multiplica por
  instância ao escalar horizontalmente)
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
- `utils/atividadeLog.js` (novo, 25/07/2026) → `registrarAtividade()`,
  espelha `authLog.js`, grava na tabela `atividades` (log de quem fez o
  quê no painel da associação — não confundir com `auth_logs`, que é só
  login/logout/troca de senha)

## Super Admin — mudanças recentes (24/07/2026)

Reformulação completa trazendo conceitos de SaaS multi-tenant real:

- **Novo:** campos de plano/cobrança em `associacoes`: `plano` (enum trial/basico/profissional/enterprise), `valor_mensalidade_manual` (override de negociação), `vencimento_assinatura` (data), `forma_cobranca` (método), `cep`, `site`. Nova coluna em `usuarios`: `cpf`.
- **Novo:** `GET /superadmin/dashboard` retorna muito mais — KPIs com MRR, gráficos de crescimento/receita/distribuição (12 meses), alertas gerados por regras (vencimentos, clientes novos, mensalidades atrasadas).
- **Modificado:** `GET /superadmin/associacoes` agora retorna `valor_mensalidade` calculado + `status_assinatura` derivado (bloqueada/trial/vencida/vencendo/ativa), coluna de responsável (nome do admin), CPF.
- **Modificado:** `POST/PUT /superadmin/associacoes/:id` aceitam os novos campos.
- **Novo:** `utils/precos.js` com `calcularValorMensalidade()` (base + per-associate) e `statusAssinatura()` (derivado, nunca armazenado).

Esses valores de preço em `PRECOS_PLANO` são placeholders — revisar com o usuário (Julião) antes de considerar definitivos. Migration `20260724100000_plano_e_dados_associacao.sql` foi aditiva (todas colunas nullable, segura).

## Log de atividades para o Dashboard do painel da associação (25/07/2026)

Nova tabela `atividades` (`supabase/migrations/20260725120000_atividades.sql`,
aditiva, já nasce com `FORCE ROW LEVEL SECURITY` — tabela nova, sem ninguém
dependendo do comportamento sem RLS, então não tem o risco de deploy que
`FORCE` tem em tabela existente, ver seção RLS abaixo) alimenta o card
"Atividades recentes" do Dashboard reformado em `painel/index.html`.

- `utils/atividadeLog.js` (`registrarAtividade`) é chamado logo após o
  insert/update principal em: `POST/PUT /associados`, `PATCH
  /cobrancas/:id/pagar`, `POST /comunicados`, `POST /usuarios`. Cada
  chamada grava `descricao` já pronta em texto (ex. "cadastrou o associado
  Fulano") — não guarda um monte de campos estruturados pra montar a frase
  depois, é `usuario_nome` (snapshot) + `descricao` (texto).
- `middleware/auth.js` (`autenticar`) passou a buscar `u.nome` junto com
  `papel` na revalidação por request e anexar em `req.usuario.nome` —
  antes só existia `id/associacao_id/papel/email/deve_trocar_senha` (do
  JWT). Precisa disso pra saber "quem" registrar em cada atividade sem uma
  query extra em cada rota.
- Nova rota `GET /atividades` (`routes/atividades.js`, admin/diretoria):
  últimas ~15 da associação, mais recente primeiro.
- `GET /cobrancas` ganhou `p.pago_em` (LEFT JOIN `pagamentos`) — usado pelo
  Dashboard pra separar "Receitas" (por mês de vencimento) de "Pagamentos
  recebidos" (por mês de recebimento real) no gráfico de receita mensal.

**Migrations continuam só manuais, e por um motivo mais forte do que
"falta de tooling"**: a `DATABASE_URL` (local e produção) conecta como
`app_runtime`, que **não tem privilégio de DDL** (só
`SELECT/INSERT/UPDATE/DELETE`, por desenho). Um script Node local usando
`db.js` pra rodar uma migration nova falha com `permission denied for
schema public` — precisa colar o SQL no SQL Editor do Supabase (dono
`postgres`), como `supabase/README.md` já orienta.

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

## Auditoria de escala (25/07/2026)

Segunda rodada de auditoria, diferente da de 24/07 (focada em
vulnerabilidades críticas) — essa foi motivada pelo usuário querer escalar
para mais associações-cliente e pedir que não haja falhas, nem de
aplicação nem de segurança. Achados corrigidos (commits `8040bbf` e
`1dfe16a`):

- **`trust proxy` ausente** — o Render fica na frente do app como proxy
  reverso (1 hop). Sem `app.set('trust proxy', 1)` em `server.js`, o
  `express-rate-limit` via o IP interno do proxy pra todo mundo, ou seja,
  o limite de tentativas de login (`limiteLogin`, 10/15min) era
  **compartilhado entre todos os clientes** em vez de por IP de verdade —
  um usuário errando a senha algumas vezes podia bloquear o login de
  todo mundo. Corrigido.
- **Pool sem tamanho explícito** — `db.js` usava o padrão implícito de 10
  conexões do `pg`. Agora é `max: config.poolMax` (env `DB_POOL_MAX`,
  default 10, sem mudar nada hoje). Importante pra quando for escalar:
  **toda rota usa uma conexão dedicada do pool** (`pool.connect()` via
  `comConexaoTenant`/`comConexaoSuperAdmin`/`comConexaoAuth`), nunca
  `pool.query()`, porque o isolamento por RLS depende de `SET` de sessão
  (por conexão). Isso significa que escalar para N instâncias no Render
  multiplica o total de conexões no Session Pooler do Supabase por
  `N × DB_POOL_MAX` — **conferir o limite de conexões do plano do
  Supabase antes de aumentar o número de instâncias**, senão o sintoma na
  hora do pico é erro de "too many connections" batendo em vários
  clientes ao mesmo tempo.
- **Rate limit geral** (`limiteGeral`, 300 req/15min por IP, em
  `middleware/rateLimiter.js`) aplicado a toda a API em `server.js`,
  antes de `express.json()` de propósito (rejeita rajada antes de gastar
  tempo com parse de corpo grande). Antes só login/redefinição de senha
  tinham algum limite — o resto das ~25 rotas (incluindo
  `/auth/esqueci-senha`, pública) não tinha proteção nenhuma contra
  rajadas.
- **bcrypt fora da conexão emprestada do pool** — `bcrypt.hash`/`compare`
  é deliberadamente lento (~50-100ms de CPU) e antes rodava com uma
  conexão do pool já emprestada (às vezes com transação aberta via
  `BEGIN`), segurando-a mais tempo que o necessário sob carga
  concorrente. Movido para antes de abrir a conexão em:
  `POST /associados`, `POST /usuarios`, `POST /superadmin/associacoes`,
  `PATCH /superadmin/associacoes/:id/resetar-senha-admin`,
  `POST /auth/redefinir-senha` (senha nova é gerada/hasheada sem
  depender do token ser válido). `PUT /auth/senha` é o único caso que
  precisa mesmo ler o hash atual do banco antes de poder comparar — ali
  a solução foi usar **duas conexões separadas** (lê e libera, depois
  compara/hasheia, depois abre outra pra escrever).

Testado localmente contra produção (associação + usuário de teste criados
via `pool.connect()` + `set_config('app.superadmin_bypass', ...)`, todos
os fluxos afetados testados via `curl`, depois removidos com `DELETE FROM
associacoes WHERE nome = 'TESTE_AUDITORIA_TEMP'`) antes do deploy.

**Pendências identificadas, prioridade menor** (não implementadas ainda):
sem `helmet`/cabeçalhos de segurança (`X-Powered-By: Express` vazando);
sem paginação em `/associados`/`/cobrancas`; toda requisição autenticada
faz uma query extra pra revalidar o token (dá pra cachear em memória por
poucos segundos sem perder a revogação quase-imediata); fotos/comprovantes
em base64 dentro do Postgres (`foto_base64`, `comprovante_base64`,
`logo_base64`) — migrar pra Supabase Storage/S3 evita dor ao crescer.

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
`DB_POOL_MAX` também é opcional (default 10) — ver seção "Auditoria de
escala" acima antes de mudar ao escalar para mais instâncias.
