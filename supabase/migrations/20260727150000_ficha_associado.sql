-- Item de sprint 2.1 (Ficha Completa do Associado): campos de endereço e
-- documento que não existiam antes. Aditiva, todas as colunas nullable.
ALTER TABLE associados ADD COLUMN endereco_cep varchar;
ALTER TABLE associados ADD COLUMN endereco_logradouro varchar;
ALTER TABLE associados ADD COLUMN endereco_numero varchar;
ALTER TABLE associados ADD COLUMN endereco_complemento varchar;
ALTER TABLE associados ADD COLUMN endereco_bairro varchar;
ALTER TABLE associados ADD COLUMN endereco_cidade varchar;
ALTER TABLE associados ADD COLUMN endereco_estado varchar(2);
ALTER TABLE associados ADD COLUMN rg varchar;
