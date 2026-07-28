# Documentação — Plataforma para Associações

**Produto:** Sistema de gestão multi-tenant para associações, com camada de Super Admin (SaaS)
**Mantido por:** Julião — Carregando Ideias
**Última atualização:** 27 de julho de 2026

---

## 1. Visão geral

Plataforma SaaS para gestão de associações (moradores, classe profissional, esportivas/recreativas, ONGs, etc.), com três níveis de acesso:

1. **Super Admin** — dono da plataforma (Carregando Ideias). Cadastra, edita e monitora as associações-clientes. Não acessa dados individuais dos associados para edição, só visualização agregada e só-leitura.
2. **Admin / Diretoria da associação** — administra a própria associação: associados, financeiro, comunicados, usuários.
3. **Associado** — acessa só os próprios dados (perfil, cobranças, comunicados).

## 2. Arquitetura e hospedagem

| Camada | Tecnologia | Onde está |
|---|---|---|
| Backend | Node.js + Express | Render — `https://minha-associacao-backend.onrender.com` |
| Banco de dados | PostgreSQL | Supabase (conexão via Session Pooler, compatível com IPv4) |
| Painel da associação | HTML/CSS/JS puro (sem framework) | Vercel — `index.html` |
| Painel do Super Admin | HTML/CSS/JS puro (arquivo separado) | Vercel — `superadmin.html` (mesmo domínio do painel) |
| Repositórios | GitHub | `CarregandoIdeias/minha-associacao-backend`, `CarregandoIdeias/minha-associacao-painel` |

**Ambiente de homologação (staging, desde 27/07/2026):** segundo ambiente completo e isolado — projeto Supabase próprio (plano Free), Web Service próprio no Render (branch `staging` deste repo), projeto Vercel próprio (branch `staging` do repo do painel). Front-end resolve `API_URL` automaticamente pelo hostname (`localhost`/domínio contendo "staging" → backend de staging; qualquer outro → produção) — não é um valor fixo trocado manualmente, então **não existe divergência de código entre `main` e `staging`** nesse ponto. Fluxo de trabalho: mudanças arriscadas (schema, RLS, auth) são testadas em `staging` primeiro, só depois mescladas em `main`. Ver `CLAUDE.md` para o runbook completo de como recriar o ambiente do zero.

**Identidade visual:** paleta e tipografia do AvaliaPlus (outro produto do Carregando Ideias) — dourado `#C9A84C`, preto `#0A0A0A` / bege claro `#F7F5EF`, fontes Playfair Display + Inter + JetBrains Mono. Tema claro/escuro em ambos os painéis.

**Conexão com o banco:** o backend conecta como a role `app_runtime`, criada especificamente para isso e **sem ser dona das tabelas** (o dono é `postgres`, usado só para rodar migrações). Isso é o que faz o isolamento entre associações (RLS) valer de verdade — ver seção 6.

## 3. Modelo de dados (tabelas principais)

