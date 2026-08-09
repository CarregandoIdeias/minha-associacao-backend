-- Renomeia os planos "profissional"/"enterprise" para "intermediario"/
-- "avancado", alinhado com a nova nomenclatura da landing page (29/07/2026):
-- Básico / Intermediário / Avançado. Sem acento nos valores internos do
-- enum, seguindo o padrão já usado pelos demais valores (trial, basico).
--
-- ALTER TYPE ... RENAME VALUE só troca o rótulo no catálogo do tipo
-- (pg_enum) — o valor interno (oid) não muda, então nenhuma linha de
-- `associacoes.plano` precisa de UPDATE. Preços/faixas de porte continuam
-- os mesmos, só o nome do plano muda.
ALTER TYPE plano_assinatura RENAME VALUE 'profissional' TO 'intermediario';
ALTER TYPE plano_assinatura RENAME VALUE 'enterprise' TO 'avancado';
