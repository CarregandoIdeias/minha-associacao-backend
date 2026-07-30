# CLAUDE.md — backend

Contexto rápido para sessões de IA trabalhando neste repositório. Para o
quadro completo (rotas, modelo de dados, roadmap), ver `README.md`. Para
tudo sobre migrações e RLS, ver `supabase/README.md`.

## O que é

API multi-tenant (Node/Express + Postgres/Supabase) para gestão de
associações — Super Admin cadastra associações-clientes, cada uma com seu
admin/diretoria/associados isolados das outras. Front-end em
`../painel` (HTML/JS puro, repositório separado), consome essa API.

## Auditoria de segurança pré-lançamento — itens de severidade baixa corrigidos (29/07/2026, continuação)

Depois dos 5 médios (seção seguinte), o usuário pediu pra resolver também
os de severidade baixa da mesma auditoria:

**Exportação Excel removida, só PDF continua** — o maior dos itens.
`npm audit` reportava 10 vulnerabilidades (9 high, 1 moderate) na cadeia
transitiva do `exceljs` (via `archiver`: glob/minimatch/brace-expansion/
rimraf/uuid/zip-stream). Testado trocar de versão antes de decidir remover
— **nenhuma versão do exceljs escapa disso**: `^4.4.0` (o que já estava
instalado) mostrava `exceljs >=3.5.0` vulnerável com fix sugerido 3.4.0;
instalando 3.4.0, o próprio `npm audit` reavaliava e reportava 3.4.0
também vulnerável (`range: 0.1.10 - 4.1.1`) com fix sugerido 3.10.0;
instalando 3.10.0, voltava a reportar `exceljs` vulnerável com `range:
>=0.1.10` (ou seja, **toda versão já publicada**) e fix sugerido 3.4.0 de
novo — um loop sem saída real, porque a vulnerabilidade está no
`archiver` que o exceljs usa pra montar o `.xlsx` como zip, não no
exceljs em si. A pedido do usuário ("se for caso remova exportações em
excel, deixa apenas pdf"), `exceljs` foi removido do `package.json`
(`npm uninstall exceljs` — **`npm audit` foi de 10 pra 0 vulnerabilidades**
na hora). `pdfkit` (única lib de exportação que sobrou) não tem essa
cadeia de dependências.

Mudança em cascata, sempre removendo o branch `formato === 'excel'` e
simplificando a assinatura da função (não fazia sentido manter um
parâmetro `formato` que só um valor possível continua existindo):
- `utils/exportarLogs.js`: `gerarExcelLogs` removida, só `gerarPdfLogs`
  exportada.
- `utils/exportarLeiturasComunicado.js`: `gerarExcelLeituras` removida,
  só `gerarPdfLeituras` exportada.
- `utils/validacao.js`: `sanitizarCelulaExcel()` (criada horas antes,
  pro item de formula injection) virou órfã e foi removida também --
  só existia pra sanitizar célula de Excel, não faz sentido mais.
- `routes/auditoria.js`, `routes/superadmin.js` (`/logs/exportar/:formato`),
  `routes/comunicados.js` (`/leituras/exportar/:formato`): validação de
  `formato` mudou de `['excel','pdf'].includes(...)` pra
  `formato !== 'pdf'`, removido o branch condicional que chamava a
  função de Excel.
- Front-end (`painel/CLAUDE.md` tem o detalhe): removidos os 3 botões
  "Exportar Excel" (`superadmin.html`, `index.html` × 2 — auditoria e
  leituras de comunicado) e simplificadas as 3 funções JS correspondentes
  pra não receberem mais parâmetro de formato.

Testado em staging: as 3 rotas (`/superadmin/logs/exportar/pdf`,
`/auditoria/exportar/pdf`, `/comunicados/:id/leituras/exportar/pdf`)
geram PDF válido (`file` confirmou `PDF document`); as 3 mesmas rotas
com `/excel` no lugar de `/pdf` devolvem 400 `formato deve ser "pdf"`
corretamente.

**Outros 4 itens de severidade baixa, também corrigidos:**
- IP forjável já estava coberto pelo fix de `req.ip` da seção anterior
  (mesma correção serviu pros dois).
- Limite de tamanho (~2MB) aplicado em `logo_base64` nas duas rotas de
  associação do Super Admin (`POST`/`PUT /superadmin/associacoes`) --
  mesmo padrão que `PUT /configuracoes/logo` já tinha, só essas duas
  rotas tinham ficado de fora.
- Log de auditoria não grava mais `logo_url` (base64 inteira, pode ter
  MBs) em `dados_novos` a cada edição de associação --
  `PUT /superadmin/associacoes/:id` agora exclui esse campo do objeto
  antes de chamar `registrarLogAuditoria` (`const { logo_url,
  ...dadosNovosSemLogo }`). A rota de criação já fazia isso certo desde
  sempre (usava um objeto curado, não o `RETURNING` completo).
- `nome` de usuário e o IP forjável eram os mesmos dos médios, não
  duplicados aqui.

## Auditoria de segurança pré-lançamento — 5 achados médios corrigidos (29/07/2026)

Pedido pelo usuário antes de disponibilizar a plataforma pra clientes reais:
auditoria completa via 2 agentes em paralelo (backend + front-end), cobrindo
as 3 integrações (Super Admin/Painel da Associação/Portal do Associado).
Achados de severidade média, todos corrigidos e testados em staging:

1. **IP forjável nos logs de auditoria/autenticação** — `utils/authLog.js`
   e `utils/auditoria.js` extraíam o IP manualmente de
   `req.headers['x-forwarded-for'].split(',')[0]`, exatamente a posição que
   o próprio cliente controla livremente (proxies normalmente *acrescentam*
   o IP real ao invés de sobrescrever, então um atacante mandando
   `X-Forwarded-For: 1.2.3.4` fazia esse valor forjado virar o IP
   registrado). Trocado por `req.ip`, que já respeita `app.set('trust
   proxy', 1)` (`server.js`) — mesmo mecanismo que o `express-rate-limit`
   já usa corretamente.

2. **Formula injection no Excel exportado** — `utils/exportarLogs.js` e
   `utils/exportarLeiturasComunicado.js` gravavam célula de texto livre
   (nome, descrição, e-mail) sem neutralizar valores que começam com
   `=`/`+`/`-`/`@`/tab — um `nome` ou `descricao` assim vira fórmula ativa
   quando o Excel é aberto. Novo `sanitizarCelulaExcel()` em
   `utils/validacao.js` prefixa com aspas simples (`'`) qualquer valor
   nessas condições antes de `planilha.addRow(...)` — testado
   isoladamente com `=HYPERLINK(...)`, `+1+1`, `-cmd|calc`, `@SUM(...)`.

3. **`nome` de usuário sem validação** — `POST`/`PUT /usuarios`
   (`routes/usuarios.js`) só exigiam "não vazio". Novo `nomeValido()` em
   `utils/validacao.js` (máx. 120 caracteres, bloqueia caracteres de
   controle) aplicado nos dois. Defesa em profundidade complementar ao
   item 2 (a sanitização no export cobre qualquer campo de qualquer
   tabela; essa validação fecha a entrada especificamente pro nome de
   usuário, que é o campo mais citado em descrições de log de auditoria).

4. **JWT não invalidado ao trocar senha** — um token roubado continuava
   válido até expirar (até 8h) mesmo depois do dono trocar a senha por
   suspeita de acesso indevido. Nova coluna `senha_alterada_em` em
   `usuarios` e `super_admins` (migration
   `20260729010000_senha_alterada_em.sql`, `DEFAULT now()` — **efeito
   colateral esperado**: aplicar essa migration em produção invalida
   todas as sessões abertas naquele instante, forçando um novo login;
   aceitável, sem perda de dado). Toda rota que troca senha
   (`PUT /auth/senha`, `POST /auth/redefinir-senha`,
   `PATCH /usuarios/:id/redefinir-senha`, `PUT /superadmin/perfil/senha`,
   `PATCH /superadmin/admins/:id/senha`,
   `PATCH /superadmin/associacoes/:id/resetar-senha-admin`) agora grava
   `senha_alterada_em = now()`. `autenticar()`/`autenticarSuperAdmin()`
   (`middleware/auth.js`) comparam `payload.iat` (segundos, padrão do JWT)
   com `senha_alterada_em` arredondado pro mesmo segundo
   (`Math.floor(getTime()/1000)`) — **bug real encontrado e corrigido
   durante o teste**: a primeira versão comparava `iat * 1000` (sempre
   arredondado pra baixo, `:000ms`) direto contra o timestamp em
   milissegundos do Postgres, o que rejeitava até o token **recém-emitido
   na mesma resposta** quando as duas ações caíam no mesmo segundo (ex.:
   `PUT /superadmin/perfil/senha` reemite token, mas ele vinha inválido de
   cara). `PUT /superadmin/perfil/senha` não reemitia token nenhum antes
   dessa correção — agora devolve `token` novo na resposta, e
   `superadmin.html` foi atualizado pra salvar esse token
   (senão o próprio Super Admin ficaria "deslogado" ao trocar a própria
   senha, sem nenhum aviso).

5. **Race condition em `POST /plano/solicitar-contratacao`** — o `SELECT`
   de "já existe pendente" e o `INSERT` seguinte não eram atômicos; duas
   requisições simultâneas passavam as duas pelo `SELECT` antes de
   qualquer uma inserir, criando duas solicitações pendentes. Índice único
   parcial `solicitacoes_plano_pendente_unica` (migration
   `20260729020000_solicitacao_plano_indice_unico.sql`, `ON
   solicitacoes_plano (associacao_id) WHERE status = 'pendente'`) garante
   isso no próprio Postgres; a rota trata a violação (`err.code ===
   '23505'`) com um 409 amigável. O `SELECT` antigo continua existindo só
   como saída rápida no caso comum — a garantia real agora é o índice.
   Testado disparando 2 requisições `curl` em paralelo de verdade (`&` +
   `wait`) — confirmado só uma linha `pendente` no banco depois.

**Todos os 5 testados em staging** com dados de teste criados e apagados
via `comConexaoSuperAdmin()`/`pool` direto (associações e super-admins de
teste, nunca produção). Nenhuma alteração em produção ainda — aguardando
decisão do usuário sobre quando aplicar as duas migrations lá.

**Itens de severidade baixa da mesma auditoria, NÃO corrigidos ainda**
(ficaram de fora do escopo desta rodada, o usuário priorizou só os
médios): upload de logo do Super Admin sem limite de tamanho como as
outras rotas de imagem; log de auditoria duplicando a logo em base64
inteira a cada edição de associação (mesmo sem tocar na logo); uma
mensagem de erro em `painel/index.html` (`/atividades`) inserida via
`innerHTML` sem escapar; `cidade`/`estado` não escapados no card
"Últimas associações" do Dashboard do Super Admin (self-XSS apenas, só o
próprio Super Admin escreve esse campo hoje); ~10 vulnerabilidades
transitivas da cadeia do `exceljs` (`npm audit`, sem fix sem downgrade
major). Também levantados nessa auditoria, fora do escopo de código:
ausência de envio real de e-mail (esqueci-senha só orienta contatar o
admin), ausência de política de privacidade/LGPD (a plataforma guarda
CPF/RG/endereço/foto), e o texto da landing page sobre "backups
automáticos diários"/"monitoramento contínuo" que não tem nenhuma
ferramenta configurada por trás ainda.

## Gating de funcionalidades por plano (Fase 2 da melhoria de planos, 29/07/2026)

Depois de renomear os planos (seção seguinte), implementado o gating de
verdade — antes disso nenhuma das funcionalidades que a `landing.html`
anuncia por plano tinha qualquer diferenciação no código, todas
funcionavam igual pra Básico/Intermediário/Avançado. Matriz confirmada
com o usuário antes de escrever código (mesmo cuidado que os perfis de
acesso granulares tiveram em 28/07):

| Funcionalidade | Básico | Intermediário | Avançado |
|---|:---:|:---:|:---:|
| Alertas automáticos de vencimento (editar) | ❌ | ✅ | ✅ |
| Perfis de acesso granulares (atribuir) | ❌ | ✅ | ✅ |
| Exportar leituras de comunicado (Excel/PDF) | ❌ | ✅ | ✅ |
| Carteirinha digital do associado | ❌ | ✅ | ✅ |
| Auditoria (ver + exportar) | ❌ | ❌ | ✅ |
| Limite de associados (50/200/∞) | aviso apenas, nunca bloqueia | | |

Três decisões de produto confirmadas antes de implementar:
1. **Grandfathering**: quem já usa uma funcionalidade continua usando —
   só bloqueia atribuir/configurar algo NOVO além do que o plano permite.
   Nenhuma migration de dados existentes, nenhum usuário/config existente
   é tocado.
2. **Limite de associados nunca bloqueia** — é só aviso/upsell no
   Dashboard (`GET /plano`, campos novos `limite_associados`/
   `perto_do_limite`). `POST /associados` continua sem nenhuma checagem
   de teto, de propósito.
3. **Enforcement é backend real (403) + esconder no front** — mesmo
   padrão de segurança já usado nos perfis granulares (28/07): esconder só
   no front nunca é a proteção de verdade.

**`utils/precos.js`** ganhou `NIVEL_PLANO` (hierarquia — `trial: 99,
basico: 1, intermediario: 2, avancado: 3`; trial recebe o nível mais alto
porque a promessa comercial da landing é "acesso completo a todos os
recursos" durante a avaliação), `planoAtendeNivel(planoAtual,
nivelMinimo)` e `LIMITE_ASSOCIADOS_PLANO` (`{ basico: 50, intermediario:
200, avancado: null }`, só informativo).

**`middleware/auth.js`** ganhou `exigirPlano(nivelMinimo)`, no mesmo
molde de `bloquearTrialExpirado` — usar depois de `autorizar(...)` na
rota. Reaproveita `req.usuario.plano`, que já vinha fresco do banco a
cada requisição desde o trial (ver seção "Plano Trial com expiração"
abaixo) — não precisou de nenhuma query nova. Resposta 403 padronizada:
`{ erro, codigo: 'PLANO_INSUFICIENTE', plano_necessario }`.

Aplicado:
- `PUT /configuracoes/alertas` → `exigirPlano('intermediario')`. `GET`
  continua liberado pra qualquer plano/papel (ler o valor atual não é o
  que está sendo vendido, configurá-lo é).
- `GET /comunicados/:id/leituras/exportar/:formato` →
  `exigirPlano('intermediario')`.
- `GET /auditoria` e `GET /auditoria/exportar/:formato` →
  `exigirPlano('avancado')` (mais restrito que o resto — nem o
  Intermediário libera).
- `POST /usuarios` e `PUT /usuarios/:id` (`routes/usuarios.js`) — **não**
  usa `exigirPlano` como middleware de rota inteira (a rota aceita vários
  papéis, só alguns são gated). Checagem condicional inline: só bloqueia
  quando `papel` do corpo da requisição é um de `PAPEIS_GRANULARES`
  (`financeiro/atendimento/operador/consulta`) **e** o plano não atende.
  Em `PUT`, como `papel` é opcional (`COALESCE` mantém o valor atual se
  não vier no corpo), editar só o nome de um usuário já-financeiro nunca
  passa pela checagem — é assim que o grandfathering funciona sem
  precisar de nenhuma lógica extra de "usuário legado".
- Carteirinha digital (`portal.html`) **não tem checagem de backend** —
  é montada inteiramente com dado que `GET /portal/meus-dados` já expõe
  pro próprio associado (nome, foto, categoria, status), não existe um
  recurso adicional pra proteger no servidor. O gate aqui é só de UI
  (esconder o botão), documentado como exceção deliberada à regra
  "backend + front" — não haveria o que bloquear no backend sem inventar
  uma rota nova só pra isso.

**JWT ganhou o claim `plano`** (`assinarToken`, `routes/auth.js`) — só
pra decisão de UI no front (qualquer papel de usuário, não só admin/
diretoria, precisa saber o plano pra esconder botão/aba). Buscado junto
no `SELECT` de `buscarUsuarioPorEmail` (`a.plano`, já tinha o JOIN com
`associacoes`). **Nunca é a fonte de verdade da permissão real** — o
bloqueio de fato é sempre `exigirPlano()` no backend, que revalida
`req.usuario.plano` fresco do banco a cada requisição (não confia no
claim do token, que pode ficar até 8h desatualizado se o plano mudar no
meio da sessão — mesmo caveat que já existia pra `papel`/`nome` antes
disso, não é uma classe nova de risco).

**`GET /plano`** ganhou `limite_associados` e `perto_do_limite` (>= 90%
da faixa do plano) — só leitura, `POST /associados` continua sem
nenhuma checagem de limite.

**Testado em staging** com 3 associações de teste (uma por plano,
`TESTE_GATING_basico/intermediario/avancado`, criadas e apagadas via
`comConexaoSuperAdmin`) via `curl` direto contra `node server.js` local
apontando pro banco de staging: os 3 gates 403 confirmados por plano
(alertas, auditoria, atribuir papel granular), grandfathering confirmado
(usuário `financeiro` inserido diretamente no banco pra simular "já
existia antes do gating" — login funcionou normalmente, editar só o nome
funcionou, trocar pra outro papel granular foi bloqueado, trocar pra um
papel não-granular como `diretoria` funcionou), export de leituras
bloqueado no Básico e funcionando no Intermediário (Excel real gerado,
6.5KB), `GET /plano` com `limite_associados`/`perto_do_limite` corretos
pros 3 planos.

## Planos renomeados: profissional/enterprise → intermediario/avancado (29/07/2026)

Alinhamento com a nova nomenclatura da landing page (`painel/landing.html`,
ver `painel/CLAUDE.md`): Básico/Intermediário/Avançado em vez de
Básico/Profissional/Enterprise. Preços e faixas de porte **não mudaram**,
só o nome.

Migration `20260729000000_renomear_planos_intermediario_avancado.sql`:
`ALTER TYPE plano_assinatura RENAME VALUE 'profissional' TO 'intermediario'`
e o mesmo para `'enterprise' TO 'avancado'`. **`RENAME VALUE` só troca o
rótulo no catálogo do tipo (`pg_enum`)** — o valor interno (oid) não muda,
então nenhuma linha de `associacoes.plano` precisou de `UPDATE`; qualquer
associação que já estava em `profissional` passa a aparecer como
`intermediario` automaticamente, sem migração de dados. Testado em staging
antes do deploy: `enum_range` confirmado (`trial, basico, intermediario,
avancado`), insert/select/update/delete numa associação de teste
(`TESTE_MIGRATION_PLANOS`, criada e apagada via `comConexaoSuperAdmin`) e
`calcularValorMensalidade()` batendo com os valores da landing page
(R$ 249,90 com 100 associados no Intermediário, R$ 499,90 com 300 no
Avançado).

Valores internos do enum continuam **sem acento** (`intermediario`,
`avancado`), seguindo o padrão já usado por `trial`/`basico` — acentuação
só existe nos rótulos exibidos no front (`ROTULOS_PLANO`/`INFO_PLANO`).

Atualizado em conjunto: `utils/precos.js` (chaves de `PRECOS_PLANO`),
`routes/plano.js` (`PLANOS_CONTRATAVEIS`, mensagem de erro de validação).
`routes/superadmin.js` não precisou de mudança — não tem whitelist própria
de valores de plano, o enum do banco já rejeita qualquer valor fora da
lista. Ver `painel/CLAUDE.md` pra a parte do front (`superadmin.html`,
`index.html`).

**Se migrar produção**: mesmo comando, rodado no SQL Editor do Supabase de
produção (`gahrgdpjuqfjkznqtszd`) depois de validado em staging — só
depois de confirmação explícita do usuário, seguindo o fluxo já
estabelecido pro projeto.

## Ambiente de homologação (staging) — novo (27/07/2026)

Até aqui só existia produção (ver seção seguinte). Passou a existir um
segundo ambiente completo, isolado, pra testar mudanças arriscadas antes de
chegar em produção:

- **Banco**: projeto Supabase próprio (novo, vazio), sem nenhuma relação com
  o de produção. Schema recriado do zero rodando, nessa ordem, a role
  `app_runtime` (script reconstruído manualmente — a criação original nunca
  foi versionada, ver `supabase/README.md`) e depois todas as migrations de
  `supabase/migrations/*.sql` em ordem cronológica.
- **Backend**: segundo Web Service no Render (`minha-associacao-backend-staging`
  ou nome equivalente), deploy a partir da branch `staging` deste
  repositório (não `main`) — mesmo código, `DATABASE_URL`/`JWT_SECRET`/
  `CORS_ORIGINS`/`BOOTSTRAP_SECRET` próprios, apontando pro Supabase de
  staging.
- **Front-end**: `painel/*.html` (branch `staging` do repo `painel`) resolve
  `API_URL` automaticamente pelo hostname (`location.hostname`) — em vez de
  valor fixo, localhost e o domínio de staging na Vercel usam o backend de
  staging; qualquer outro hostname (produção) usa o backend de produção.
  Isso existe assim de propósito: **não há divergência de código entre
  `main` e `staging`** nesse ponto, então mesclar uma branch na outra nunca
  arrisca "esquecer de reverter uma URL", como já tinha acontecido antes
  (ver nota em `painel/CLAUDE.md`).

**Fluxo de trabalho**: mudanças arriscadas (schema novo, RLS, mudança de
comportamento de auth) são testadas primeiro na branch `staging` — só
depois de validado ali, `staging` é mesclada em `main`, e o push pra `main`
segue exigindo confirmação explícita antes (já era assim, continua sendo).
Migrations aditivas simples continuam podendo ir direto pra produção
quando fizer sentido, a critério do usuário.

**JWT_SECRET de staging precisa ser diferente do de produção** — mesmo
raciocínio já documentado abaixo sobre local vs Render: um token assinado
num ambiente não pode ser aceito no outro.

**Runbook resumido pra recriar o backend de staging do zero** (o banco em
si está detalhado em `supabase/README.md`):
1. Supabase: novo projeto, com **"Enable Data API"**, **"Automatically
   expose new tables"** e **"Enable automatic RLS"** todos desmarcados na
   criação (não usamos a API própria do Supabase, e o schema já liga RLS
   manualmente tabela por tabela — automático quebraria `super_admins`,
   que é sem RLS de propósito).
2. Render: novo Web Service, branch `staging` deste repositório, nome
   `minha-associacao-backend-staging` (esse nome exato importa — é o que
   `painel/*.html` chama automaticamente ao detectar hostname de staging).
   Env vars: `DATABASE_URL` (pooler + role `app_runtime` de staging),
   `JWT_SECRET` (novo, `openssl rand -hex 32`), `CORS_ORIGINS` (domínio do
   painel de staging), `BOOTSTRAP_SECRET` (temporário, só pra criar o
   primeiro super-admin).
3. Depois do deploy, criar o primeiro super-admin com
   `POST /superadmin/bootstrap` (`nome`, `email`, `senha`,
   `bootstrap_secret` no corpo) — ver `routes/superadmin.js`.
4. Ver `painel/CLAUDE.md` pra a parte do Vercel (front-end).

## Regra mais importante deste repositório

**Desde 27/07/2026 existe staging (ver seção acima) — mas se você estiver
rodando algo localmente (`node server.js` na sua máquina) com uma
`DATABASE_URL` copiada de algum lugar, confirme QUAL projeto Supabase é
antes de rodar qualquer coisa.** Continua não existindo um "terceiro
banco" para desenvolvimento local: rodar local com a `DATABASE_URL` de
produção afeta produção diretamente; usar a de staging é seguro. Migrações
aditivas (novas tabelas/colunas/policies sem `FORCE`) são seguras a
qualquer momento; mudanças que afetam quem já está conectado (trocar
`DATABASE_URL` em produção, `FORCE ROW LEVEL SECURITY`) precisam ser
coordenadas com o deploy — ver `supabase/README.md`, seção RLS, que
documenta um incidente real causado por não seguir essa ordem.

**Isso aconteceu de verdade em 28/07/2026**: o `.env` local estava com a
`DATABASE_URL` de **produção** (`db.gahrgdpjuqfjkznqtszd.supabase.co`,
conexão direta, nem era o pooler) enquanto se acreditava (confirmado
verbalmente, sem checar de fato) que era staging. Dois fluxos de teste
ponta a ponta (upload de logo da associação, ficha do associado — ambos
criando associação/usuário de teste via `pool.query` direto e apagando
depois) rodaram sem querer contra produção antes do engano ser percebido
— só descoberto quando uma migration deu "column already exists" no
Supabase (sinal de que só produção já tinha aquela coluna). Sem dano
porque a limpeza dos dados de teste sempre rodou e foi conferida vazia
logo em seguida, mas foi sorte de o hábito de limpar já existir, não
segurança de processo. **Os dois refs corretos, pra conferir sempre antes
de rodar algo local:**
- Produção: `minha_associacao`, ref `gahrgdpjuqfjkznqtszd`.
- Staging: `minha-associacao-staging`, ref `dlthgkvvzyssmkzehksz`, pooler
  `aws-0-sa-east-1.pooler.supabase.com:5432`, usuário
  `app_runtime.dlthgkvvzyssmkzehksz`.

Não basta perguntar "é staging?" e aceitar um "sim" — conferir o próprio
host/ref da `DATABASE_URL` contra essa lista antes de rodar qualquer
script que crie/apague dado, mesmo que seja "só um teste rápido".

## Arquitetura em uma imagem

- `server.js` → monta as rotas, `config/env.js` valida env vars e derruba
  o processo se algo obrigatório faltar em produção
- `db.js` → pool de conexão, usa a role `app_runtime` (não-dona das
  tabelas) e valida o certificado SSL do Supabase de verdade
  (`config/supabase-ca.pem`). Tem `pool.on('error', ...)` (obrigatório —
  ver seção "Instabilidade intermitente" abaixo), `idleTimeoutMillis:
  30000` (30s, acima do padrão de 10s do `pg`, pra reduzir reconexões "a
  frio") e `max: config.poolMax` (env `DB_POOL_MAX`, default 10 — ver
  seção "Auditoria de escala" abaixo sobre por que isso multiplica por
  instância ao escalar horizontalmente)
- `middleware/auth.js` → `autenticar` (valida JWT + revalida contra o
  banco a cada request, com guarda de UUID e retry — ver seção
  "Instabilidade intermitente"), `autorizar(papeis...)`, e os helpers de
  conexão com bypass de RLS: `comConexaoTenant` (isolamento normal),
  `comConexaoSuperAdmin` (bypass para rotas do super-admin),
  `comConexaoAuth` (bypass só para login/redefinição de senha, que
  legitimamente não sabem o tenant de antemão)
- `routes/*.js` → uma rota por recurso, todas usando um dos helpers acima
  para tocar o banco (nunca `pool.query` direto em tabela com RLS, exceto
  `super_admins`, que não tem RLS)
- `supabase/migrations/*.sql` → schema, aplicado manualmente (sem
  ferramenta automatizada) — ver `supabase/README.md`
- `utils/precos.js` (novo, 24/07/2026) → tabela de preços por plano e
  cálculo de MRR (receita mensal recorrente), reutilizado por todas as
  rotas que precisam calcular valor da mensalidade
- `utils/atividadeLog.js` (novo, 25/07/2026) → `registrarAtividade()`,
  espelha `authLog.js`, grava na tabela `atividades` (log de quem fez o
  quê no painel da associação — não confundir com `auth_logs`, que é só
  login/logout/troca de senha)

## Super Admin — mudanças recentes (24/07/2026)

Reformulação completa trazendo conceitos de SaaS multi-tenant real:

- **Novo:** campos de plano/cobrança em `associacoes`: `plano` (enum trial/basico/profissional/enterprise), `valor_mensalidade_manual` (override de negociação), `vencimento_assinatura` (data), `forma_cobranca` (método), `cep`, `site`. Nova coluna em `usuarios`: `cpf`.
- **Novo:** `GET /superadmin/dashboard` retorna muito mais — KPIs com MRR, gráficos de crescimento/receita/distribuição (12 meses), alertas gerados por regras (vencimentos, clientes novos, mensalidades atrasadas).
- **Modificado:** `GET /superadmin/associacoes` agora retorna `valor_mensalidade` calculado + `status_assinatura` derivado (bloqueada/trial/vencida/vencendo/ativa), coluna de responsável (nome do admin), CPF.
- **Modificado:** `POST/PUT /superadmin/associacoes/:id` aceitam os novos campos.
- **Novo:** `utils/precos.js` com `calcularValorMensalidade()` (base + per-associate) e `statusAssinatura()` (derivado, nunca armazenado).

Esses valores de preço em `PRECOS_PLANO` são placeholders — revisar com o usuário (Julião) antes de considerar definitivos. Migration `20260724100000_plano_e_dados_associacao.sql` foi aditiva (todas colunas nullable, segura).

## Log de atividades para o Dashboard do painel da associação (25/07/2026)

Nova tabela `atividades` (`supabase/migrations/20260725120000_atividades.sql`,
aditiva, já nasce com `FORCE ROW LEVEL SECURITY` — tabela nova, sem ninguém
dependendo do comportamento sem RLS, então não tem o risco de deploy que
`FORCE` tem em tabela existente, ver seção RLS abaixo) alimenta o card
"Atividades recentes" do Dashboard reformado em `painel/index.html`.

- `utils/atividadeLog.js` (`registrarAtividade`) é chamado logo após o
  insert/update principal em: `POST/PUT /associados`, `PATCH
  /cobrancas/:id/pagar`, `POST /comunicados`, `POST /usuarios`. Cada
  chamada grava `descricao` já pronta em texto (ex. "cadastrou o associado
  Fulano") — não guarda um monte de campos estruturados pra montar a frase
  depois, é `usuario_nome` (snapshot) + `descricao` (texto).
- `middleware/auth.js` (`autenticar`) passou a buscar `u.nome` junto com
  `papel` na revalidação por request e anexar em `req.usuario.nome` —
  antes só existia `id/associacao_id/papel/email/deve_trocar_senha` (do
  JWT). Precisa disso pra saber "quem" registrar em cada atividade sem uma
  query extra em cada rota.
- Nova rota `GET /atividades` (`routes/atividades.js`, admin/diretoria):
  últimas ~15 da associação, mais recente primeiro.
- `GET /cobrancas` ganhou `p.pago_em` (LEFT JOIN `pagamentos`) — usado pelo
  Dashboard pra separar "Receitas" (por mês de vencimento) de "Pagamentos
  recebidos" (por mês de recebimento real) no gráfico de receita mensal.

**Migrations continuam só manuais, e por um motivo mais forte do que
"falta de tooling"**: a `DATABASE_URL` (local e produção) conecta como
`app_runtime`, que **não tem privilégio de DDL** (só
`SELECT/INSERT/UPDATE/DELETE`, por desenho). Um script Node local usando
`db.js` pra rodar uma migration nova falha com `permission denied for
schema public` — precisa colar o SQL no SQL Editor do Supabase (dono
`postgres`), como `supabase/README.md` já orienta.

## Conexão com o banco — usar sempre o Session Pooler do Supabase (25/07/2026)

`DATABASE_URL` **precisa** apontar para o Session Pooler do Supabase
(`aws-1-sa-east-1.pooler.supabase.com:5432`, não a conexão direta
`db.<projeto>.supabase.co:5432`). Motivo: a conexão direta do Supabase
exige IPv6, e o Render **não suporta IPv6 de saída** — trocar para a
conexão direta derruba o serviço inteiro (502 em todas as rotas). Isso já
aconteceu nesta sessão (trocado por engano achando que corrigiria um bug,
revertido em minutos). Se for mexer nessa variável de novo: confirmar
antes que o ambiente de destino suporta IPv6, ou usar sempre o pooler.

## Instabilidade intermitente do pooler — causa encontrada e mitigada (26-27/07/2026)

De vez em quando (mais depois de reconexões "a frio", ex. após um período
ocioso), `autenticar()` e a query de login do backend recebiam do Postgres
`invalid input syntax for type uuid: ""` (`code: 22P02`) — inclusive em
consultas com um parâmetro uuid válido, o que só é possível se a conexão
estiver recebendo uma resposta de **outra** query (algo do lado do pooler
do Supabase, Session Pooler confirmado).

**27/07/2026 — piorou de "raro" para ~100% das requisições, causa
identificada**: no dia anterior, `db.js` ganhou `statement_timeout: 20000`
no config do `Pool`. Isso **não vira um `SET` depois de conectar** — vira
parâmetro do próprio pacote de *startup* da conexão
(`node_modules/pg/lib/client.js:549`, `data.statement_timeout = ...`
mandado junto do handshake inicial). Tudo indica que o Session Pooler do
Supabase (PgBouncer) não repassa esse parâmetro de startup do jeito
esperado pro backend Postgres, deixando a conexão num estado inconsistente
desde a abertura — e como toda rota abre uma conexão nova a cada request
(por causa do isolamento por tenant via `SET` de sessão), isso afetava
praticamente toda chamada autenticada. **Removido.** Se precisar de um
timeout de statement no futuro, aplicar via `SET statement_timeout = ...`
numa query separada logo após conectar (dentro de
`comConexaoComSessao`), nunca via essa opção do `Pool`/`Client`.

Isso não invalida a suspeita original de "resposta de outra query vazando
pela conexão" — é bem possível que sejam a mesma classe de bug
(protocolo/estado da conexão ficando dessincronizado com o PgBouncer), só
que o `statement_timeout` no startup packet tornou a condição que dispara
o problema muito mais fácil de acontecer. Com ele removido, o sintoma
voltou a ser raro (mesmo comportamento de antes de 26/07).

**Mitigações permanentes que continuam valendo**:
- `db.js`: `pool.on('error', ...)` — sem isso, um cliente ocioso derrubado
  pelo Supabase gerava um evento `'error'` não tratado que **derrubava o
  processo Node inteiro**.
- `middleware/auth.js`: `comConexaoComSessao()` — toda conexão com estado
  de sessão (`comConexaoTenant`/`SuperAdmin`/`Auth`) passa por aqui. Se o
  `SET` inicial falhar, a conexão é destruída com `client.release(err)`
  (nunca volta pro pool nesse estado) e a operação tenta de novo uma vez
  com uma conexão nova.
- `autenticar()`: guarda de UUID antes de consultar (`payload.id` inválido
  → 401 limpo, não 500) + retry de uma tentativa própria, em cima do retry
  de `comConexaoComSessao`.
- `server.js`: `express-async-errors` + error handler global — nenhuma
  rota pode mais terminar **sem responder nada** (ver seção abaixo, esse
  era um bug maior que a instabilidade do pooler em si).

**Se voltar a acontecer**: pegar o erro exato do log do Render (o
`console.error(err)` de `autenticar()`/error handler mostra a query e o
código `22P02`) e considerar abrir chamado com o suporte do Supabase.

**27/07/2026 (continuação) — voltou a acontecer em staging, retry reforçado
em 3 pontos**: o mesmo sintoma apareceu várias vezes no ambiente de
staging (não produção) no mesmo dia em que staging foi criado, inclusive
sem eu estar rodando nenhum script pesado num dos casos — sugere que o
projeto Supabase de staging pode ter um pooler com menos fôlego que o de
produção (plano/tier menor, vale o usuário conferir no dashboard). Reforço
aplicado enquanto isso (não resolve a causa raiz, reduz a chance do
usuário ver o erro): `autenticar()`, `comConexaoComSessao()` (usada por
`comConexaoTenant`/`SuperAdmin`/`Auth`) e `buscarUsuarioPorEmail()` (login)
foram de 2 para **3 tentativas**, com uma espera curta e crescente entre
elas (`150ms * tentativa`, função `aguardar()`) em vez de tentar de novo
imediatamente na mesma janela ruim. `autenticarSuperAdmin()` **não tinha
nenhum retry antes** (usava `pool.query()` direto, sem a proteção que as
outras três já tinham) — ganhou o mesmo tratamento agora, é provavelmente
a rota que mais aparecia pro usuário como "Erro ao validar sessão" sem
chance de se recuperar sozinha.

**Cuidado ao investigar**: testes de diagnóstico pesados (dezenas/centenas
de conexões em sequência rápida) contra produção podem eles mesmos causar
ou piorar a instabilidade. Preferir requisições sequenciais e espaçadas ao
investigar esse sintoma especificamente — foi assim que a causa de 27/07
foi encontrada (comparação direta: mesma query, mesmo `db.js`, rodando
localmente contra o mesmo banco de produção funcionava 100% das vezes;
só falhava vindo do processo do Render, o que descartou hipóteses de
dado/query e apontou pra configuração específica da conexão).

## Requisição nunca mais fica pendurada sem resposta (27/07/2026)

Achado durante a investigação acima, mas é um bug maior e independente:
no Express 4, uma exceção lançada dentro de um handler `async` **não vira
resposta de erro** — vira uma rejeição de Promise não tratada. Como toda
rota faz `const client = await comConexaoX()` **antes** do `try`, se essa
linha lançasse (ex.: pool entregando uma conexão que o Supabase já tinha
derrubado por ociosidade), a exceção nunca chegava a um `catch`: a
requisição ficava pendurada até o navegador desistir sozinho, sem status
HTTP nenhum. Sintoma pro usuário: "o sistema trava/fica instável", sem
nenhum erro visível — bem mais confuso de diagnosticar que um 500 comum.

Corrigido com duas camadas:
- `express-async-errors` (require logo depois de `require('express')` em
  `server.js`) — faz exceção assíncrona chegar no error handler do
  Express, que sozinho só pega erro síncrono.
- Error handler global no fim de `server.js` — sempre devolve
  `{ erro: 'Erro interno do servidor' }` com status 500 se nada mais
  respondeu. Rede de segurança para qualquer rota que ainda não trate um
  erro específico.

`db.js` ganhou `connectionTimeoutMillis: 10000` (só client-side, um timer
local — não manda nada a mais pro servidor, seguro com o Session Pooler)
para `pool.connect()` falhar com erro claro em vez de esperar pra sempre
quando o pool está cheio.

## Rate limit geral por IP (27/07/2026)

`limiteGeral` (`middleware/rateLimiter.js`) subiu de 300 para 1000
requisições por 15 min. O limite é por IP, e várias pessoas da mesma
associação normalmente saem pelo mesmo IP (mesma rede/escritório) — elas
dividem essa cota. Só abrir o Dashboard já dispara ~5 chamadas em
paralelo; multiplicado por várias pessoas trocando de aba ao mesmo tempo,
300 esgotava rápido e virava 429 confundido com instabilidade. Login e
redefinição de senha continuam com limites próprios e bem mais rígidos
(`limiteLogin`/`limiteRedefinicao`), que é onde o controle de força bruta
realmente importa — não foram tocados.

## Auditoria de segurança — XSS armazenado e permissões (27/07/2026)

Achados numa análise de segurança pedida pelo usuário, confirmados com PoC
antes de corrigir (não só suposição):

**Crítico — XSS armazenado, corrigido em duas camadas.** A validação de
upload (`comprovante_base64`, `foto_base64`, `logo_base64`) era só um
`startsWith('data:image/')` — o resto da string era livre. Como o
front-end (`painel/*.html`) montava `<img src="...">` por concatenação, um
valor com aspas escapava do atributo: um comprovante enviado por um
cliente executava script na sessão de quem abrisse a tela (ex.: um admin
de associação sobe um comprovante malicioso na contratação de plano → o
Super Admin abre pra aprovar → script roda com o JWT do Super Admin no
`localStorage` → acesso a todas as associações). Confirmado rodando o
payload de verdade num PoC isolado antes de corrigir.

Corrigido com:
- `utils/validacao.js`: `dataUrlValido()`/`imagemBase64Valida()`/
  `comprovanteBase64Valido()` — exige alfabeto base64 estrito (sem aspas,
  `<`, `>` possíveis) e MIME de uma lista fechada (PNG/JPEG/GIF/WEBP/PDF
  conforme o caso). **SVG é rejeitado de propósito** — é vetor de XSS
  (pode conter `<script>`), mesmo sendo tecnicamente uma "imagem".
  Aplicado em `routes/plano.js`, `routes/portal.js`, `routes/superadmin.js`
  (logo da associação).
- Front-end (`painel/CLAUDE.md` tem o detalhe): parou de montar HTML por
  concatenação nesses pontos, usa `createElement` + `.src`/`.href`.

As duas camadas existem de propósito — mesmo que um sink novo apareça no
front no futuro, o dado gravado no banco já não pode carregar um ataque.

**Alto — senha provisória de super-admin nunca expirava de fato.**
`autenticarSuperAdmin` não checava `deve_trocar_senha` (só o front-end
mostrava o modal de troca obrigatória). Agora bloqueia toda a API com 403
`SENHA_PROVISORIA_PENDENTE`, liberando só `PUT /perfil/senha` — mesmo
padrão que já existia pros usuários de associação
(`bloquearSenhaProvisoria`).

**Alto — papel `suporte` tinha poder demais.** Só `/admins/*` e
`/configuracoes-plataforma` checavam nível de permissão; na prática
`suporte` conseguia `DELETE /associacoes/:id` (apaga em cascata) e
`PATCH .../resetar-senha-admin` (toma conta de qualquer cliente,
recebendo a senha nova na resposta). Modelo de menor privilégio novo em
`routes/superadmin.js` (constante `GESTAO = ['super_admin',
'administrador']`): exclusão de associação exige `super_admin`; criar/
editar associação, resetar senha de cliente, aprovar/rejeitar contratação
e exportar logs em massa exigem `GESTAO`; `suporte` mantém acesso de
leitura a tudo (dashboard, associações, logs).

**Médio**: `helmet` adicionado em `server.js` (HSTS, `nosniff`,
`frame-options`, remove `X-Powered-By`). CSP equivalente em
`painel/vercel.json` (detalhe em `painel/CLAUDE.md`).

**Pendências dessa análise, não corrigidas ainda** (prioridade menor):
falsificação do log de auditoria (o nome exibido nas descrições vem de
`req.usuario.nome`, sem restrição de conteúdo), formula injection no
Excel exportado por `utils/exportarLogs.js` (nome/descrição com `=...`
vira fórmula ativa ao abrir), JWT não é invalidado ao trocar senha
(token roubado continua válido até expirar, até 8h), 10 vulnerabilidades
de dependências (`npm audit`, cadeia `exceljs → archiver → glob`), race
condition em `POST /plano/solicitar-contratacao` (checagem de pendente e
INSERT não são atômicos).

## Auditoria de escala (25/07/2026)

Segunda rodada de auditoria, diferente da de 24/07 (focada em
vulnerabilidades críticas) — essa foi motivada pelo usuário querer escalar
para mais associações-cliente e pedir que não haja falhas, nem de
aplicação nem de segurança. Achados corrigidos (commits `8040bbf` e
`1dfe16a`):

- **`trust proxy` ausente** — o Render fica na frente do app como proxy
  reverso (1 hop). Sem `app.set('trust proxy', 1)` em `server.js`, o
  `express-rate-limit` via o IP interno do proxy pra todo mundo, ou seja,
  o limite de tentativas de login (`limiteLogin`, 10/15min) era
  **compartilhado entre todos os clientes** em vez de por IP de verdade —
  um usuário errando a senha algumas vezes podia bloquear o login de
  todo mundo. Corrigido.
- **Pool sem tamanho explícito** — `db.js` usava o padrão implícito de 10
  conexões do `pg`. Agora é `max: config.poolMax` (env `DB_POOL_MAX`,
  default 10, sem mudar nada hoje). Importante pra quando for escalar:
  **toda rota usa uma conexão dedicada do pool** (`pool.connect()` via
  `comConexaoTenant`/`comConexaoSuperAdmin`/`comConexaoAuth`), nunca
  `pool.query()`, porque o isolamento por RLS depende de `SET` de sessão
  (por conexão). Isso significa que escalar para N instâncias no Render
  multiplica o total de conexões no Session Pooler do Supabase por
  `N × DB_POOL_MAX` — **conferir o limite de conexões do plano do
  Supabase antes de aumentar o número de instâncias**, senão o sintoma na
  hora do pico é erro de "too many connections" batendo em vários
  clientes ao mesmo tempo.
- **Rate limit geral** (`limiteGeral`, 300 req/15min por IP, em
  `middleware/rateLimiter.js`) aplicado a toda a API em `server.js`,
  antes de `express.json()` de propósito (rejeita rajada antes de gastar
  tempo com parse de corpo grande). Antes só login/redefinição de senha
  tinham algum limite — o resto das ~25 rotas (incluindo
  `/auth/esqueci-senha`, pública) não tinha proteção nenhuma contra
  rajadas.
- **bcrypt fora da conexão emprestada do pool** — `bcrypt.hash`/`compare`
  é deliberadamente lento (~50-100ms de CPU) e antes rodava com uma
  conexão do pool já emprestada (às vezes com transação aberta via
  `BEGIN`), segurando-a mais tempo que o necessário sob carga
  concorrente. Movido para antes de abrir a conexão em:
  `POST /associados`, `POST /usuarios`, `POST /superadmin/associacoes`,
  `PATCH /superadmin/associacoes/:id/resetar-senha-admin`,
  `POST /auth/redefinir-senha` (senha nova é gerada/hasheada sem
  depender do token ser válido). `PUT /auth/senha` é o único caso que
  precisa mesmo ler o hash atual do banco antes de poder comparar — ali
  a solução foi usar **duas conexões separadas** (lê e libera, depois
  compara/hasheia, depois abre outra pra escrever).

Testado localmente contra produção (associação + usuário de teste criados
via `pool.connect()` + `set_config('app.superadmin_bypass', ...)`, todos
os fluxos afetados testados via `curl`, depois removidos com `DELETE FROM
associacoes WHERE nome = 'TESTE_AUDITORIA_TEMP'`) antes do deploy.

**Pendências identificadas, prioridade menor** (não implementadas ainda):
sem `helmet`/cabeçalhos de segurança (`X-Powered-By: Express` vazando);
sem paginação em `/associados`/`/cobrancas`; toda requisição autenticada
faz uma query extra pra revalidar o token (dá pra cachear em memória por
poucos segundos sem perder a revogação quase-imediata); fotos/comprovantes
em base64 dentro do Postgres (`foto_base64`, `comprovante_base64`,
`logo_base64`) — migrar pra Supabase Storage/S3 evita dor ao crescer.

## Gerenciamento de administradores da plataforma (Fase 1 da melhoria do Super Admin, 26/07/2026)

`super_admins` ganhou `papel` (enum `papel_super_admin`: `super_admin`/`administrador`/`suporte`), `ativo` e `deve_trocar_senha` (migration `20260726090000_admins_papel_e_status.sql`, aditiva). `autenticarSuperAdmin` (middleware/auth.js) virou async e passou a revalidar `ativo`/`papel` a cada requisição — mesmo raciocínio de `autenticar()`, sem isso desativar um admin só valeria depois do token expirar (até 8h). Novo helper `autorizarSuperAdmin(...papeis)` restringe rotas por nível de permissão.

Novas rotas em `routes/superadmin.js`, todas exigindo papel `super_admin` exceto a última:
- `GET/POST/PUT /superadmin/admins`, `PATCH /superadmin/admins/:id/status` (ativar/desativar), `PATCH /superadmin/admins/:id/senha` (redefine senha de outro admin, senha provisória com troca obrigatória — mesmo padrão de `resetar-senha-admin`)
- `PUT /superadmin/perfil/senha` — qualquer super-admin troca a própria senha (não exige papel específico)

Guardas de segurança em `/admins/:id/status`: bloqueia desativar a própria conta e bloqueia desativar o último `super_admin` ativo da plataforma (evita lockout total). Edição (`PUT /admins/:id`) bloqueia um admin mudar o próprio papel. `POST /superadmin/login` agora checa `ativo`, retorna `id`/`papel`/`deve_trocar_senha`.

Testado localmente contra produção (3 super-admins de teste criados via `pool.query` direto — `super_admins` não tem RLS —, todos os fluxos exercitados via curl e visualmente no `superadmin.html`, depois removidos com `DELETE FROM super_admins WHERE email IN (...)`).

## Auditoria central (Fase 2 da melhoria do Super Admin, 26/07/2026)

Nova tabela `logs_auditoria` (migration `20260726110000_logs_auditoria.sql`) — log cross-tenant pra tela "Auditoria" do Super Admin, diferente de `atividades` (feed leve do Dashboard de uma associação) e `auth_logs` (só login/logout/senha). `utils/auditoria.js` (`registrarLogAuditoria`) é chamado logo depois de `registrarAtividade`/`registrarEventoAuth` em praticamente toda rota que muda dado: `associados.js`, `usuarios.js`, `cobrancas.js`, `comunicados.js`, `configuracoes.js` (tenant, via `comConexaoTenant`), `auth.js` (login/logout/troca de senha) e `superadmin.js` (login do super-admin — não era logado em lugar nenhum antes —, CRUD de associações e de administradores).

Segue o mesmo padrão de RLS de `auth_logs`: `FOR INSERT WITH CHECK (true)` (sempre permitido, controlado só pelo código) + `SELECT` restrito por tenant ou bypass do super-admin. `associacao_id` usa `ON DELETE SET NULL` (não `CASCADE`) de propósito — excluir uma associação não pode apagar o próprio histórico de auditoria dela, inclusive o registro da exclusão em si.

**Descoberta não-óbvia, achada limpando dados de teste**: como só existem policies de `INSERT`/`SELECT` (nenhuma de `UPDATE`/`DELETE`), o Postgres nega silenciosamente qualquer tentativa de apagar ou editar uma linha via `app_runtime` — nem o próprio super-admin consegue apagar um log pela API. Isso é uma proteção real (ninguém encobre rastro apagando registro), mantida de propósito, mas também significa que **limpar dado de teste dessa tabela específica exige rodar o `DELETE` direto no SQL Editor do Supabase** (só o dono `postgres` bypassa RLS por completo), o mesmo tipo de limitação que já existia pra DDL — só que aqui é a própria política de RLS, não falta de privilégio da role.

Para diffs de edição (`dados_anteriores`/`dados_novos`, jsonb), o padrão é: um `SELECT` do estado atual antes do `UPDATE`/`DELETE` (uma query a mais por rota de edição, aceitável) e o `RETURNING` do próprio comando como "depois". `tipo_acao` distingue `edicao` de `alteracao_permissoes` comparando o campo `papel` antes/depois (usado em `usuarios.js` PUT e `superadmin.js` PUT /admins/:id).

Novas rotas em `routes/superadmin.js`: `GET /superadmin/logs` (filtros: `usuario`, `associacao`, `modulo`, `tipo_acao`, `data_inicio`, `data_fim`; paginação `pagina`/`por_pagina`; ordenação `ordenar=asc|desc`) e `GET /superadmin/logs/exportar/:formato` (`excel`|`pdf`, mesmos filtros, sem paginação, limitado a `LIMITE_EXPORTACAO` = 5000 linhas pra não estourar memória, e a própria exportação vira uma linha de auditoria com `tipo_acao: 'exportacao'`). Geração dos arquivos em `utils/exportarLogs.js`, usando `exceljs` (novo em `package.json`) e `pdfkit` (novo, sem suporte nativo a tabela — desenhado manualmente com colunas de largura fixa e quebra de página).

`npm install` de `exceljs`/`pdfkit` trouxe ~10 vulnerabilidades transitivas (`brace-expansion`/`glob` dentro da cadeia do `archiver` que o `exceljs` usa pra montar o `.xlsx`) — mesma categoria já aceita como pendência de baixo risco no projeto (ver "Auditoria de escala" abaixo); não achei justificativa pra forçar downgrade do `exceljs` por causa disso.

## Dashboard compacto do Super Admin (Fase 3 da melhoria do Super Admin, 26/07/2026)

Sem migration nem rota nova — só ajustes de compatibilidade em rotas já existentes de `routes/superadmin.js` pra alimentar os 3 cards de "últimas" do Dashboard reformulado (detalhe do front em `painel/CLAUDE.md`): `GET /superadmin/admins` e `GET /superadmin/associacoes` passaram a aceitar `?limite=N` (cap 1000, `LIMIT` direto na query) pra listagens curtas sem precisar de paginação de verdade; `GET /superadmin/logs` passou a aceitar `?limite=N` como atalho — se vier sozinho (sem `pagina`/`por_pagina`), usa esse valor como `LIMIT` simples (cap 100) em vez do fluxo normal de paginação.

**Bug real desta fase, só no front, sem nenhuma mudança de backend envolvida**: a reforma do Dashboard removeu elementos do HTML (`<canvas>` de receita/planos, painel de alertas) mas deixou código JS ainda referenciando os ids removidos — `getElementById` retornando `null` lançava exceção no meio do `.then()` de `carregarDashboard()`, impedindo tudo que vinha depois (as 3 chamadas de "últimas") de executar. Corrigido só em `superadmin.html`, nenhuma rota de backend precisou mudar. Detalhe completo em `painel/CLAUDE.md`, seção "Dashboard compacto e menu mobile".

## Plano Trial com expiração + contratação self-service (26/07/2026)

Migration `20260727000000_plano_trial_e_contratacao.sql`: `associacoes` ganhou `trial_dias` (configurável por associação, default 15) e `trial_expira_em` (calculado na criação: `now() + trial_dias`). `utils/precos.js` (`statusAssinatura`) agora distingue `trial` de `trial_expirado` comparando `trial_expira_em` com a hora atual.

**Middleware novo, `bloquearTrialExpirado`** (`middleware/auth.js`), aplicado logo depois de `bloquearSenhaProvisoria` em todo router de tenant (`associados`, `atividades`, `cobrancas`, `comunicados`, `configuracoes`, `portal`, `usuarios`) — retorna 403 com `codigo: 'TRIAL_EXPIRADO'` pra qualquer rota normal quando o trial já venceu. `autenticar()` passou a trazer `plano`/`trial_expira_em` frescos do banco (mesmo padrão de `papel`/`nome`) pra esse middleware não precisar de outra query. **De propósito não aplicado em `routes/plano.js`** — essa rota precisa continuar funcionando mesmo com o trial vencido, senão a associação nunca conseguiria contratar um plano pra sair do bloqueio.

**`routes/plano.js` (novo arquivo)**: `GET /plano` (admin e diretoria, só leitura — devolve status/trial/valor calculado/Pix da plataforma/solicitação pendente) e `POST /plano/solicitar-contratacao` (só admin — cria uma linha em `solicitacoes_plano`, mesma validação de comprovante de `portal.js` copiada literalmente: obrigatório, máx. ~2.8MB, `data:image/` ou `data:application/pdf`). Bloqueia solicitação duplicada (409) se já existe uma `pendente`.

**Nova tabela `solicitacoes_plano`**: fluxo de contratação é manual, sem gateway de pagamento — a associação escolhe um plano pago, vê um QR Pix, envia comprovante, e fica "pendente" até o Super Admin aprovar (`PATCH /superadmin/solicitacoes-plano/:id/aprovar`, ativa o plano + `vencimento_assinatura = hoje + 30 dias`) ou rejeitar (com motivo opcional). RLS: `INSERT`/`SELECT` por tenant + bypass do super-admin, `UPDATE` só bypass do super-admin (a associação nunca edita a própria solicitação depois de enviada). `ON DELETE CASCADE` em `associacao_id` aqui (diferente de `logs_auditoria`) — excluir a associação também remove a solicitação, não tem razão pra manter órfã.

**Nova tabela `configuracoes_plataforma`** (singleton, padrão `id boolean PRIMARY KEY DEFAULT true` + `CHECK (id)`): guarda a chave Pix **da própria plataforma** (Carregando Ideias), usada no QR Code que a associação escaneia pra pagar a mensalidade — completamente separada da chave Pix de cada associação (`associacoes.chave_pix`, usada por ela pra cobrar os próprios associados). RLS: `SELECT` liberado geral (`USING (true)` — não é dado sensível, é literalmente pra aparecer num QR escaneável, e toda associação precisa ler isso), `UPDATE` só bypass do super-admin. **Cuidado ao editar essa tabela**: como a policy de `UPDATE` exige `app.superadmin_bypass`, um `UPDATE` feito com `pool.query()` direto (sem `comConexaoSuperAdmin()`) "funciona" sem erro mas afeta 0 linhas — bug real cometido e corrigido nesta mesma sessão em `PUT /superadmin/configuracoes-plataforma`, atenção pra não repetir em rotas futuras que toquem tabelas com policy de UPDATE restrita.

Novas rotas em `routes/superadmin.js`: `GET /solicitacoes-plano` (`?status=pendente|todas`), `GET /solicitacoes-plano/:id/comprovante`, `PATCH .../aprovar`, `PATCH .../rejeitar`, `GET`/`PUT /configuracoes-plataforma` (só `papel: 'super_admin'`). Dashboard (`GET /superadmin/dashboard`) ganhou `solicitacoes_pendentes_plano` e um alerta quando > 0. `POST`/`PUT /associacoes` aceitam `trial_dias` agora (cap 1-365 dias).

## Backlog de sprint (melhorias/bugs) — novo (27/07/2026)

Nova tabela de nível de plataforma `sprint_itens` (migration
`20260727100000_sprint_itens.sql`) — o usuário (Julião) registra
melhorias/bugs pela tela nova `painel/sprint.html`, e uma sessão de IA lê
esse backlog (`GET /sprint`) pra aplicar o que foi combinado, marcando o
item como `em_andamento`/`concluido` (`PATCH /sprint/:id/status`, aceita
`notas_aplicacao` pra registrar o que foi feito/onde) ao longo do
trabalho. Sem relação com nenhuma associação-cliente — mesmo padrão de
RLS de `configuracoes_plataforma`/`solicitacoes_plano`: sem policy de
tenant, todo acesso (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) exige
`app.superadmin_bypass`. Novo arquivo `routes/sprint.js`, usa
`autenticarSuperAdmin`/`comConexaoSuperAdmin` (qualquer papel de
super-admin, não só `super_admin` — é ferramenta interna, não algo
sensível de dado de cliente). `tipo` (`melhoria`/`bug`), `prioridade`
(`baixa`/`media`/`alta`/`urgente`), `status`
(`pendente`/`em_andamento`/`concluido`/`cancelado`) são enums novos.

## Auditoria por associação + navegação final de Acessos/Parametrização (item de sprint 4, etapa 2, 27/07/2026)

Ajuste pedido depois da etapa 1: a estrutura final não é "Configurações"
com sub-abas Usuários+Parametrização — é **"Acessos"** na sidebar
(Usuários + Auditoria) e **"Parametrização"** só alcançável pelo
"Preferências" do header, sem item próprio na sidebar. Ver
`painel/CLAUDE.md` pra como isso ficou na navegação.

Rota nova `routes/auditoria.js` (montada em `/auditoria`, `server.js`),
espelhando `GET /superadmin/logs` só que já escopado por tenant — **não
precisou de política de RLS nova**: `logs_auditoria_select_tenant` (`WHERE
associacao_id = current_setting('app.current_associacao_id')::uuid`) já
existia desde a Fase 2 do Super Admin (`20260726110000_logs_auditoria.sql`),
só nunca tinha ganhado uma rota própria pro admin/diretoria de uma
associação consultar os próprios logs — todas as rotas que já chamam
`registrarLogAuditoria()` (associados/cobrancas/comunicados/usuarios/
configuracoes/auth/plano) já estavam alimentando essa tabela desde 26/07,
os dados já existiam, só não tinham como ser vistos por quem não fosse
Super Admin.

`GET /auditoria` e `GET /auditoria/exportar/:formato` reaproveitam
`construirFiltros`/paginação no mesmo formato de `superadmin.js`, mas sem
os campos que não fazem sentido num tenant único (`associacao`,
`administradores` como módulo). Export reaproveita `gerarExcelLogs`/
`gerarPdfLogs` de `utils/exportarLogs.js` **sem nenhuma mudança** — as
colunas genéricas (usuário/associação/módulo/ação/descrição/ip) já
funcionam aqui, `associacao_nome` só fica vazio (`—`) porque a query
tenant não faz join com `associacoes`, inofensivo.

## Reestruturação da sidebar — "Acessos e Usuários" (item de sprint 4, etapa 1, 27/07/2026)

Primeira etapa (só a de "Acessos e Usuários") do pedido maior de unificar
Usuários + Configurações num só menu "Configurações" com submenus — as
demais seções de Parametrização (Financeiro/Alertas/Comunicação/
Associados/Sistema/Segurança/Integrações) ficam pra sprints futuras, a
pedido do usuário, um item por vez.

`routes/usuarios.js`:
- `GET /` ganhou `ultimo_acesso` (subquery `MAX(auth_logs.criado_em) WHERE
  evento = 'login_sucesso'` por usuário — não precisou de coluna nova,
  `auth_logs` já registrava isso desde sempre, só nunca tinha sido
  exposto). `criado_em` já vinha, agora é usado no front também.
- `PATCH /:id/reativar` (novo) — inverso de `/:id/desativar`, que já
  existia; antes não tinha como reverter uma desativação pela UI.
- `PATCH /:id/redefinir-senha` (novo) — gera senha provisória nova
  (`deve_trocar_senha = true`), mesmo padrão de "credenciais geradas" já
  usado em toda a plataforma. **`POST /:id/gerar-link-redefinicao` (rota
  antiga, token + e-mail) nunca teve consumidor no front-end** — descoberto
  ao procurar onde ficava "alterar senha" na tela de Usuários e não achar
  nada; ficou órfã desde que foi criada. Não removida (pode ter uso futuro
  com envio de e-mail de verdade), só documentada aqui pra não confundir.

**Não implementado nessa etapa, de propósito** — "Perfil de acesso"
(Administrador/Financeiro/Atendimento/Operador/Somente Consulta) e RBAC
granular: o pedido original já dizia "quando implementado"/"estrutura
preparada", ou seja, é reconhecidamente trabalho futuro. Adicionar esses
papéis exigiria alterar o enum `papel` no banco e revisar toda chamada
`autorizar(...)` do projeto — perigoso demais pra entrar de brinde numa
etapa que era só reorganização de navegação. Fica registrado aqui como
pendência conhecida pra quando o usuário pedir essa etapa especificamente.

## Confirmação de leitura dos comunicados (item de sprint 3, 27/07/2026)

`GET /comunicados` ganhou `total_destinatarios` (contagem de `usuarios`
`papel='associado'` `ativo` da associação — mesmo critério usado nas
rotas novas abaixo). `categoria_alvo` continua sendo só rótulo informativo
(não filtra quem recebe, ver comentário já existente na rota) — por isso
o universo de destinatários é "todo associado ativo com login", não
filtrado por categoria.

Duas rotas novas em `routes/comunicados.js` (admin/diretoria):
- `GET /comunicados/:id/leituras` — devolve `{ titulo, leituras: [...] }`,
  uma linha por `usuario` `papel='associado'` `ativo` da associação
  (`LEFT JOIN comunicado_leituras`), com `lido`/`lido_em`. Como
  `comunicado_leituras` tem `UNIQUE(comunicado_id, usuario_id)`,
  `criado_em` já É a primeira (e única) leitura — não precisou de coluna
  nova pra "primeira visualização". Sem paginação (mesma lógica de
  `GET /cobrancas?associado_id=X`, filtro fica no front) — se uma
  associação muito grande (milhares de associados) sentir lentidão aqui,
  vale paginar depois.
- `GET /comunicados/:id/leituras/exportar/:formato` (`excel`|`pdf`) —
  `utils/exportarLeiturasComunicado.js` (novo, mesmo padrão de
  `utils/exportarLogs.js`: `exceljs`/`pdfkit`, PDF desenhado manualmente).
  Registra a própria exportação como linha de auditoria (`tipo_acao:
  'exportacao'`), mesmo padrão de `GET /superadmin/logs/exportar/:formato`.

**Não implementado, era "opcional" no pedido**: dispositivo usado na
leitura — `comunicado_leituras` não tem coluna pra isso, exigiria
capturar `User-Agent` em `POST /comunicados/:id/marcar-lido` e uma
migration nova. Fica pra quando/se for pedido de verdade.

## Ficha completa do associado + histórico financeiro/comunicados (itens de sprint 2.1-2.3, 27/07/2026)

`associados` ganhou 8 colunas novas (migration `20260727150000_ficha_associado.sql`,
aditiva): `rg` e endereço estruturado (`endereco_cep`, `endereco_logradouro`,
`endereco_numero`, `endereco_complemento`, `endereco_bairro`,
`endereco_cidade`, `endereco_estado`). Sem campo de veículo — descartado
explicitamente pelo usuário. "Plano contratado" da ficha **não é campo
novo**, é o `categoria` já existente, só relabelado na UI.

`GET/POST/PUT /associados` (`routes/associados.js`) passaram a
selecionar/aceitar essas colunas, além de `criado_em` (não vinha antes).

**2.2 (histórico financeiro) não precisou de rota nova** — `GET
/cobrancas?associado_id=X` já existia e já tinha tudo (valor, vencimento,
`pago_em`, `metodo`, `status`/`status_exibicao`, `tem_comprovante`);
`GET /cobrancas/:id/comprovante` também já existia. O filtro por
período/ano é só client-side (`painel/index.html`), sem parâmetro novo na
API.

**2.3 (histórico de comunicados) ganhou rota nova**: `GET
/associados/:id/comunicados` (admin/diretoria), aceita `?lido=lidos` ou
`?lido=nao_lidos` (ausente = todos). Mesma regra de visibilidade que o
associado teria no portal dele — só comunicados `status = 'ativo'` já
`publicado_em <= now()` (ver `routes/comunicados.js`) — join com
`comunicado_leituras` pelo `usuario_id` do associado (`associados.usuario_id`,
pode ser `null` se a conta de login foi removida; nesse caso tudo aparece
como não lido, comportamento aceitável).

## Alerta inteligente de renovação do plano (item de sprint 1.4, 27/07/2026)

`associacoes` ganhou `dias_alerta_assinatura` (migration
`20260727140000_alerta_vencimento_assinatura.sql`, aditiva, default 30) —
configurável só pelo Super Admin, por associação, num select fechado
(`30/20/15/10/7/3`, `DIAS_ALERTA_ASSINATURA_VALIDOS` em
`routes/superadmin.js`, validado no `POST`/`PUT /associacoes`). **Não
confundir com `dias_alerta_vencimento`**, coluna mais antiga e
semanticamente diferente: essa é sobre cobranças pendentes dos
*associados* de cada associação (mensalidades), configurada pela própria
associação em Configurações; a nova é sobre o vencimento da *assinatura da
associação com a plataforma*.

`utils/precos.js` ganhou `alertaAssinatura(associacao, hoje)` — devolve
`null` fora da janela configurada (nada a mostrar), ou
`{ tipo: 'trial'|'assinatura', dias_restantes, nivel }` com `nivel`
escalando `atencao` → `alerta` → `critico` conforme a proximidade do
vencimento (`critico` quando `dias_restantes <= 0`, ou sempre nos últimos
3 dias de trial). Independente de `statusAssinatura()` (que já existia e
continua só usando `dias_alerta_vencimento` pra rotular a linha na lista
do Super Admin — não foi tocada). `GET /plano` (`routes/plano.js`) devolve
esse objeto em `alerta`; o card `#bloco-plano-dashboard` em
`painel/index.html` usa isso pra decidir mensagem, cor e se pulsa — ver
`painel/CLAUDE.md`.

## Melhorias no portal do associado — mini-dashboard, logo da associação, ficha completa (28/07/2026)

Três pedidos separados do usuário no mesmo dia, todos só aditivos:

- **Logo da associação**: `PUT /configuracoes/logo` (novo, `routes/configuracoes.js`, só `admin`) — antes só o Super Admin podia trocar `associacoes.logo_url` (já exibida no header do Dashboard desde 27/07); agora a própria associação também pode, reaproveitando `imagemBase64Valida()` e o mesmo limite de ~2,8MB de `PUT /portal/minha-foto`.
- **`GET /portal/meus-dados`** ganhou `rg`, `endereco_*` (já existiam em `associados` desde a migration `20260727150000_ficha_associado.sql`, só não eram expostas nessa rota) e `criado_em`, pra alimentar a ficha completa nova no portal (`painel/CLAUDE.md` tem o detalhe do front). **Não inclui `email`** — `associados` não tem essa coluna (o e-mail de login vive em `usuarios`); o front já tinha esse dado disponível decodificando o próprio JWT (`estado.email`), não precisou de rota nova nem de JOIN.
- Nenhuma rota nova para o mini-dashboard "Início" do portal — reaproveita `GET /portal/meus-dados`, `GET /portal/minhas-cobrancas` e `GET /comunicados`, todas já existentes.

**Gap real encontrado e corrigido de quebra**: `POST /comunicados/:id/marcar-lido` existia desde a Fase 3 (confirmação de leitura, item de sprint 3) mas **nunca tinha um consumidor no `portal.html`** — o associado nunca "marcava como lido" de fato, então o contador de não lidos nunca zeraria. Sem mudança de backend (a rota já existia e já funcionava pra qualquer papel autenticado); só o front passou a chamá-la ao abrir o mural.

## Perfis de acesso granulares: Financeiro/Atendimento/Operador/Consulta (28/07/2026, item 5 do backlog de sugestões)

Esse era o item do backlog mais arriscado dos 3 aplicados no dia — a
seção "Reestruturação da sidebar" (25/07/2026) já tinha adiado isso de
propósito, citando risco de mexer no enum + revisar toda chamada
`autorizar()` do projeto. Antes de implementar, a matriz de permissões
exata foi confirmada com o usuário (não assumida) — decisão de produto,
não só técnica.

`papel_usuario` ganhou 4 valores (migration
`20260728100000_perfis_acesso_granulares.sql`, 4 `ALTER TYPE ... ADD
VALUE` em instruções separadas — não dá pra combinar num único comando,
e nenhuma delas pode ser usada na mesma transação em que foi adicionada,
mas como são só isso no arquivo, sem uso junto, é seguro colar direto no
SQL Editor). Matriz aplicada via `autorizar(...)` em cada rota, sem
tocar em `admin`/`diretoria`/`associado`:

| Perfil | Associados | Cobranças | Comunicados | Usuários/Config |
|---|---|---|---|---|
| Financeiro | ver | ver + criar/editar/pagar | ver | — |
| Atendimento | ver + criar/editar | ver | ver + criar/editar/excluir | — |
| Operador | ver + criar/editar | ver + criar/editar/pagar | ver + criar/editar/excluir | — |
| Consulta | ver | ver | ver | — |

`estornar`/`excluir` de cobrança e `excluir` de associado continuam
**só admin** pros 4 perfis novos também — mesma restrição que já existia
pra `diretoria`, estendida sem abrir exceção nova. Auditoria e atividades
(feed do Dashboard) são "ver" pros 4, mesmo raciocínio de informação não
sensível já usado pra `diretoria`.

**Detalhe fácil de esquecer**: `GET /comunicados` (`routes/comunicados.js`)
não tem `autorizar()` próprio — decide o comportamento internamente com
uma variável `ehGestor` (`admin`/`diretoria` veem tudo com stats de
leitura; qualquer outro papel vê só o que um associado veria, filtrado e
com flag `lido`). Os 4 perfis novos precisaram entrar nessa lista
também, senão um usuário `financeiro` legitimamente autorizado a ver
comunicados enxergaria a versão errada (a de associado) em vez da
gerencial.

**Testado contra staging** com uma matriz de 22 combinações
papel×rota/verbo (associação + 4 usuários de teste, um por perfil,
criados e apagados via `comConexaoSuperAdmin()`) — GET liberado pros 4,
POST/PUT/PATCH batendo o esperado (permitido onde a matriz diz, 403 onde
não), Usuários/Configurações sempre 403. Todas passaram.

## Paginação opt-in em /associados e /cobrancas (28/07/2026, item 6 do backlog de sugestões)

`GET /associados` e `GET /cobrancas` aceitam `?pagina=`/`?por_pagina=`
(máx. 200/página, mesmo padrão de `GET /auditoria`) e devolvem
`{ registros, total, pagina, por_pagina }` **só quando esses parâmetros
vêm na query**. Sem eles, a resposta continua sendo o array puro de
sempre — decisão deliberada, não meio-termo preguiçoso: o Dashboard do
painel da associação (KPIs, gráficos de crescimento/receita de 12 meses,
"últimos associados") e a busca instantânea das telas de Associados/
Financeiro dependem hoje de ter o array **completo** no cliente
(`associadosCache`/`cobrancasCache` em `painel/index.html`). Paginar sem
essa distinção quebraria tudo isso na hora.

**O que isso resolve e o que não resolve**: resolve o "não escala" citado
na análise (dá pra uma tela nova, ou uma versão futura da lista, pedir só
50 registros por vez sem sobrecarregar o Postgres numa associação com
milhares de associados). **Não resolve** a causa raiz de fato — a lista
de Associados/Financeiro em `index.html` ainda carrega tudo de uma vez
hoje, porque adotar paginação de verdade nessas telas exigiria mover a
busca/filtro pro backend também (a busca atual é 100% client-side sobre
o array já em memória). Isso fica pra quando/se o volume real justificar
—- a capacidade já existe no backend, só não foi adotada no front ainda.

## Comunicado da plataforma pra todas as associações (28/07/2026, item 7 do backlog de sugestões)

Depois da análise profunda pedida pelo usuário sobre as 3 camadas
(Super Admin/associação/associado), o primeiro item do backlog resultante
a ser implementado: o Super Admin não tinha como avisar todas as
associações de uma vez (só existia comunicado por associação, escrito
pela própria diretoria).

`comunicados` ganhou `origem_plataforma boolean NOT NULL DEFAULT false`
(migration `20260728000000_comunicados_plataforma.sql`, aditiva). Nova
rota `POST /superadmin/comunicados-plataforma` (`autorizarSuperAdmin(...GESTAO)`,
`routes/superadmin.js`) recebe `titulo`/`conteudo` e faz um `INSERT` em
`comunicados` **por associação ativa** (`autor_id = NULL`, super-admin não
é um `usuario` de tenant) — reaproveita o mural que cada associação já
tem, **nenhuma tabela nem tela de leitura nova precisou ser criada**. Uma
única linha de auditoria registra o envio (com `total_associacoes` em
`dados_novos`, não uma linha por associação atingida).

`PUT`/`DELETE /comunicados/:id` (`routes/comunicados.js`) passaram a
checar `origem_plataforma` antes de aplicar a mudança — 403 se for
`true`, mesmo pra quem tem papel `admin`/`diretoria` na própria
associação. Isso existe porque o texto de um aviso oficial da plataforma
não pode ser adulterado ou apagado por quem só recebeu, só a origem
(Super Admin) deveria poder gerenciar — e hoje nem o Super Admin tem uma
rota de edição em massa desses avisos (só criar um novo, se precisar
corrigir algo é reenviar).

**Testado contra staging com o mesmo padrão de sempre** (associações +
super-admin de teste via `comConexaoSuperAdmin()`, tudo apagado depois) —
um detalhe que quase passou despercebido: o broadcast **atingiu uma
associação real pré-existente no staging** (`Associação_teste1`, não
criada por esta sessão), porque a rota varre *todas* as associações
ativas do banco, não só as de teste. Precisou de uma limpeza extra fora
do fluxo normal do script pra remover só aquela linha de comunicado, sem
mexer na associação em si. **Lição pra quem for testar rotas de broadcast
cross-tenant no futuro**: usar sempre um texto de teste claramente
identificável (ex. prefixo `TESTE_`) mesmo em campos que não são o nome
da entidade de teste, e checar depois em **todas** as associações
atingidas, não só nas criadas pelo próprio teste.

## Isolamento entre tenants (RLS) — já está ativo

Não é só disciplina de código (`WHERE associacao_id = $1` em toda query,
que também existe) — o Postgres recusa fisicamente misturar dados entre
associações, porque `app_runtime` não é dona das tabelas e as policies
estão com `FORCE ROW LEVEL SECURITY`. Testado em produção: dois tenants
de teste, admin de um não conseguia ver dado do outro.

## Convenções

- Sem framework de teste automatizado — verificação é feita rodando o
  servidor local (`node server.js`) e testando fluxos reais via
  `fetch`/API, geralmente contra o mesmo banco de produção (é seguro
  desde que os dados de teste sejam limpos depois — sempre limpar).
- Front-end sem build step — `painel/index.html` e `painel/superadmin.html`
  são editados direto, `API_URL` no topo do `<script>` aponta para
  produção; ao testar localmente contra `localhost:3000`, lembrar de
  reverter antes de commitar.
- Commits em português, imperativo, sem prefixo tipo `feat:`/`fix:`.
- Segredos (senhas de role, `JWT_SECRET`, etc.) nunca em arquivo
  versionado — só em `.env` (git-ignored) ou entregues ao usuário uma
  única vez no chat, nunca reescritos em commits/migrations.
- **`JWT_SECRET` do `.env` local é diferente do valor configurado no
  Render** (confirmado 25/07/2026) — um token assinado localmente (ex.
  rodando `node server.js` local e chamando `/auth/login` local) **não é
  aceito em produção** (dá 401 "Token inválido"). Pra testar contra
  produção de verdade, logar de fato via `/auth/login` de produção (ou
  pegar o token real do `localStorage` do navegador do usuário) — não dá
  pra forjar um token localmente e usar em produção.

## Variáveis de ambiente obrigatórias em produção

`DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS` — servidor derruba na
inicialização se faltar alguma (ver `config/env.js`). `BOOTSTRAP_SECRET`
é opcional (rota de bootstrap fica bloqueada por padrão sem ela).
`DB_POOL_MAX` também é opcional (default 10) — ver seção "Auditoria de
escala" acima antes de mudar ao escalar para mais instâncias.
