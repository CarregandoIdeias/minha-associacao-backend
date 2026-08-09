-- Achado durante a implementação da Fase 3 da auditoria de segurança
-- (08/08/2026, SEC-025): password_resets tinha RLS ligado com só
-- tenant_isolation_password_resets e auth_bypass_password_resets --
-- nenhuma policy de bypass pro Super Admin (migration
-- 20260724000000_rls_policies.sql, decisão original: Super Admin não
-- precisava tocar token de redefinição de usuário individual).
--
-- Isso deixou de ser verdade com o item novo desta fase: PATCH
-- /superadmin/associacoes/:id/resetar-senha-admin passou a invalidar
-- qualquer link de redefinição pendente do admin do tenant ao resetar a
-- senha dele. Sem esta policy, esse UPDATE rodaria via
-- comConexaoSuperAdmin() e afetaria SILENCIOSAMENTE 0 linhas -- mesmo
-- padrão de bug já documentado no CLAUDE.md sobre configuracoes_plataforma
-- (policy de UPDATE exige a flag certa, senão "funciona" sem erro nenhum).
CREATE POLICY superadmin_bypass_password_resets ON password_resets
FOR ALL USING (current_setting('app.superadmin_bypass', true) = 'true');
