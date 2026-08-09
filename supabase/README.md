# Migrations do Supabase

Esta pasta versiona o schema PostgreSQL usado pela API. Não há ferramenta de
migração automatizada — cada arquivo é aplicado manualmente, uma vez, na
ordem do timestamp do nome.

## Migrations existentes (ordem de aplicação)

1. `20260722000000_baseline_schema.sql` — retrato do banco em 22/07/2026.
   **Não execute em produção** (as tabelas já existem).
2. `20260723000000_login_por_email.sql` — login por e-mail globalmente
   único (em vez de código/ID da associação), `deve_trocar_senha`,
   `auth_logs`.
3. `20260724000000_rls_policies.sql` — completa as policies de RLS que
   faltavam (`associacoes` e `password_resets` tinham RLS ligado e nenhuma
   policy — inacessíveis para qualquer role não-dona). **Aditiva, sem
   `FORCE`** — segura de rodar mesmo com o backend ainda conectado como
   dono das tabelas.
4. `20260724000100_force_rls.sql` — `FORCE ROW LEVEL SECURITY`. **Só
   aplicar depois** que o backend em produção já estiver conectando como a
   role `app_runtime` (não-dona) — ver aviso abaixo.
5. `20260724000200_revogar_acesso_publico_supabase.sql` — revoga os grants
   padrão do Supabase (`anon`/`authenticated`) em todas as tabelas.
6. `20260724000300_fix_comunicados.sql` — colunas `destaque`/`status` e a
   tabela `comunicado_leituras` que a rota de comunicados sempre esperou
   mas nunca existiram.

## ⚠️ RLS e FORCE ROW LEVEL SECURITY — leia antes de mexer

O schema tem policies de isolamento por `associacao_id` em todas as tabelas
de tenant, e elas **estão de fato ativas** — o backend conecta como
`app_runtime`, uma role que não é dona das tabelas (o dono é `postgres`,
usado só para rodar migrações). Roles não-donas já ficam sujeitas a RLS
automaticamente, mesmo sem `FORCE`; o `FORCE` (já aplicado) é só a camada
extra caso alguém volte a conectar como `postgres` no futuro.

**Isso já quebrou produção uma vez.** Uma tentativa anterior de `FORCE ROW
LEVEL SECURITY` foi feita com o backend **ainda conectado como `postgres`
(dono)** — como o dono ignora RLS a menos que `FORCE` esteja ligado, isso
ativou a restrição de repente bem na conexão de produção, e como o código
de login não setava nenhuma variável de sessão de tenant, ninguém
conseguia mais logar. Foi revertido às pressas com
`ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`.

**Se for mexer em RLS de novo, sempre nessa ordem:**
1. Criar/testar a role de aplicação sem privilégio de dono (`app_runtime`
   já existe — reveja `CREATE ROLE`/`GRANT` antes de recriar).
2. Atualizar o código para usar essa role e setar as variáveis de sessão
   certas (`comConexaoTenant`, `comConexaoSuperAdmin`, `comConexaoAuth` em
   `middleware/auth.js`).
3. Trocar `DATABASE_URL` em produção para a nova role.
4. Confirmar que tudo funciona (login, CRUD, isolamento entre dois tenants
   de teste).
5. **Só então** rodar `FORCE ROW LEVEL SECURITY`, se ainda não estiver.

Nunca aplicar `FORCE` num passo isolado sem ter certeza de qual role a
produção está usando naquele momento.

## Grants do Supabase

**Achado real, confirmado montando o ambiente de staging do zero
(27/07/2026): não confie no `ALTER DEFAULT PRIVILEGES` da migration 5 pra
revogar `anon`/`authenticated` em tabelas novas.** Na teoria ele deveria
cobrir qualquer tabela criada depois dele pela role `postgres`; na prática,
rodando todas as migrations em sequência num projeto novo, as tabelas
criadas nas migrations posteriores (`atividades`, `logs_auditoria`,
`solicitacoes_plano`, `configuracoes_plataforma`, `sprint_itens`) saíram
com `anon`/`authenticated` tendo acesso total mesmo assim — o Supabase
parece reconceder acesso padrão em tabela nova por conta própria,
independente desse `ALTER DEFAULT PRIVILEGES`. **Sempre rode o `REVOKE`
abaixo de novo depois de criar qualquer tabela nova** (aditivo, seguro
rodar quantas vezes quiser, mesmo se já não houver nada pra revogar):