- `associacoes` — tenant. Campos: nome, tipo, cnpj, plano, ativo, email, telefone, endereco, cidade, estado, cep, site, logo_url, chave_pix, nome_recebedor_pix, cidade_pix, dias_alerta_vencimento (alerta de cobrança de associado), valor_mensalidade_manual, vencimento_assinatura, forma_cobranca, trial_dias, trial_expira_em, **dias_alerta_assinatura** (novo 27/07 — alerta de vencimento da própria assinatura da associação com a plataforma, configurável pelo Super Admin entre 30/20/15/10/7/3 dias, separado de `dias_alerta_vencimento`)
- `usuarios` — login de cada pessoa (papel: admin/diretoria/associado), vinculado a uma associação. E-mail é **único em toda a plataforma** (não só dentro da associação). Tem `deve_trocar_senha` (força troca no primeiro acesso)
- `associados` — cadastro do membro: nome, cpf, **rg** (novo 27/07), telefone, categoria, status, observação, data_ingresso, foto_base64, usuario_id opcional, e endereço estruturado (novo 27/07): endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento, endereco_bairro, endereco_cidade, endereco_estado
- `cobrancas` — mensalidades/taxas (valor, vencimento, status, comprovante_base64)
- `pagamentos` — histórico de pagamentos confirmados
- `comunicados` — mural (destaque, status, agendamento)
- `comunicado_leituras` — quem já visualizou cada comunicado (usada tanto pelo indicador "lido" do associado quanto pela tela de confirmação de leitura do admin, ver seção 4.2)
- `password_resets` — tokens de redefinição de senha (gerados por um admin para outra pessoa da associação)
- `super_admins` — super-admins da plataforma (tabela separada do sistema multi-tenant, sem RLS — não tem coluna de tenant para isolar). Tem `papel` (super_admin/administrador/suporte), `ativo`, `deve_trocar_senha`
- `auth_logs` — log de eventos de autenticação (login, logout, troca/redefinição de senha) por associação. `MAX(criado_em) WHERE evento = 'login_sucesso'` por usuário alimenta a coluna "Último acesso" da tela de Usuários
- `atividades` (25/07/2026) — log leve de atividades administrativas (associado cadastrado/editado, cobrança paga, comunicado publicado, usuário convidado), alimenta o card "Atividades recentes" do Dashboard do painel da associação
- `logs_auditoria` (26/07/2026) — log de auditoria completo, cross-tenant (associacao_id, usuario/super_admin que agiu, módulo, tipo de ação, descrição, diff `dados_anteriores`/`dados_novos`, ip, user_agent). Mais detalhado que `atividades` — alimenta tanto a tela "Auditoria" do Super Admin (todas as associações) quanto a aba "Auditoria" de cada associação (só a própria, via policy `logs_auditoria_select_tenant`, ver seção 6)
- `solicitacoes_plano` (26/07/2026) — fila de aprovação da contratação self-service de plano pago (Pix + comprovante + aprovação do Super Admin)
- `configuracoes_plataforma` (26/07/2026) — singleton com a chave Pix da própria plataforma (Carregando Ideias), usada no QR Code que a associação escaneia para contratar um plano — diferente da chave Pix de cada associação, que é para cobrar os próprios associados
- `sprint_itens` (27/07/2026) — backlog de melhorias/bugs da plataforma (nível Super Admin, sem relação com nenhuma associação-cliente), gerenciado pela tela `sprint.html`

Isolamento entre associações garantido em duas camadas independentes: filtro explícito `associacao_id = ...` em toda query da aplicação **e** Row Level Security forçada no Postgres (ver seção 6) — mesmo uma rota nova que esqueça o filtro não consegue ler dado de outro tenant.

## 4. Funcionalidades por papel

### 4.1 Super Admin
- Login próprio (e-mail + senha), separado do sistema das associações
- **Dashboard** (reformulado 24/07, compactado 26/07): KPIs (associações, associados, **MRR**, mensalidades vencendo/ativas/bloqueadas/atrasadas agregadas), gráficos de crescimento/novos associados (12 meses), grade de 3 cards de "últimas" (associações, admins, atividades — via `logs_auditoria`)
- **Gerenciamento de administradores da plataforma** (Fase 1, 26/07): `super_admins` tem `papel` (super_admin/administrador/suporte) e `ativo`, revalidados a cada requisição. CRUD completo de administradores + autoatendimento de troca de senha. Ações destrutivas/sensíveis (excluir associação, resetar senha de cliente) exigem papel `super_admin` ou `administrador` — `suporte` tem só leitura
- **Auditoria central** (Fase 2, 26/07): tela cross-tenant sobre `logs_auditoria` — filtros (usuário, associação, módulo, tipo de ação, período), paginação, modal de detalhes com diff antes/depois, exportação Excel/PDF
- **Plano contratado + cobrança**: cada associação escolhe um plano (trial/basico/profissional/enterprise) com preço-base + preço por associado ativo. MRR calculado automaticamente pela fórmula em `utils/precos.js`; campo `valor_mensalidade_manual` permite sobrescrever manualmente (negociações customizadas). Forma de cobrança e vencimento da assinatura configuráveis, assim como `dias_alerta_assinatura` (27/07 — janela de antecedência do alerta de renovação exibido no Dashboard da associação, ver 4.2)
- **Plano Trial com expiração automática + contratação self-service** (26/07): trial configurável por associação (`trial_dias`), bloqueio automático de acesso ao vencer (preservando dados), fluxo de contratação via Pix da própria plataforma + comprovante + aprovação manual do Super Admin (`solicitacoes_plano`)
- CRUD de associações, com filtros (nome, cidade, UF, plano, status da assinatura)
- Ao criar uma associação, formulário estendido: dados básicos + dados de cadastro (CEP, site, logo) + plano/cobrança/trial + CPF do admin responsável. Senha provisória gerada automaticamente e exibida uma única vez
- Bloquear uma associação (`ativo = false`) impede login de todos os usuários dela imediatamente
- Autocadastro público de associações **removido** — só o super-admin cria novas associações

