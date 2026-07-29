-- Corrige race condition em POST /plano/solicitar-contratacao (achado na
-- auditoria de segurança de 29/07/2026): o SELECT de "já existe pendente"
-- e o INSERT seguinte não são atômicos -- duas requisições simultâneas da
-- mesma associação passavam as duas pelo SELECT antes de qualquer uma
-- inserir, criando duas solicitações "pendente" ao mesmo tempo.
--
-- Índice único parcial: o próprio Postgres garante no máximo uma linha
-- 'pendente' por associação, não importa quantas requisições cheguem ao
-- mesmo tempo. routes/plano.js trata a violação (código 23505) com um 409
-- amigável -- o SELECT de antes continua existindo só como saída rápida
-- no caso comum, a garantia real passa a ser este índice.
CREATE UNIQUE INDEX solicitacoes_plano_pendente_unica
    ON solicitacoes_plano (associacao_id)
    WHERE status = 'pendente';
