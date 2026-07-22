-- Baseline do schema existente em produção em 22/07/2026.
-- Referência para versionamento. Não executar no banco de produção já existente.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE tipo_associacao AS ENUM (
    'moradores', 'classe_profissional', 'esportiva_recreativa', 'ong_beneficente', 'outra'
);
CREATE TYPE plano_assinatura AS ENUM ('trial', 'basico', 'profissional', 'enterprise');
CREATE TYPE papel_usuario AS ENUM ('admin', 'diretoria', 'associado');
CREATE TYPE status_associado AS ENUM ('ativo', 'inadimplente', 'desligado', 'suspenso');
CREATE TYPE status_cobranca AS ENUM ('pendente', 'pago', 'atrasado', 'cancelado', 'aguardando_confirmacao');
CREATE TYPE metodo_pagamento AS ENUM ('pix', 'boleto', 'cartao', 'dinheiro', 'outro');

CREATE TABLE associacoes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome varchar NOT NULL,
    cnpj varchar UNIQUE,
    tipo tipo_associacao NOT NULL DEFAULT 'outra',
    plano plano_assinatura NOT NULL DEFAULT 'trial',
    cor_primaria varchar DEFAULT '#8B1A1A',
    logo_url text,
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    chave_pix text,
    nome_recebedor_pix varchar,
    cidade_pix varchar,
    dias_alerta_vencimento integer NOT NULL DEFAULT 3,
    email text,
    telefone text,
    endereco text
);

CREATE TABLE usuarios (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    associacao_id uuid NOT NULL REFERENCES associacoes(id) ON DELETE CASCADE,
    nome varchar NOT NULL,
    email varchar NOT NULL,
    senha_hash text NOT NULL,
    papel papel_usuario NOT NULL DEFAULT 'associado',
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT usuarios_associacao_id_email_key UNIQUE (associacao_id, email)
);

CREATE TABLE associados (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    associacao_id uuid NOT NULL REFERENCES associacoes(id) ON DELETE CASCADE,
    usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    nome_completo varchar NOT NULL,
    cpf varchar,
    telefone varchar,
    categoria varchar,
    status status_associado NOT NULL DEFAULT 'ativo',
    data_ingresso date NOT NULL DEFAULT CURRENT_DATE,
    campos_extra jsonb DEFAULT '{}'::jsonb,
    criado_em timestamptz NOT NULL DEFAULT now(),
    foto_base64 text,
    observacao text,
    CONSTRAINT associados_associacao_id_cpf_key UNIQUE (associacao_id, cpf)
);

CREATE TABLE cobrancas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    associacao_id uuid NOT NULL REFERENCES associacoes(id) ON DELETE CASCADE,
    associado_id uuid NOT NULL REFERENCES associados(id) ON DELETE CASCADE,
    descricao varchar NOT NULL DEFAULT 'Mensalidade',
    valor numeric NOT NULL CHECK (valor >= 0),
    vencimento date NOT NULL,
    status status_cobranca NOT NULL DEFAULT 'pendente',
    metodo metodo_pagamento,
    referencia_externa text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    comprovante_base64 text,
    comprovante_enviado_em timestamptz
);

CREATE TABLE comunicados (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    associacao_id uuid NOT NULL REFERENCES associacoes(id) ON DELETE CASCADE,
    autor_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    titulo varchar NOT NULL,
    conteudo text NOT NULL,
    categoria_alvo varchar,
    publicado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pagamentos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cobranca_id uuid NOT NULL REFERENCES cobrancas(id) ON DELETE CASCADE,
    valor_pago numeric NOT NULL CHECK (valor_pago >= 0),
    pago_em timestamptz NOT NULL DEFAULT now(),
    metodo metodo_pagamento NOT NULL,
    comprovante_url text
);

CREATE TABLE password_resets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    expira_em timestamptz NOT NULL,
    usado boolean NOT NULL DEFAULT false,
    criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE super_admins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome varchar NOT NULL,
    email varchar NOT NULL UNIQUE,
    senha_hash text NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_associados_associacao ON associados (associacao_id);
CREATE INDEX idx_associados_status ON associados (associacao_id, status);
CREATE INDEX idx_cobrancas_associacao ON cobrancas (associacao_id);
CREATE INDEX idx_cobrancas_associado ON cobrancas (associado_id);
CREATE INDEX idx_cobrancas_status ON cobrancas (associacao_id, status);
CREATE INDEX idx_cobrancas_vencimento ON cobrancas (vencimento);
CREATE INDEX idx_comunicados_associacao ON comunicados (associacao_id);
CREATE INDEX idx_pagamentos_cobranca ON pagamentos (cobranca_id);
CREATE INDEX idx_password_resets_token ON password_resets (token_hash);
CREATE INDEX idx_password_resets_usuario ON password_resets (usuario_id);

CREATE OR REPLACE FUNCTION set_atualizado_em()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.atualizado_em = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_associacoes_atualizado
BEFORE UPDATE ON associacoes
FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

ALTER TABLE associacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE associados ENABLE ROW LEVEL SECURITY;
ALTER TABLE cobrancas ENABLE ROW LEVEL SECURITY;
ALTER TABLE comunicados ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE super_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_associados ON associados
FOR ALL
USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY tenant_isolation_cobrancas ON cobrancas
FOR ALL
USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY tenant_isolation_comunicados ON comunicados
FOR ALL
USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);

CREATE POLICY tenant_isolation_pagamentos ON pagamentos
FOR ALL
USING (
    cobranca_id IN (
        SELECT id FROM cobrancas
        WHERE associacao_id = current_setting('app.current_associacao_id', true)::uuid
    )
);

CREATE POLICY tenant_isolation_usuarios ON usuarios
FOR ALL
USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);
