-- Completa as policies de RLS que faltavam para o isolamento entre tenants
-- funcionar de verdade quando o backend conectar como uma role não-dona das
-- tabelas (app_runtime, criada à parte — ver plano em
-- C:\Users\julma\.claude\plans\whimsical-dancing-gadget.md).
--
-- Este arquivo é seguro de rodar a qualquer momento: NÃO contém
-- FORCE ROW LEVEL SECURITY, então não muda nada para quem ainda está
-- conectado como dono das tabelas (o backend em produção, até o deploy da
-- nova DATABASE_URL). A ativação de verdade só acontece quando o backend
-- passa a se conectar como app_runtime — role não-dona já é sujeita a RLS
-- automaticamente, sem precisar de FORCE (confirmado antes de rodar isso).

-- ---------- associacoes ----------
-- Tinha RLS ligado desde o baseline mas nenhuma policy — ou seja, hoje é
-- inacessível para qualquer role que não seja a dona das tabelas.
CREATE POLICY tenant_isolation_associacoes ON associacoes
FOR ALL USING (id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY superadmin_bypass_associacoes ON associacoes
FOR ALL USING (current_setting('app.superadmin_bypass', true) = 'true');

-- Login e redefinição de senha por token precisam ler associacoes.ativo
-- antes de saber qual é o tenant (é exatamente o que estão descobrindo).
CREATE POLICY auth_bypass_associacoes ON associacoes
FOR ALL USING (current_setting('app.auth_bypass', true) = 'true');

-- ---------- password_resets ----------
-- Mesma situação: RLS ligado, zero policies, hoje inacessível.
CREATE POLICY tenant_isolation_password_resets ON password_resets
FOR ALL USING (
    usuario_id IN (
        SELECT id FROM usuarios
        WHERE associacao_id = current_setting('app.current_associacao_id', true)::uuid
    )
);

-- Redefinição por token (POST /auth/redefinir-senha) não conhece o tenant
-- de antemão — o token é o próprio segredo que identifica o usuário.
CREATE POLICY auth_bypass_password_resets ON password_resets
FOR ALL USING (current_setting('app.auth_bypass', true) = 'true');

-- ---------- usuarios ----------
-- Já tinha tenant_isolation_usuarios (baseline). Faltam os bypasses.
CREATE POLICY superadmin_bypass_usuarios ON usuarios
FOR ALL USING (current_setting('app.superadmin_bypass', true) = 'true');

CREATE POLICY auth_bypass_usuarios ON usuarios
FOR ALL USING (current_setting('app.auth_bypass', true) = 'true');

-- ---------- associados / cobrancas / comunicados / pagamentos ----------
-- Já tinham a policy de isolamento por tenant (baseline). As rotas de
-- routes/superadmin.js usam comConexaoSuperAdmin() para ver dados de
-- qualquer associação — hoje isso só "funciona" porque o dono das tabelas
-- bypassa RLS de qualquer jeito. Faltava a policy correspondente.
CREATE POLICY superadmin_bypass_associados ON associados
FOR ALL USING (current_setting('app.superadmin_bypass', true) = 'true');

CREATE POLICY superadmin_bypass_cobrancas ON cobrancas
FOR ALL USING (current_setting('app.superadmin_bypass', true) = 'true');

CREATE POLICY superadmin_bypass_comunicados ON comunicados
FOR ALL USING (current_setting('app.superadmin_bypass', true) = 'true');

CREATE POLICY superadmin_bypass_pagamentos ON pagamentos
FOR ALL USING (current_setting('app.superadmin_bypass', true) = 'true');

-- ---------- super_admins ----------
-- Não tem coluna de tenant — RLS aqui nunca isolou nada, só bloqueava por
-- padrão. O controle de acesso já é feito inteiramente pelo middleware
-- autenticarSuperAdmin(). Desativar em vez de criar uma policy fake.
ALTER TABLE super_admins DISABLE ROW LEVEL SECURITY;

-- ---------- auth_logs ----------
-- A policy única do baseline (FOR ALL por tenant) bloquearia até o INSERT
-- de tentativas de login com e-mail errado ou de eventos do super-admin,
-- que não têm (ou não sabem ainda) o tenant no momento de gravar. Divide em:
-- INSERT sempre permitido (log é append-only, controlado pelo código, não
-- por input direto do usuário) + SELECT restrito por tenant ou super-admin.
DROP POLICY IF EXISTS tenant_isolation_auth_logs ON auth_logs;

CREATE POLICY auth_logs_insert ON auth_logs
FOR INSERT WITH CHECK (true);

CREATE POLICY auth_logs_select_tenant ON auth_logs
FOR SELECT USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY auth_logs_select_superadmin ON auth_logs
FOR SELECT USING (current_setting('app.superadmin_bypass', true) = 'true');
