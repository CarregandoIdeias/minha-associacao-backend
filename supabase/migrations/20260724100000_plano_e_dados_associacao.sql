-- Reformulação da área Super Admin: campos de plano contratado/cobrança e
-- dados adicionais de cadastro que o formulário novo do painel precisa.
-- Todas as colunas são nullable e aditivas — seguro aplicar a qualquer
-- momento, sem coordenar com deploy (ver supabase/README.md, seção RLS).
-- Não mexe em RLS/policies: associacoes e usuarios já têm FORCE RLS desde
-- migrations anteriores, colunas novas herdam a mesma proteção.

ALTER TABLE associacoes ADD COLUMN cep varchar;
ALTER TABLE associacoes ADD COLUMN site varchar;

-- Sobrescrita manual do valor da mensalidade calculada (base + por
-- associado, ver backend/utils/precos.js). NULL = usar o valor calculado.
ALTER TABLE associacoes ADD COLUMN valor_mensalidade_manual numeric(10,2);
ALTER TABLE associacoes ADD COLUMN vencimento_assinatura date;
ALTER TABLE associacoes ADD COLUMN forma_cobranca metodo_pagamento;

-- CPF do responsável — mesma pessoa que já é o admin de login da
-- associação (usuarios.papel = 'admin'), não um cadastro separado.
ALTER TABLE usuarios ADD COLUMN cpf varchar;
