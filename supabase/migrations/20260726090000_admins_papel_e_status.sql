-- Fase 1 da melhoria do Painel Super Admin: gerenciamento de administradores
-- da plataforma (níveis de permissão, ativação/desativação, senha provisória
-- com troca obrigatória no primeiro acesso -- mesmo padrão já usado para
-- usuarios). Aditivo, seguro aplicar a qualquer momento (ver supabase/README.md).

CREATE TYPE papel_super_admin AS ENUM ('super_admin', 'administrador', 'suporte');

ALTER TABLE super_admins ADD COLUMN papel papel_super_admin NOT NULL DEFAULT 'super_admin';
ALTER TABLE super_admins ADD COLUMN ativo boolean NOT NULL DEFAULT true;
ALTER TABLE super_admins ADD COLUMN deve_trocar_senha boolean NOT NULL DEFAULT false;
