-- Substitui o login por código/associacao_id por login com e-mail globalmente
-- único + senha. Ver plano em C:\Users\julma\.claude\plans\whimsical-dancing-gadget.md

-- Contas criadas a partir de agora nascem com senha provisória e precisam
-- trocar no primeiro acesso. Contas existentes não são afetadas retroativamente.
ALTER TABLE usuarios ADD COLUMN deve_trocar_senha boolean NOT NULL DEFAULT false;

-- E-mail deixa de ser único só dentro da associação e passa a ser único na
-- plataforma inteira (login não recebe mais associacao_id para desambiguar).
ALTER TABLE usuarios DROP CONSTRAINT usuarios_associacao_id_email_key;
CREATE UNIQUE INDEX usuarios_email_unique_idx ON usuarios (lower(email));

CREATE TABLE auth_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    associacao_id uuid REFERENCES associacoes(id) ON DELETE CASCADE,
    email_tentado varchar,
    evento varchar NOT NULL, -- login_sucesso | login_falha | logout | senha_alterada | senha_redefinida | senha_provisoria_criada
    ip varchar,
    user_agent text,
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_logs_associacao ON auth_logs (associacao_id, criado_em DESC);

ALTER TABLE auth_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_auth_logs ON auth_logs
FOR ALL USING (associacao_id = current_setting('app.current_associacao_id', true)::uuid);
