-- Fase 2 da melhoria do Painel Super Admin: log de auditoria central,
-- cross-tenant (super-admin enxerga ações de qualquer associação, ex.
-- "Ana excluiu um associado"). Tabela nova, aditiva -- FORCE ROW LEVEL
-- SECURITY é seguro aqui porque nada depende do comportamento sem RLS
-- (mesmo raciocínio já usado em atividades, ver 20260725120000_atividades.sql).
--
-- Segue o mesmo padrão de auth_logs (20260723000000_login_por_email.sql):
-- INSERT sempre permitido (log é append-only, controlado pelo código, nunca
-- por input direto do usuário) + SELECT restrito por tenant ou super-admin.

CREATE TYPE tipo_acao_auditoria AS ENUM (
    'login', 'logout', 'criacao', 'edicao', 'exclusao',
    'alteracao_senha', 'alteracao_permissoes', 'exportacao'
);

CREATE TABLE logs_auditoria (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- SET NULL (não CASCADE) de propósito: excluir uma associação não pode
    -- apagar o próprio histórico de auditoria dela, inclusive o registro da
    -- exclusão em si -- é exatamente o tipo de evento que a auditoria existe
    -- para preservar. O nome da associação já fica salvo em texto em
    -- "descricao"/"dados_novos"/"dados_anteriores" de cada linha, então a
    -- informação não se perde com o FK nulo.
    associacao_id uuid REFERENCES associacoes(id) ON DELETE SET NULL,
    usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    usuario_nome varchar,
    usuario_email varchar,
    super_admin_id uuid REFERENCES super_admins(id) ON DELETE SET NULL,
    super_admin_nome varchar,
    super_admin_email varchar,
    -- associacoes | administradores | associados | cobrancas | comunicados |
    -- usuarios | configuracoes | autenticacao | auditoria
    modulo varchar NOT NULL,
    tipo_acao tipo_acao_auditoria NOT NULL,
    descricao text NOT NULL,
    dados_anteriores jsonb,
    dados_novos jsonb,
    ip varchar,
    user_agent text,
    criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_logs_auditoria_associacao ON logs_auditoria (associacao_id, criado_em DESC);
CREATE INDEX idx_logs_auditoria_criado_em ON logs_auditoria (criado_em DESC);
CREATE INDEX idx_logs_auditoria_modulo ON logs_auditoria (modulo);
CREATE INDEX idx_logs_auditoria_tipo_acao ON logs_auditoria (tipo_acao);

ALTER TABLE logs_auditoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs_auditoria FORCE ROW LEVEL SECURITY;

CREATE POLICY logs_auditoria_insert ON logs_auditoria
FOR INSERT WITH CHECK (true);

CREATE POLICY logs_auditoria_select_tenant ON logs_auditoria
FOR SELECT USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY logs_auditoria_select_superadmin ON logs_auditoria
FOR SELECT USING (current_setting('app.superadmin_bypass', true) = 'true');