```sql
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM anon, authenticated;
```

Tabelas novas herdam automaticamente `GRANT` para `app_runtime`
(configurado via `ALTER DEFAULT PRIVILEGES` na criação da role — esse lado
funcionou certo no teste de staging, só o de `anon`/`authenticated` que
não). Ainda assim, **confira explicitamente** depois de criar uma tabela
nova — não confie cegamente no default:

```sql
SELECT grantee, string_agg(privilege_type, ',') 
FROM information_schema.role_table_grants
WHERE table_name = 'nome_da_tabela_nova'
GROUP BY grantee;
```

`app_runtime` deve aparecer com `SELECT,INSERT,UPDATE,DELETE`;
`anon`/`authenticated` não devem aparecer.

## Ambiente de homologação (staging) — novo (27/07/2026)

Passou a existir um segundo projeto Supabase, vazio e isolado do de
produção, usado só para testar migrations/mudanças de RLS antes de aplicar
em produção de verdade. Pra recriar o schema nele do zero:

1. Criar a role `app_runtime` primeiro — **não está em nenhum arquivo desta
   pasta**, porque a criação original em produção nunca foi versionada (uma
   lacuna real, não só falta de vontade). Script reconstruído a partir dos
   grants documentados abaixo, entregue à parte (fora do controle de
   versão, porque contém a senha da role).
2. Rodar todos os arquivos desta pasta em ordem cronológica (nome do
   arquivo já é a ordem). Isso inclui `20260722000000_baseline_schema.sql`
   — o aviso "não execute em produção" vale só pra produção, que já tinha
   essas tabelas; num projeto novo e vazio, esse arquivo faz parte do
   schema inteiro.
3. Conferir os grants de `app_runtime` (query no fim deste arquivo).
4. Rodar `POST /superadmin/bootstrap` (ver `routes/superadmin.js`) contra o
   backend de staging pra criar o primeiro super-admin desse ambiente —
   com `BOOTSTRAP_SECRET` próprio de staging, diferente do de produção.

**⚠️ Armadilha real, descoberta montando o staging em 27/07/2026: NÃO cole
todas as migrations de uma vez só numa única query no SQL Editor do
Supabase.** Rodamos um arquivo único concatenando as 12 migrations em
ordem (pensado só pra economizar cliques) e o editor mostrou "Success" —
mas na prática **só a primeira migration (`baseline_schema.sql`) foi
aplicada de verdade**; as outras 11 foram silenciosamente ignoradas, sem
nenhum erro visível. Só percebemos porque o login do super-admin quebrou
depois (coluna `papel` inexistente) e, ao listar as tabelas de fato
criadas, só as 8 do baseline apareciam. A suspeita é que o aviso "This
query creates tables without enabling Row Level Security" (que aparece
quando a query tem `CREATE TABLE` sem `ENABLE ROW LEVEL SECURITY` na
mesma instrução) interrompe a execução do restante do script ao ser
resolvido, mesmo escolhendo "Run without RLS". **A forma seguem é rodar
cada arquivo de migration separadamente, um de cada vez, conferindo
"Success" antes de ir pro próximo** — exatamente como a lista acima já
recomendava antes desse achado, só que agora sabemos por quê é obrigatório
e não só uma boa prática.

