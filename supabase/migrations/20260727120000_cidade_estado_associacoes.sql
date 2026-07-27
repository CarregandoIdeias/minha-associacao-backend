-- Achado real montando o ambiente de staging do zero (27/07/2026): produção
-- tem as colunas cidade/estado em associacoes (usadas em filtros e no
-- formulário de cadastro do Super Admin desde a reforma de 24/07/2026),
-- mas nenhuma migration deste diretório as criava -- foram adicionadas
-- direto em produção, sem passar por aqui, e essa lacuna só apareceu ao
-- tentar recriar o schema do zero num projeto novo. Aditiva, segura a
-- qualquer momento.

ALTER TABLE associacoes ADD COLUMN cidade varchar;
ALTER TABLE associacoes ADD COLUMN estado varchar;
