// middleware/paramUuid.js
const { uuidValido } = require('../utils/validacao');

// Handler para router.param('id', ...): rejeita um :id que não seja uuid antes
// que ele chegue numa query.
//
// Achado no QA de 07/08/2026: toda rota `/:id` devolvia 500 quando o id era
// texto qualquer -- o valor ia direto pro Postgres, que respondia
// `22P02 invalid input syntax for type uuid`, e isso caía no error handler
// global como "Erro interno do servidor". É entrada inválida do cliente (400),
// não falha do servidor. Além de enganar quem lê o log, mascarava um 500 de
// verdade no meio do ruído.
//
// Todas as colunas `id` das tabelas com rota `/:id` são uuid (conferido no
// information_schema antes de aplicar isso), então não existe rota legítima
// que receba outra coisa.
//
// Registrar uma vez por router: `router.param('id', paramUuid)`. Vale para
// qualquer rota daquele router que use `:id`, inclusive as aninhadas
// (ex.: /:id/pagar, /:id/comprovante).
function paramUuid(req, res, next, valor) {
    if (!uuidValido(valor)) {
        return res.status(400).json({ erro: 'Identificador inválido' });
    }
    next();
}

module.exports = paramUuid;
