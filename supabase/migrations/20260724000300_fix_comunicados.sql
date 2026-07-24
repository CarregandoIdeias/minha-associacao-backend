-- Corrige o bug antigo da tela de Comunicados: routes/comunicados.js sempre
-- esperou uma coluna "destaque", uma coluna "status" e uma tabela
-- "comunicado_leituras" que nunca foram criadas no baseline. Não tem
-- relação com as mudanças de segurança de hoje — era um bug pré-existente.

ALTER TABLE comunicados ADD COLUMN destaque boolean NOT NULL DEFAULT false;
ALTER TABLE comunicados ADD COLUMN status varchar NOT NULL DEFAULT 'ativo'
    CHECK (status IN ('ativo', 'inativo'));

CREATE TABLE comunicado_leituras (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    comunicado_id uuid NOT NULL REFERENCES comunicados(id) ON DELETE CASCADE,
    usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    criado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT comunicado_leituras_comunicado_usuario_key UNIQUE (comunicado_id, usuario_id)
);
CREATE INDEX idx_comunicado_leituras_comunicado ON comunicado_leituras (comunicado_id);

ALTER TABLE comunicado_leituras ENABLE ROW LEVEL SECURITY;
-- Produção já está conectando como app_runtime (não-dona) desde a migração
-- anterior, então FORCE aqui não tem nenhum risco de quebrar nada em uso.
ALTER TABLE comunicado_leituras FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_comunicado_leituras ON comunicado_leituras
FOR ALL USING (
    comunicado_id IN (
        SELECT id FROM comunicados
        WHERE associacao_id = current_setting('app.current_associacao_id', true)::uuid
    )
);

CREATE POLICY superadmin_bypass_comunicado_leituras ON comunicado_leituras
FOR ALL USING (current_setting('app.superadmin_bypass', true) = 'true');

-- Concede explicitamente para app_runtime e garante que anon/authenticated
-- (API pública do Supabase, não usada por essa aplicação) não tenham
-- acesso a essa tabela nova — mesmo cuidado do achado de hoje sobre os
-- grants padrão do Supabase.
GRANT SELECT, INSERT, UPDATE, DELETE ON comunicado_leituras TO app_runtime;
REVOKE ALL PRIVILEGES ON comunicado_leituras FROM anon, authenticated;
