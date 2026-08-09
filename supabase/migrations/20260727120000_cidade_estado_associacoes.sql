-- Achado real montando o ambiente de staging do zero (27/07/2026): produção
-- tem as colunas cidade/estado em associacoes (usadas em filtros e no
-- formulário de cadastro do Super Admin desde a reforma de 24/07/2026),
-- mas nenhuma migration deste diretório as criava -- foram adicionadas
-- direto em produção, sem passar por aqui, e essa lacuna só apareceu ao
-- tentar recriar o schema do zero num projeto novo. Aditiva, segura a
-- qualquer momento.

-- CORRIGIDO em 08/08/2026, pela conferência de drift da auditoria de
-- segurança (SEC-030): este arquivo declarava `cidade varchar`, mas
-- produção tem `cidade text` -- resquício de as duas colunas terem sido
-- criadas à mão lá em 24/07, antes de existir migration pra elas. Note a
-- assimetria na própria produção: `estado` é varchar, `cidade` é text.
--
-- Sem impacto funcional: no PostgreSQL, `text` e `varchar` sem limite são
-- o mesmo tipo na prática (mesma representação, operadores, desempenho e
-- comportamento de índice) -- a diferença só existe no catálogo. O ajuste
-- aqui é pra este arquivo descrever o schema real de produção, de forma
-- que recriar o staging do zero produza um banco idêntico em vez de
-- reintroduzir a divergência.
ALTER TABLE associacoes ADD COLUMN cidade text;
ALTER TABLE associacoes ADD COLUMN estado varchar;
