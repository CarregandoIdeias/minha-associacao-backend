-- Item de sprint (backlog, item 5): perfis de acesso granulares, além de
-- admin/diretoria/associado. Cada ALTER TYPE ... ADD VALUE precisa ser uma
-- instrução own -- não pode ser combinado com outros comandos na mesma
-- transação junto com algo que já use o valor novo (não é o caso aqui,
-- é só o enum sendo ampliado, nada usa os valores ainda).
ALTER TYPE papel_usuario ADD VALUE 'financeiro';
ALTER TYPE papel_usuario ADD VALUE 'atendimento';
ALTER TYPE papel_usuario ADD VALUE 'operador';
ALTER TYPE papel_usuario ADD VALUE 'consulta';
