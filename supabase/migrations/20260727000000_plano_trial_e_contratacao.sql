-- Melhoria "Plano Trial + Contratação": controle automático de expiração do
-- trial (15 dias configurável por associação) + fluxo de contratação
-- self-service (Pix da própria plataforma + comprovante + aprovação do
-- Super Admin, mesmo padrão já usado nas cobranças de associado).
-- Todas as colunas/tabelas são aditivas — seguro aplicar a qualquer
-- momento, sem coordenar com deploy (ver supabase/README.md, seção RLS).

-- ---------- Trial configurável por associação ----------
ALTER TABLE associacoes ADD COLUMN trial_dias integer NOT NULL DEFAULT 15;
ALTER TABLE associacoes ADD COLUMN trial_expira_em timestamptz;

-- Backfill: associações trial já existentes não tinham data de expiração
-- nenhuma (trial "infinito" até então). Sem isso, todo trial já criado
-- expiraria de surpresa na hora que o middleware novo entrar no ar.
UPDATE associacoes
SET trial_expira_em = criado_em + (trial_dias || ' days')::interval
WHERE plano = 'trial' AND trial_expira_em IS NULL;

-- ---------- Solicitações de contratação/upgrade de plano ----------
-- Fluxo: associação escolhe um plano pago, vê o Pix da plataforma (não o
-- Pix da própria associação, que é outra chave — ver configuracoes_plataforma
-- abaixo), envia comprovante. Fica "pendente" até o Super Admin aprovar ou
-- rejeitar. Aprovação efetivamente troca associacoes.plano/ativo/vencimento.
CREATE TYPE status_solicitacao_plano AS ENUM ('pendente', 'aprovada', 'rejeitada');

CREATE TABLE solicitacoes_plano (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    associacao_id uuid NOT NULL REFERENCES associacoes(id) ON DELETE CASCADE,
    plano_solicitado plano_assinatura NOT NULL,
    valor_referencia numeric(10,2),
    comprovante_base64 text NOT NULL,
    status status_solicitacao_plano NOT NULL DEFAULT 'pendente',
    solicitado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    solicitado_em timestamptz NOT NULL DEFAULT now(),
    respondido_em timestamptz,
    respondido_por uuid REFERENCES super_admins(id) ON DELETE SET NULL,
    observacao_resposta text
);

CREATE INDEX idx_solicitacoes_plano_associacao ON solicitacoes_plano (associacao_id, solicitado_em DESC);
CREATE INDEX idx_solicitacoes_plano_status ON solicitacoes_plano (status);

ALTER TABLE solicitacoes_plano ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitacoes_plano FORCE ROW LEVEL SECURITY;

CREATE POLICY solicitacoes_plano_insert ON solicitacoes_plano
FOR INSERT WITH CHECK (associacao_id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY solicitacoes_plano_select_tenant ON solicitacoes_plano
FOR SELECT USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY solicitacoes_plano_select_superadmin ON solicitacoes_plano
FOR SELECT USING (current_setting('app.superadmin_bypass', true) = 'true');

-- Só o Super Admin aprova/rejeita (muda status/resposta) -- a associação
-- nunca edita a própria solicitação depois de enviada.
CREATE POLICY solicitacoes_plano_update_superadmin ON solicitacoes_plano
FOR UPDATE USING (current_setting('app.superadmin_bypass', true) = 'true');

-- ---------- Configuração de Pix da própria plataforma (não da associação) ----------
-- Chave Pix pra onde a mensalidade da plataforma é paga -- diferente de
-- associacoes.chave_pix (Pix de cada associação, usado nas cobranças dela
-- pros próprios associados). Singleton (padrão id boolean + CHECK) porque só
-- faz sentido existir uma linha: a conta da Carregando Ideias.
CREATE TABLE configuracoes_plataforma (
    id boolean PRIMARY KEY DEFAULT true,
    chave_pix text,
    nome_recebedor_pix varchar,
    cidade_pix varchar,
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT configuracoes_plataforma_singleton CHECK (id)
);
INSERT INTO configuracoes_plataforma (id) VALUES (true);

ALTER TABLE configuracoes_plataforma ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracoes_plataforma FORCE ROW LEVEL SECURITY;

-- Leitura liberada pra qualquer conexão autenticada da aplicação -- não é
-- dado sensível (é literalmente pra ser mostrado num QR Code escaneável) e
-- toda associação precisa ler isso pra montar a tela de contratação.
CREATE POLICY configuracoes_plataforma_select ON configuracoes_plataforma
FOR SELECT USING (true);

CREATE POLICY configuracoes_plataforma_update_superadmin ON configuracoes_plataforma
FOR UPDATE USING (current_setting('app.superadmin_bypass', true) = 'true');