**Outra lacuna real encontrada no mesmo processo**: as colunas
`cidade`/`estado` de `associacoes` (usadas em `routes/superadmin.js` desde
a reforma de 24/07/2026) nunca tinham migration nenhuma — foram
adicionadas direto em produção, fora do controle de versão, e só
apareceram como erro (`column a.cidade does not exist`) ao recriar o
schema do zero. Corrigido em
`20260727120000_cidade_estado_associacoes.sql`. **Isso é o segundo caso
desse tipo** (o primeiro foi a role `app_runtime`) — um lembrete de que
o schema real de produção pode ter mudanças pontuais feitas direto no SQL
Editor que nunca viraram migration versionada. Se aparecer um terceiro
caso, vale considerar rodar um dump de schema (`pg_dump --schema-only`) de
produção pra comparar com o que está nesta pasta, em vez de só confiar que
está tudo capturado aqui.

Staging e produção **nunca compartilham role, senha, `JWT_SECRET` ou
`BOOTSTRAP_SECRET`** — são projetos totalmente independentes, só o *schema*
é o mesmo.

## Conferência de drift: comparar produção com staging (08/08/2026)

O terceiro caso de drift previsto na seção acima apareceu, e a conferência
foi feita — **sem `pg_dump`**. Em vez de reconstruir o "esperado" parseando
os `.sql` (frágil) ou instalar ferramenta nova, rodar a **mesma** query de
inventário nos dois projetos e comparar os hashes. Staging foi montado a
partir desta pasta, então divergência = drift.

Saída de 5 linhas, o que contorna o limite de 100 linhas do SQL Editor:

```sql
WITH inventario AS (
  SELECT 'COLUNA ' || c.table_name || '.' || c.column_name || ' ' || c.data_type
         || CASE WHEN c.is_nullable = 'NO' THEN ' NOTNULL' ELSE '' END
         || COALESCE(' DEFAULT ' || c.column_default, '') AS item
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
  UNION ALL
  SELECT 'POLICY ' || tablename || '.' || policyname || ' ' || cmd FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  SELECT 'INDICE ' || tablename || '.' || indexname FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'ENUM ' || t.typname || '.' || e.enumlabel
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
  UNION ALL
  SELECT 'RLS ' || c.relname || ' enabled=' || c.relrowsecurity::text || ' forced=' || c.relforcerowsecurity::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
)
SELECT split_part(item, ' ', 1) AS categoria, COUNT(*) AS itens,
       md5(string_agg(item, E'\n' ORDER BY item)) AS hash
FROM inventario GROUP BY 1 ORDER BY 1;
```

Quando um hash diverge, faça o drill-down só daquela categoria (hash por
tabela para `COLUNA`, listagem direta para `RLS`, que são poucas linhas).

**O que essa conferência achou, e vale saber antes da próxima:**

1. **`enabled=false` com `forced=true` é RLS DESLIGADO.** `FORCE` não faz
   nada sem `ENABLE`. Staging estava assim em `usuarios`, `comunicados`,
   `pagamentos` e `password_resets` — policies existindo e nunca aplicadas,
   o que silenciosamente esvaziava todo teste de isolamento feito lá nessas
   tabelas. Produção estava correta. Corrigido com `ENABLE ROW LEVEL
   SECURITY` nas 4.
2. **Não trate staging como referência sem checar o RLS antes** — foi essa
   suposição que quase fez o diagnóstico concluir que o problema era em
   produção.
3. A única divergência de schema real era `associacoes.cidade` (`text` em
   produção, `varchar` na migration). Sem impacto — no PostgreSQL os dois
   são o mesmo tipo na prática. O arquivo da migration foi corrigido pra
   descrever o que produção tem.

## Antes de aplicar uma migration em produção

1. Faça backup do banco no Supabase (ou ao menos confirme que a mudança é
   aditiva/reversível).
2. Revise o SQL — não há ambiente de staging separado, o banco de
   desenvolvimento e o de produção são o mesmo.
3. Execute via SQL Editor do Supabase, ou por um script Node avulso usando
   a `DATABASE_URL` do dono (`postgres`) — não commitar esse script.
4. Depois de aplicar, registre o commit correspondente no Git.
