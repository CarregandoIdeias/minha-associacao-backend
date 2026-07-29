-- Item de sprint (backlog): comunicado da plataforma pra todas as
-- associações de uma vez, enviado pelo Super Admin. Aditiva, nullable
-- com default -- reaproveita a tabela comunicados existente (uma linha por
-- associação ativa), só marca a origem pra distinguir de um comunicado
-- escrito pela própria diretoria.
ALTER TABLE comunicados ADD COLUMN origem_plataforma boolean NOT NULL DEFAULT false;
