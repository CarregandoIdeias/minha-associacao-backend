-- O Supabase cria automaticamente os papéis `anon` e `authenticated` (usados
-- pela API pública/PostgREST dele) e concede acesso total a eles em toda
-- tabela nova por padrão — contando que RLS é quem restringe. Esta aplicação
-- não usa a API/Auth do Supabase, só o Postgres por trás via um backend
-- Node próprio (roles `postgres` e `app_runtime`). Esses dois papéis nunca
-- deveriam ter acesso nenhum aqui.
--
-- Isso importava pouco enquanto RLS estava ligado em tudo (sem policy
-- batendo, anon/authenticated não viam nada) — mas em super_admins, que tem
-- RLS desligado de propósito (não tem coluna de tenant para isolar), esse
-- grant padrão do Supabase virava uma porta real: qualquer um com a chave
-- pública "anon" do projeto conseguia ler/gravar a tabela direto pela API
-- do Supabase, sem passar pelo backend.

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM anon, authenticated;

-- Garante que tabelas criadas por migrações futuras também não saiam com
-- esse acesso por padrão.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;