### 4.2 Admin / Diretoria da associação
- **Dashboard**: KPIs com comparativo vs. mês anterior, gráficos (crescimento acumulado, novos por mês, receita mensal, situação financeira), cards de apoio (atividades recentes, próximos vencimentos, últimos associados, comunicados recentes), identidade da associação (nome/logo) no cabeçalho. **Alerta inteligente de renovação do plano** (27/07): card do Dashboard destaca visualmente (cor/pulse crescente conforme a proximidade) quando a assinatura da associação está perto de vencer ou o trial está terminando — nível calculado em `utils/precos.js` (`alertaAssinatura`), janela configurável pelo Super Admin (`dias_alerta_assinatura`)
- **Associados**: cadastro completo — dados pessoais, **endereço estruturado e RG** (27/07), categoria/plano do associado, situação, observações. Botão **"Ver ficha"** (somente leitura, 3 abas: Dados/Financeiro/Comunicados) separado de **"Editar"** (formulário editável). Aba Financeiro mostra o histórico de cobranças do associado (filtro por status/ano); aba Comunicados mostra quais comunicados esse associado leu/não leu, com data e tempo até a leitura
- **Financeiro**: cobranças com Pix estático (QR code + "copia e cola"), upload de comprovante pelo associado, confirmação manual pelo admin, estorno, edição/exclusão, alerta de vencimento configurável
- **Comunicados**: mural com busca, filtro por status, agendamento, destaque. **Confirmação de leitura** (27/07): cada comunicado mostra quantos associados já leram/faltam ler e a taxa de leitura; tela de detalhe com abas "Associados que leram" (com data/hora) e "que não leram", busca por nome, exportação Excel/PDF
- **Acessos** (sidebar, reestruturado 27/07 — antes eram dois itens separados, "Usuários" e "Configurações"): duas sub-abas —
  - **Usuários**: convite (diretoria/associado) com senha provisória automática, vínculo a um cadastro de associado, edição de papel, desativar/**reativar**, **redefinir senha** (gera provisória nova), exclusão. Tabela mostra data de criação e **último acesso** (derivado de `auth_logs`)
  - **Auditoria** (27/07): mesma experiência da tela do Super Admin, só que já filtrada pra essa associação (`GET /auditoria`, RLS `logs_auditoria_select_tenant`) — filtros, paginação, modal de detalhes com diff, exportação Excel/PDF
- **Parametrização** (27/07 — saiu da sidebar, só acessível pelo menu "Preferências" do header): chave Pix da associação, dias de alerta de vencimento de cobrança. Seções adicionais (financeiro avançado, alertas, comunicação, cadastro de associados, sistema, segurança, integrações) fazem parte de um pedido maior de reorganização, entregues uma etapa por vez

### 4.3 Associado
- **Meus Dados**: perfil próprio (nome, CPF, categoria, status), upload de foto (redimensionada no navegador)
- **Minhas cobranças**: pagamento via Pix (QR code + copia-e-cola) e envio de comprovante
- **Comunicados**: mural com indicador de "não lido" e destaque visual

### 4.4 Transversal
- Login só com e-mail + senha (sem código/ID de associação)
- Senha provisória obrigatória para trocar no primeiro acesso (associação nova, associado novo, convite de usuário, reset feito por admin/super-admin)
- Sessão persistente (sobrevive a atualizar a página — `localStorage` + revalidação com o backend a cada requisição)
- Recuperação de senha: autosserviço por e-mail **não está ativo** (não há provedor de e-mail integrado ainda) — quem esquece a senha pede para o admin gerar um link (`POST /usuarios/:id/gerar-link-redefinicao`)
- Responsividade (desktop, tablet, celular)

## 5. Principais rotas da API

| Recurso | Rotas |
|---|---|
| Autenticação (associação) | `POST /auth/login`, `POST /auth/esqueci-senha`, `POST /auth/redefinir-senha`, `PUT /auth/senha`, `POST /auth/logout` |
| Super Admin | `POST /superadmin/bootstrap` (exige `BOOTSTRAP_SECRET`), `POST /superadmin/login`, `GET/POST/PUT/DELETE /superadmin/associacoes`, `GET /superadmin/associacoes/:id`, `GET /superadmin/associacoes/:id/associados`, `GET /superadmin/associacoes/:id/cobrancas`, `PATCH /superadmin/associacoes/:id/resetar-senha-admin`, `GET /superadmin/dashboard`, `GET/POST/PUT /superadmin/admins`, `PATCH /superadmin/admins/:id/status`, `PATCH /superadmin/admins/:id/senha`, `PUT /superadmin/perfil/senha`, `GET /superadmin/logs`, `GET /superadmin/logs/exportar/:formato`, `GET/PATCH /superadmin/solicitacoes-plano...`, `GET/PUT /superadmin/configuracoes-plataforma` |
| Associados | `GET/POST/PUT/DELETE /associados` (POST já cria o login junto; campos incluem endereço estruturado e RG), `GET /associados/:id/comunicados` (histórico de leitura, filtro `?lido=lidos|nao_lidos`) |
| Financeiro | `GET/POST/PUT/DELETE /cobrancas` (`?associado_id=` filtra por associado), `PATCH /cobrancas/:id/pagar`, `PATCH /cobrancas/:id/estornar`, `GET /cobrancas/:id/comprovante` |
| Comunicados | `GET/POST/PUT/DELETE /comunicados`, `POST /comunicados/:id/marcar-lido`, `GET /comunicados/:id/leituras`, `GET /comunicados/:id/leituras/exportar/:formato` |
| Atividades | `GET /atividades` (últimas ~15 da associação, alimenta o Dashboard) |
| Auditoria (por associação) | `GET /auditoria`, `GET /auditoria/exportar/:formato` (mesma ideia de `/superadmin/logs`, já escopado pelo tenant) |
| Usuários | `GET/POST/PUT/DELETE /usuarios`, `GET /usuarios/associados-sem-login`, `PATCH /usuarios/:id/desativar`, `PATCH /usuarios/:id/reativar`, `PATCH /usuarios/:id/redefinir-senha`, `POST /usuarios/:id/gerar-link-redefinicao` (sem consumidor no front hoje), `GET /usuarios/logs-autenticacao` |
| Portal do associado | `GET /portal/meus-dados`, `PUT /portal/minha-foto`, `GET /portal/minhas-cobrancas`, `PUT /portal/minhas-cobrancas/:id/comprovante` |
| Configurações | `GET/PUT /configuracoes/pix`, `GET/PUT /configuracoes/alertas`, `GET /configuracoes/identidade` |
| Plano da associação | `GET /plano`, `POST /plano/solicitar-contratacao` |
| Sprint (backlog interno) | `GET/POST/PUT/DELETE /sprint`, `PATCH /sprint/:id/status` |

Todas as rotas (exceto login/bootstrap/esqueci-senha/redefinir-senha) exigem token JWT (`Authorization: Bearer <token>`). O middleware `autenticar` revalida o token contra o banco a cada requisição (usuário/associação ainda ativos, papel em dia) — não confia só na assinatura do token.

## 6. Segurança — situação atual

### ✅ Isolamento entre associações (RLS) — real e forçado
O backend conecta ao Postgres como `app_runtime`, uma role criada especificamente para isso e que **não é dona das tabelas** (diferente do `postgres`, usado só para migrações). Toda tabela relevante tem `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`, com policies de isolamento por `associacao_id` + bypass explícito para o super-admin (`app.superadmin_bypass`) e para os fluxos públicos de autenticação (`app.auth_bypass`, usado só por `POST /auth/login` e `POST /auth/redefinir-senha`, que legitimamente não sabem o tenant de antemão).

**Isso já causou um incidente antes** (histórico, para quem for mexer em RLS de novo): uma tentativa anterior de `FORCE ROW LEVEL SECURITY` foi feita **enquanto o backend ainda conectava como `postgres` (dono)**, sem trocar de role — como o dono das tabelas ignora RLS a menos que `FORCE` esteja ligado, isso *ativou* o isolamento de repente para a própria conexão de produção, e como o código de login não setava nenhuma variável de sessão, ninguém mais conseguia logar. Foi revertido com `NO FORCE ROW LEVEL SECURITY` de emergência.

**Como foi refeito com segurança desta vez:** a role `app_runtime` foi criada e testada **antes** de qualquer `FORCE`; o código foi atualizado para usar essa role e setar as variáveis de sessão certas (`comConexaoTenant`, `comConexaoSuperAdmin`, `comConexaoAuth` em `middleware/auth.js`); só depois do deploy confirmado com a nova `DATABASE_URL` é que o `FORCE ROW LEVEL SECURITY` foi aplicado — nesse ponto, como a produção já não usava mais o dono, o `FORCE` não teve efeito prático imediato nenhum (só fecha a brecha teórica de alguém reconectar como dono no futuro). Testado com dois tenants de verdade em produção antes de considerar concluído: admin de uma associação não conseguia ver dado da outra.

**Se for mexer em RLS de novo:** nunca rode `FORCE ROW LEVEL SECURITY` enquanto o backend ainda estiver conectado como `postgres`. Sempre: (1) criar/testar a role sem privilégio de dono, (2) atualizar o código, (3) trocar `DATABASE_URL` em produção, (4) confirmar que funciona, (5) só então `FORCE`.

### ✅ Grants padrão do Supabase revogados
O Supabase concede acesso total (`SELECT/INSERT/UPDATE/DELETE`) por padrão às roles `anon` e `authenticated` (usadas pela API pública/PostgREST dele) em toda tabela nova — essa aplicação não usa essa API, só o Postgres via este backend. Esses grants foram revogados em todas as tabelas (`supabase/migrations/20260724000200_revogar_acesso_publico_supabase.sql`), incluindo `ALTER DEFAULT PRIVILEGES` para que tabelas futuras não saiam com esse acesso. **Isso importa especialmente em `super_admins`**, que não tem RLS (não tem coluna de tenant) — sem essa revogação, qualquer um com a chave pública `anon` do projeto Supabase conseguiria ler/gravar super-admins direto pela API do Supabase, sem passar pelo backend.

### ✅ CORS restrito
Só `https://minha-associacao-painel.vercel.app` (via `CORS_ORIGINS`) tem acesso à API. Antes aceitava qualquer origem.

### ✅ Segredos centralizados (`config/env.js`)
`JWT_SECRET`, `DATABASE_URL` e `CORS_ORIGINS` são lidos de um único lugar (`config/env.js`), que **derruba o processo na inicialização** se algum estiver faltando em produção — antes, cada arquivo tinha sua própria cópia com um valor padrão fraco de fallback.

### ✅ Bootstrap do super-admin protegido
`POST /superadmin/bootstrap` exige `BOOTSTRAP_SECRET` (comparação em tempo constante). Antes, quem chamasse essa rota primeiro (antes do dono real) virava dono da plataforma.

### ✅ Certificado SSL do banco validado de verdade
`db.js` valida o certificado do Postgres contra a CA real do Supabase (`config/supabase-ca.pem`, extraída diretamente da conexão — a Supabase usa uma CA própria, não uma pública). Antes usava `rejectUnauthorized: false`, aceitando qualquer certificado.

### ✅ JWT revalidado a cada requisição
`autenticar()` não confia só na assinatura do token — a cada requisição, confere no banco se o usuário e a associação ainda estão ativos, e usa o `papel` fresco do banco (não o do token). Desativar alguém, ou bloquear uma associação, corta o acesso na hora, mesmo com um token ainda válido (antes, valia até o token expirar, até 8h depois).

### ✅ Login por e-mail/senha
Substituiu o login por código/ID da associação. E-mail é único em toda a plataforma. Senha provisória sempre gerada pelo sistema (nunca escolhida por quem convida), com troca obrigatória no primeiro acesso.

### ✅ Recuperação de senha
`POST /auth/esqueci-senha` não gera token nenhum (autosserviço por e-mail depende de um provedor de e-mail que ainda não existe — reintroduzir isso sem envio real de e-mail reabriria uma vulnerabilidade já corrigida antes). Um admin gera o link pela rota `POST /usuarios/:id/gerar-link-redefinicao`.

### ✅ Pool de conexões não derruba mais o servidor inteiro (25/07/2026)
`db.js` não tinha `pool.on('error', ...)` — um cliente ocioso do pool
tendo a conexão encerrada pelo Supabase (comportamento normal dele)
gerava um evento `'error'` não tratado no `pg.Pool`, que **derrubava o
processo Node inteiro**. Era a causa real por trás de rajadas de 500 que
atingiam várias rotas ao mesmo tempo (o Render reiniciava o serviço
sozinho, e requisições em trânsito nessa janela falhavam). Corrigido —
agora só loga o erro. `idleTimeoutMillis` do pool também subiu de 10s
(padrão do `pg`) para 30s, reduzindo a frequência de reconexões "a frio".

### 🟡 Instabilidade intermitente do pooler — mitigada, causa raiz não confirmada
`autenticar()`/`autenticarSuperAdmin()`/login às vezes recebem do
Postgres `invalid input syntax for type uuid: ""` — inclusive em queries
sem nenhum parâmetro uuid (evidência de que é resposta de outra query
concorrente vazando pela conexão, do lado do pooler do Supabase).
`DATABASE_URL` está confirmado no Session Pooler (o modo certo para
IPv4 — o Render não suporta a conexão direta, que exige IPv6).

**27/07/2026 — reproduzido de forma controlada em staging** (o ambiente
de produção não passou mais por isso desde a correção do incidente
abaixo): rajadas de conexões em sequência rápida contra o projeto
Supabase de staging (plano Free) disparam o erro de forma bem mais fácil
que em produção (plano pago) — reforça a suspeita de que projetos Free
têm pooler com menos fôlego sob concorrência, além do auto-pause típico
do plano gratuito gerar mais "reconexões a frio". Mitigação reforçada:
`autenticar()`, `autenticarSuperAdmin()` (que antes não tinha proteção
nenhuma), `comConexaoComSessao()` e o login foram de 2 para **3
tentativas**, com espera curta e crescente entre elas (em vez de retry
imediato). Se voltar a acontecer com frequência em produção (não só
staging), vale abrir chamado com o suporte do Supabase citando o erro
exato (`22P02`, `string_to_uuid`).

**Incidente P0 relacionado (27/07/2026, já corrigido)**: uma tentativa de
adicionar `statement_timeout` na configuração do `Pool` do `pg` piorou
esse sintoma de "raro" para ~100% das requisições em produção por
alguns minutos — esse parâmetro vira parte do pacote de *startup* da
conexão (não um `SET` depois de conectar), e o Session Pooler não lidou
bem com isso. Revertido. **Lição**: qualquer opção nova do `Pool`/`Client`
do `pg` merece checar como é implementada antes de usar contra um pooler
tipo PgBouncer/Supavisor — algumas viram parâmetro de startup packet em
vez de um `SET` de sessão comum.

### ✅ Auditoria de escala — rate-limit por IP, dimensionamento do pool, bcrypt fora da conexão (25/07/2026)
Segunda rodada de auditoria (a primeira, 24/07, focou em vulnerabilidades críticas; essa focou em escalar sem falhas, a pedido do usuário):
- **`trust proxy` ausente**: atrás do proxy reverso do Render, `req.ip` via o IP interno do proxy pra todo mundo — o rate-limit do login (`limiteLogin`, por IP) na prática era **compartilhado entre todos os clientes**. Corrigido com `app.set('trust proxy', 1)`.
- **Pool sem `max` explícito**: `db.js` usava o padrão implícito de 10 do `pg`. Agora é `max: config.poolMax` (env `DB_POOL_MAX`, default 10). Como toda rota abre uma conexão dedicada do pool (exigido pelo RLS via `SET` de sessão, nunca `pool.query()`), escalar para N instâncias no Render multiplica o total de conexões no Supabase por `N × DB_POOL_MAX` — conferir o limite do plano do Supabase antes de aumentar o nº de instâncias.
- **Rate-limit geral** (`limiteGeral`, 300 req/15min por IP) aplicado a toda a API — antes só login/redefinição de senha tinham algum limite.
- **bcrypt fora da conexão emprestada do pool**: hash/compare (deliberadamente lento) não segura mais uma conexão do pool (às vezes com transação aberta) enquanto roda, em `associados.js`, `usuarios.js`, `superadmin.js` e `auth.js` — reduz o tempo que cada requisição ocupa uma conexão sob carga concorrente.

### ✅ XSS armazenado corrigido (comprovantes/fotos/logos, 27/07/2026)
Confirmado com PoC antes de corrigir. A validação de upload
(`comprovante_base64`, `foto_base64`, `logo_base64`) só checava
`startsWith('data:image/')` — o resto da string era livre, e o front
montava `<img src="...">` por concatenação, então um valor com aspas
escapava do atributo e executava script na sessão de quem abrisse a tela
(ex.: comprovante malicioso enviado por um admin de associação → Super
Admin abre pra aprovar → script roda com o JWT dele no `localStorage`).
Corrigido em duas camadas: `utils/validacao.js` agora exige alfabeto
base64 estrito + MIME de lista fechada (**SVG rejeitado de propósito**,
é vetor de XSS mesmo sendo "imagem"); front-end parou de montar HTML por
concatenação nesses pontos (`createElement` + `.src`/`.href`, nunca
`innerHTML` com o valor interpolado). Também corrigido na mesma auditoria:
senha provisória de super-admin que não expirava de fato via API direta,
e papel `suporte` que conseguia excluir associação/resetar senha de
cliente (agora restrito a `super_admin`/`administrador`).

### 🟡 Pendente, não urgente
- Token de sessão fica em `localStorage` no front-end — já bem mitigado pelo CORS restrito; o ideal estrutural seria migrar para cookie `httpOnly`
- Sem `helmet`/cabeçalhos de segurança explícitos (`X-Powered-By: Express` vazando por padrão)
- Sem cache na revalidação de JWT — cada requisição autenticada faz uma consulta extra ao banco. Irrelevante no volume atual; só vale revisitar se o uso crescer muito
- Sem paginação nas listagens (`/associados`, `/cobrancas`) — ok para o volume atual
- Fotos/comprovantes guardados em base64 dentro do Postgres (`foto_base64`, `comprovante_base64`, `logo_base64`) — funciona no volume atual, mas migrar para armazenamento de objeto (Supabase Storage/S3, guardando só a URL) evita dor ao crescer
- Sem testes automatizados, principalmente de isolamento entre tenants
- Sem ferramenta de migração automatizada (migrations são `.sql` avulsos, aplicados manualmente — ver `supabase/README.md`)

## 7. Cálculo de MRR e preços por plano

Novo arquivo `backend/utils/precos.js` (24/07/2026) centraliza a tabela de preços
e a lógica de cálculo de mensalidade para toda a plataforma. Cada plano tem um
preço-base + um preço por associado ativo:

```js
const PRECOS_PLANO = {
  trial:        { base: 0,     porAssociado: 0 },
  basico:       { base: 49.90, porAssociado: 2.00 },
  profissional: { base: 99.90, porAssociado: 1.50 },
  enterprise:   { base: 199.90, porAssociado: 1.00 },
};
```

A função `calcularValorMensalidade(plano, totalAssociados, valorManual)` retorna:
- Se `valorManual != null`: retorna o override manual (negociação customizada)
- Senão: `base + porAssociado * totalAssociados`

Usado em:
- `GET /superadmin/dashboard` — soma o MRR de todas as associações ativas para o KPI
- `GET /superadmin/associacoes` — mapeia o valor da mensalidade para cada linha da tabela
- `POST/PUT /superadmin/associacoes/:id` — calcula e valida o valor ao criar/editar

O `statusAssinatura(associacao, hoje)` também fica neste arquivo — calcula a situação
da assinatura (bloqueada/trial/vencida/vencendo/ativa) a partir dos campos gravados
(`ativo`, `plano`, `vencimento_assinatura`, `dias_alerta_vencimento`), mas **não é
armazenado em coluna** — sempre calculado fresco para evitar dessincronização. Ver
comentário no arquivo para a lógica completa.

Esses valores de preço são **placeholders** — ajustáveis com o usuário (Julião)
conforme necessário. Qualquer mudança nos preços é feita editando o arquivo,
commitando, e fazendo deploy — as associações recalculam o MRR automaticamente
na próxima requisição (o histórico de receita recebida, que fica em `pagamentos`,
não é afetado).

## 8. Variáveis de ambiente (backend)

```
DATABASE_URL=<connection string do Supabase — Session Pooler, usuário app_runtime>
JWT_SECRET=<segredo forte e único>
PORT=3000
NODE_ENV=production
CORS_ORIGINS=https://minha-associacao-painel.vercel.app
BOOTSTRAP_SECRET=<segredo forte, usado só para criar o primeiro super-admin>
DB_POOL_MAX=10
```

Em produção, o servidor recusa subir se `DATABASE_URL`, `JWT_SECRET` ou `CORS_ORIGINS` estiverem faltando. `BOOTSTRAP_SECRET` é opcional — se faltar, a rota de bootstrap fica sempre bloqueada (falha segura), não derruba o servidor. `DB_POOL_MAX` é opcional (default 10) — máximo de conexões que **esta instância** abre no Supabase; ao escalar para N instâncias no Render, o total no Session Pooler é `N × DB_POOL_MAX` (ver seção 6, "Auditoria de escala").

## 9. Pendências conhecidas / roadmap

- **Reestruturação da sidebar/Parametrização (item de sprint 4)**: etapa 1 (Acessos = Usuários) e etapa 2 (Auditoria por associação) concluídas em 27/07/2026. Faltam as demais seções de "Parametrização" a pedido do usuário, uma por vez: Financeiro avançado (multa/juros/tolerância), Comunicação (nome remetente/templates — sem efeito prático até existir envio de e-mail real), cadastro de Associados (matrícula, campos obrigatórios), Sistema (favicon/idioma/fuso), Segurança (expiração de sessão, tentativas de login, bloqueio temporário — também conhecida como "Fase 4" do Super Admin), Integrações (estrutura vazia, preparação futura)
- Perfis de acesso granulares (Financeiro/Atendimento/Operador/Somente Consulta) e RBAC por módulo — mencionado no pedido acima como "quando implementado"; exige alterar o enum `papel` e revisar toda chamada `autorizar()`, não é seguro fazer de brinde numa etapa menor
- Reordenar menu do associado (Meus Dados como página inicial) — pendente só para o papel associado; admin/diretoria já tem Dashboard como tela inicial desde 25/07/2026
- Integração real de pagamento (Pix via gateway — Asaas/Efí), hoje é confirmação manual
- Comunicados em massa (Super Admin → várias associações) e Relatórios exportáveis
- Envio de e-mail transacional (senha provisória, recuperação de senha por e-mail depende disso)
- Falsificação do log de auditoria (nome exibido vem de `req.usuario.nome`, sem restrição), formula injection no Excel exportado, JWT não invalidado ao trocar senha, dependências desatualizadas (`npm audit`), race condition em `POST /plano/solicitar-contratacao` — achados de auditoria de 27/07, prioridade menor
- Itens que dependem de serviço externo, tratados como projetos futuros separados: WhatsApp API, 2FA, backups automáticos, Central de Suporte, integrações de pagamento adicionais (Mercado Pago, Stripe)

## 10. Convenções do projeto

- Todo o frontend é HTML/CSS/JS puro, sem build step — arquivos são editados e publicados diretamente
- Migrações de banco são scripts `.sql` avulsos em `supabase/migrations/`, nomeados por timestamp, aplicados manualmente (não há ferramenta de migração automatizada) — ver `supabase/README.md` para o processo
- Deploy é automático via push no GitHub (Render e Vercel observam os respectivos repositórios)
- Ver `CLAUDE.md` para o contexto voltado a sessões de IA trabalhando neste repositório (arquitetura resumida, decisões não-óbvias, cuidados ao mexer em RLS/deploy)
