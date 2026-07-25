-- Log de atividades (quem fez o quê) para alimentar o card "Atividades
-- recentes" do novo Dashboard do painel da associação. Puramente aditiva,
-- sem relação com dados existentes — não requer FORCE ROW LEVEL SECURITY
-- coordenado com deploy (ver 20260724000100_force_rls.sql para o motivo de
-- isso ser sensível em tabelas antigas): como esta tabela é nova e ninguém
-- ainda depende do comportamento sem RLS, já nasce com FORCE.
--
-- usuario_nome é um snapshot do nome no momento do evento (não só
-- usuario_id) para a listagem continuar legível mesmo se o usuário for
-- removido depois — mesmo raciocínio de email_tentado em auth_logs.
CREATE TABLE atividades (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    associacao_id uuid NOT NULL REFERENCES associacoes(id) ON DELETE CASCADE,
    usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    usuario_nome varchar,
    tipo varchar NOT NULL, -- associado_criado | associado_editado | cobranca_paga | comunicado_publicado | usuario_convidado
    descricao text NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_atividades_associacao ON atividades (associacao_id, criado_em DESC);

ALTER TABLE atividades ENABLE ROW LEVEL SECURITY;
ALTER TABLE atividades FORCE ROW LEVEL SECURITY;

-- Mesma divisão usada em auth_logs: INSERT sempre permitido (log
-- append-only, controlado pelo código, não por input direto do usuário) +
-- SELECT restrito por tenant ou bypass do super-admin.
CREATE POLICY atividades_insert ON atividades
FOR INSERT WITH CHECK (true);

CREATE POLICY atividades_select_tenant ON atividades
FOR SELECT USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY atividades_select_superadmin ON atividades
FOR SELECT USING (current_setting('app.superadmin_bypass', true) = 'true');
