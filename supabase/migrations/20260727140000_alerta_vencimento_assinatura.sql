-- Coluna dedicada para o alerta de vencimento da ASSINATURA da associação
-- com a plataforma (dashboard da associação, item de sprint 1.4) --
-- separada de `dias_alerta_vencimento`, que já existia e é sobre cobranças
-- pendentes dos ASSOCIADOS de cada associação (mensalidades), configurada
-- pela própria associação em Configurações. Esta aqui é configurada pelo
-- Super Admin, por associação, mesmo padrão de `trial_dias`.
ALTER TABLE associacoes
ADD COLUMN dias_alerta_assinatura integer NOT NULL DEFAULT 30;
