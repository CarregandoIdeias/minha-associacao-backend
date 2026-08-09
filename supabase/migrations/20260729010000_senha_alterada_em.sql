-- Invalidação de JWT ao trocar senha (achado na auditoria de segurança de
-- 29/07/2026): sem isso, um token roubado (ou de sessão esquecida aberta)
-- continua válido até expirar (até 8h) mesmo depois do dono trocar a senha
-- suspeitando de acesso indevido. `senha_alterada_em` é comparado com o
-- `iat` (issued-at) do JWT em middleware/auth.js (autenticar/
-- autenticarSuperAdmin) -- qualquer token emitido antes dessa data deixa
-- de ser aceito.
--
-- DEFAULT now() faz toda linha existente ganhar o timestamp da migration,
-- o que invalida de imediato qualquer sessão já aberta no momento em que
-- isso rodar em produção -- efeito colateral esperado e aceitável (força
-- um novo login, não perde nenhum dado). Coordenar com o usuário antes de
-- rodar em produção, mesmo sendo uma migration aditiva/segura por si só.

ALTER TABLE usuarios ADD COLUMN senha_alterada_em timestamptz NOT NULL DEFAULT now();
ALTER TABLE super_admins ADD COLUMN senha_alterada_em timestamptz NOT NULL DEFAULT now();
