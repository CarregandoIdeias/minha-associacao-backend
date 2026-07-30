-- Modal de boas-vindas no primeiro acesso do painel da associação.
-- NULL = ainda não viu; marcado com now() no clique de "Começar a usar a
-- plataforma" (PATCH /auth/boas-vindas-visto). Aditiva, nullable, segura.
ALTER TABLE usuarios ADD COLUMN boas_vindas_visto_em timestamptz;
