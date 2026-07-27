-- Backlog de sprint da plataforma (melhorias/bugs que o usuário registra pra
-- eu ler e aplicar) -- tabela nova, de nível de plataforma, sem relação com
-- nenhuma associação-cliente (não é dado de tenant). Segue o mesmo padrão de
-- configuracoes_plataforma/solicitacoes_plano: RLS com acesso só via
-- superadmin_bypass, sem policy de tenant nenhuma. Aditiva, segura a
-- qualquer momento.

CREATE TYPE sprint_tipo AS ENUM ('melhoria', 'bug');
CREATE TYPE sprint_prioridade AS ENUM ('baixa', 'media', 'alta', 'urgente');
CREATE TYPE sprint_status AS ENUM ('pendente', 'em_andamento', 'concluido', 'cancelado');

CREATE TABLE sprint_itens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo sprint_tipo NOT NULL,
    titulo varchar(200) NOT NULL,
    descricao text NOT NULL,
    area varchar(60),
    prioridade sprint_prioridade NOT NULL DEFAULT 'media',
    status sprint_status NOT NULL DEFAULT 'pendente',
    notas_aplicacao text,
    criado_por uuid REFERENCES super_admins(id) ON DELETE SET NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    concluido_em timestamptz
);

CREATE INDEX idx_sprint_itens_status ON sprint_itens (status, criado_em DESC);

ALTER TABLE sprint_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprint_itens FORCE ROW LEVEL SECURITY;

-- Sem policy de tenant (não existe associacao_id aqui) -- toda operação
-- exige o bypass do super-admin, igual configuracoes_plataforma.
CREATE POLICY sprint_itens_select_superadmin ON sprint_itens
FOR SELECT USING (current_setting('app.superadmin_bypass', true) = 'true');

CREATE POLICY sprint_itens_insert_superadmin ON sprint_itens
FOR INSERT WITH CHECK (current_setting('app.superadmin_bypass', true) = 'true');

CREATE POLICY sprint_itens_update_superadmin ON sprint_itens
FOR UPDATE USING (current_setting('app.superadmin_bypass', true) = 'true');

CREATE POLICY sprint_itens_delete_superadmin ON sprint_itens
FOR DELETE USING (current_setting('app.superadmin_bypass', true) = 'true');
