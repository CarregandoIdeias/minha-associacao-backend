-- ============================================================================
-- CAUSA RAIZ da "instabilidade intermitente do pooler" (aberta desde 26/07/2026)
-- ============================================================================
--
-- Sintoma: de tempos em tempos, uma requisição qualquer falhava com
--   ERROR 22P02: invalid input syntax for type uuid: ""
-- inclusive em queries que não tinham nenhum parâmetro uuid. O CLAUDE.md
-- registrava isso como "causa exata ainda não confirmada", com a suspeita de
-- que o Session Pooler estivesse deixando a resposta de uma query vazar para
-- outra conexão. Não era isso.
--
-- A causa real, reproduzida de forma limpa em 07/08/2026:
--
--   1. Conexão nova: current_setting('app.current_associacao_id', true) -> NULL
--   2. Depois de set_config(...) com um uuid: -> o uuid
--   3. Depois de RESET ALL / DISCARD ALL:      -> '' (STRING VAZIA, não NULL)
--   4. E aí ''::uuid estoura com exatamente o 22P02 acima.
--
-- O passo 3 é o pulo do gato: no Postgres, um GUC customizado que já foi
-- setado na sessão e depois resetado NÃO volta a ser "inexistente" -- ele passa
-- a devolver string vazia. E RESET ALL/DISCARD ALL é justamente o que o
-- PgBouncer roda ao devolver uma conexão física para o pool.
--
-- Ou seja: toda policy abaixo que fazia `current_setting(...)::uuid` estourava
-- sempre que a conexão emprestada pelo pooler já tinha sido usada antes por
-- alguém que setou o tenant. Isso explica todo o comportamento observado:
--   - por que era intermitente (depende de pegar conexão reciclada ou nova);
--   - por que piorava "a frio"/sob reconexão (mais reciclagem);
--   - por que os retries mitigavam (a nova tentativa pega outra conexão física);
--   - por que aparecia em query sem uuid nenhum (o cast está na POLICY, não na
--     query) -- inclusive em rotas de super-admin, que nem setam esse GUC.
--
-- A correção é envolver o current_setting em NULLIF(..., ''): string vazia vira
-- NULL, o cast para uuid de NULL é NULL, e a comparação simplesmente não casa
-- nenhuma linha -- que é o comportamento correto e seguro (falha fechada, sem
-- erro). Os bypass de super-admin/auth continuam funcionando normalmente,
-- porque são policies permissivas separadas, combinadas com OR.
--
-- Nenhuma mudança de semântica de segurança: onde antes dava erro, agora não
-- casa linha nenhuma. Nunca houve caso em que o erro "liberasse" acesso.
--
-- ALTER POLICY (em vez de DROP + CREATE) de propósito: não existe janela em que
-- a tabela fica sem a policy, então é seguro rodar com a aplicação no ar.
-- ============================================================================

-- ---------- comparação direta com associacao_id ----------
ALTER POLICY tenant_isolation_associados ON associados
USING (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

ALTER POLICY tenant_isolation_cobrancas ON cobrancas
USING (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

ALTER POLICY tenant_isolation_comunicados ON comunicados
USING (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

ALTER POLICY tenant_isolation_usuarios ON usuarios
USING (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

ALTER POLICY atividades_select_tenant ON atividades
USING (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

ALTER POLICY auth_logs_select_tenant ON auth_logs
USING (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

ALTER POLICY logs_auditoria_select_tenant ON logs_auditoria
USING (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

ALTER POLICY solicitacoes_plano_select_tenant ON solicitacoes_plano
USING (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

-- ---------- a própria tabela associacoes (compara por id) ----------
ALTER POLICY tenant_isolation_associacoes ON associacoes
USING (id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

-- ---------- policy de INSERT (só WITH CHECK) ----------
ALTER POLICY solicitacoes_plano_insert ON solicitacoes_plano
WITH CHECK (associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid);

-- ---------- policies que chegam no tenant por subquery ----------
ALTER POLICY tenant_isolation_pagamentos ON pagamentos
USING (
    cobranca_id IN (
        SELECT id FROM cobrancas
        WHERE associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid
    )
);

ALTER POLICY tenant_isolation_password_resets ON password_resets
USING (
    usuario_id IN (
        SELECT id FROM usuarios
        WHERE associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid
    )
);

ALTER POLICY tenant_isolation_comunicado_leituras ON comunicado_leituras
USING (
    comunicado_id IN (
        SELECT id FROM comunicados
        WHERE associacao_id = NULLIF(current_setting('app.current_associacao_id', true), '')::uuid
    )
);

-- ============================================================================
-- Conferência: depois de rodar, esta query deve devolver 0 linhas.
-- (qualquer policy que ainda faça o cast sem NULLIF aparece aqui)
--
--   SELECT tablename, policyname
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND (COALESCE(qual,'') || COALESCE(with_check,'')) LIKE '%current_associacao_id%'
--     AND (COALESCE(qual,'') || COALESCE(with_check,'')) NOT LIKE '%NULLIF%';
-- ============================================================================
