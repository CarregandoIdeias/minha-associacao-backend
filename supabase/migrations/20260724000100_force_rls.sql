-- ATENÇÃO — NÃO RODAR AUTOMATICAMENTE.
--
-- Só executar depois de confirmar que o backend em produção (Render) já
-- está rodando o código novo E com DATABASE_URL apontando para a role
-- app_runtime (não-dona das tabelas). Ver plano em
-- C:\Users\julma\.claude\plans\whimsical-dancing-gadget.md.
--
-- Por quê: FORCE ROW LEVEL SECURITY muda o comportamento de quem já está
-- conectado como DONO das tabelas — se isso rodar antes do deploy, o
-- backend antigo (ainda conectado como dono, ainda sem os bypasses de
-- app.auth_bypass/app.superadmin_bypass no código) para de conseguir logar
-- ou ler associacoes/usuarios, e todo mundo fica fora do sistema.
--
-- A troca de DATABASE_URL para app_runtime sozinha já ativa o isolamento de
-- verdade (role não-dona é sujeita a RLS automaticamente, sem precisar de
-- FORCE — testado e confirmado). Este FORCE é só a camada extra de
-- segurança para o caso de alguém, no futuro, voltar a conectar como o
-- dono das tabelas por engano.

ALTER TABLE associacoes FORCE ROW LEVEL SECURITY;
ALTER TABLE associados FORCE ROW LEVEL SECURITY;
ALTER TABLE cobrancas FORCE ROW LEVEL SECURITY;
ALTER TABLE comunicados FORCE ROW LEVEL SECURITY;
ALTER TABLE pagamentos FORCE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_logs FORCE ROW LEVEL SECURITY;
