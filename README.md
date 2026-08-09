# Documentação — Plataforma para Associações

**Produto:** Sistema de gestão multi-tenant para associações, com camada de Super Admin (SaaS)
**Mantido por:** Julião — Carregando Ideias
**Última atualização:** 30 de julho de 2026

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

- `associacoes` — tenant. Campos: nome, tipo, cnpj, plano (enum `plano_assinatura`: **`trial`/`basico`/`intermediario`/`avancado`** — renomeado de `profissional`/`enterprise` em 29/07, mesmos preços/faixas, só o rótulo mudou), ativo, email, telefone, endereco, cidade, estado, cep, site, logo_url, chave_pix, nome_recebedor_pix, cidade_pix, dias_alerta_vencimento (alerta de cobrança de associado), valor_mensalidade_manual, vencimento_assinatura, forma_cobranca, trial_dias, trial_expira_em, dias_alerta_assinatura (27/07 — alerta de vencimento da própria assinatura da associação com a plataforma, configurável pelo Super Admin entre 30/20/15/10/7/3 dias, separado de `dias_alerta_vencimento`)
- `usuarios` — login de cada pessoa, vinculado a uma associação. `papel` (enum): `admin`/`diretoria`/`associado` + 4 perfis granulares novos em 28/07 — **`financeiro`/`atendimento`/`operador`/`consulta`** (matriz de permissões na seção 4.2). E-mail é **único em toda a plataforma** (não só dentro da associação). `deve_trocar_senha` (força troca no primeiro acesso), `cpf`, `senha_alterada_em` (29/07 — invalida qualquer JWT emitido antes da última troca de senha, mesmo que ainda não tenha expirado), `boas_vindas_visto_em` (30/07 — `NULL` até fechar o modal de boas-vindas do primeiro acesso, ver 4.2/4.3)
- `associados` — cadastro do membro: nome, cpf, rg (27/07), telefone, categoria, status, observação, data_ingresso, foto_base64, usuario_id opcional, e endereço estruturado (27/07): endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento, endereco_bairro, endereco_cidade, endereco_estado
- `cobrancas` — mensalidades/taxas (valor, vencimento, status, comprovante_base64)
- `pagamentos` — histórico de pagamentos confirmados
- `comunicados` — mural (destaque, status, agendamento). `origem_plataforma` (28/07) — `true` para os comunicados enviados pelo Super Admin a todas as associações de uma vez (ver 4.1); só quem enviou (o Super Admin) pode editar/excluir, mesmo admin/diretoria da associação não pode
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
- **Auditoria central** (Fase 2, 26/07): tela cross-tenant sobre `logs_auditoria` — filtros (usuário, associação, módulo, tipo de ação, período), paginação, modal de detalhes com diff antes/depois, exportação em PDF (Excel removido em 29/07, ver seção 6)
- **Plano contratado + cobrança**: cada associação escolhe um plano (trial/básico/intermediário/avançado — renomeado 29/07, ver seção 3) com preço-base + preço por associado ativo. MRR calculado automaticamente pela fórmula em `utils/precos.js`; campo `valor_mensalidade_manual` permite sobrescrever manualmente (negociações customizadas). Forma de cobrança e vencimento da assinatura configuráveis, assim como `dias_alerta_assinatura` (27/07 — janela de antecedência do alerta de renovação exibido no Dashboard da associação, ver 4.2)
- **Plano Trial com expiração automática + contratação self-service** (26/07): trial configurável por associação (`trial_dias`), bloqueio automático de acesso ao vencer (preservando dados), fluxo de contratação via Pix da própria plataforma + comprovante + aprovação manual do Super Admin (`solicitacoes_plano`). Aprovar uma solicitação já atualiza o plano/limites da associação na hora e registra log de auditoria — não existe um passo separado de "ativação", a aprovação já é a ativação
- **Gating de funcionalidades por plano** (29/07): alertas automáticos de vencimento, perfis de acesso granulares, exportação de leituras de comunicado e carteirinha digital exigem plano Intermediário+; auditoria completa exige Avançado. Enforcement real no backend (`exigirPlano()`, 403 com `codigo: 'PLANO_INSUFICIENTE'`) — esconder botão no front nunca é a proteção de verdade. **Grandfathering**: quem já usa um recurso continua usando mesmo se o plano mudar, só bloqueia atribuir/configurar algo novo acima do que o plano atual permite
- **Comunicado da plataforma para todas as associações** (28/07): `POST /superadmin/comunicados-plataforma` publica um aviso no mural de toda associação ativa de uma vez (`origem_plataforma = true`, ver seção 3) — reaproveita o mural já existente de cada associação, sem tabela nova
- CRUD de associações, com filtros (nome, cidade, UF, plano, status da assinatura)
- Ao criar uma associação, formulário estendido: dados básicos + dados de cadastro (CEP, site, logo) + plano/cobrança/trial + CPF do admin responsável. Senha provisória gerada automaticamente e exibida uma única vez
- Bloquear uma associação (`ativo = false`) impede login de todos os usuários dela imediatamente
- Autocadastro público de associações **removido** — só o super-admin cria novas associações

### 4.2 Admin / Diretoria da associação
- **Modal de boas-vindas no primeiro acesso** (30/07): mostrado uma única vez, no primeiro login de cada usuário — nome da associação, plano, limite de associados e dias restantes de trial (se aplicável). Fechar grava `usuarios.boas_vindas_visto_em` no banco (não em `localStorage`), nunca mais reaparece
- **Dashboard**: KPIs com comparativo vs. mês anterior, gráficos (crescimento acumulado, novos por mês, receita mensal, situação financeira), cards de apoio (atividades recentes, próximos vencimentos, últimos associados, comunicados recentes), identidade da associação (nome/logo) no cabeçalho.
  - **Alerta inteligente de renovação do plano** (27/07): card do Dashboard destaca visualmente (cor/pulse crescente conforme a proximidade) quando a assinatura da associação está perto de vencer ou o trial está terminando — nível calculado em `utils/precos.js` (`alertaAssinatura`), janela configurável pelo Super Admin (`dias_alerta_assinatura`)
  - **Controle inteligente de limite de associados** (30/07): barra de uso + aviso por faixa (80% aviso neutro, 90% "restam N vagas", 100% crítico) calculado por `alertaLimiteAssociados()`. **Ao atingir 100% do limite, novos cadastros são bloqueados de verdade** (`POST /associados` devolve 403 `LIMITE_ASSOCIADOS_ATINGIDO` — reverte a decisão anterior de "só avisa, nunca bloqueia"). Sugestão automática de upgrade pro próximo plano; "Gerenciar Plano" só oferece os planos acima do atual (nunca downgrade pelo cliente); ao renovar com a associação já maior que o limite do plano atual, sugere migrar para o menor plano que comporte a quantidade real (`plano_renovacao_sugerido`). Todo o fluxo de upgrade/renovação continua usando a contratação manual já existente (Pix + comprovante + aprovação do Super Admin) — só a UI ficou mais inteligente sobre qual plano sugerir
- **Associados**: cadastro completo — dados pessoais, endereço estruturado e RG (27/07), categoria/plano do associado, situação, observações. Botão **"Ver ficha"** (somente leitura, 3 abas: Dados/Financeiro/Comunicados) separado de **"Editar"** (formulário editável). Aba Financeiro mostra o histórico de cobranças do associado (filtro por status/ano); aba Comunicados mostra quais comunicados esse associado leu/não leu, com data e tempo até a leitura. `GET /associados` aceita paginação opt-in (`?pagina=`/`?por_pagina=`, 28/07) — sem esses parâmetros, comportamento idêntico a antes (array completo, usado pelo Dashboard/busca instantânea)
- **Financeiro**: cobranças com Pix estático (QR code + "copia e cola"), upload de comprovante pelo associado, confirmação manual pelo admin, estorno, edição/exclusão, alerta de vencimento configurável. `GET /cobrancas` também ganhou paginação opt-in (28/07), mesmo critério de `/associados`
- **Comunicados**: mural com busca, filtro por status, agendamento, destaque. Comunicados enviados pelo Super Admin aparecem com selo "Comunicado oficial" e não podem ser editados/excluídos pela associação (28/07). **Confirmação de leitura** (27/07): cada comunicado mostra quantos associados já leram/faltam ler e a taxa de leitura; tela de detalhe com abas "Associados que leram" (com data/hora) e "que não leram", busca por nome, exportação em **PDF** (exportação Excel removida em 29/07 — dependência `exceljs` tinha ~10 vulnerabilidades sem correção disponível, decisão do usuário foi manter só PDF)
- **Acessos** (sidebar, reestruturado 27/07 — antes eram dois itens separados, "Usuários" e "Configurações"): duas sub-abas —
  - **Usuários**: convite com senha provisória automática, vínculo a um cadastro de associado, edição de papel, desativar/**reativar**, **redefinir senha** (gera provisória nova), exclusão. Tabela mostra data de criação e **último acesso** (derivado de `auth_logs`). **Perfis de acesso granulares** (28/07) — além de admin/diretoria/associado, `papel` aceita `financeiro`/`atendimento`/`operador`/`consulta`, cada um com uma matriz própria de permissões por módulo (ver tabela abaixo); atribuir um desses 4 papéis exige plano Intermediário+ (gating por plano, 29/07), com grandfathering pra quem já tinha o papel antes do gating existir
  - **Auditoria** (27/07): mesma experiência da tela do Super Admin, só que já filtrada pra essa associação (`GET /auditoria`, RLS `logs_auditoria_select_tenant`) — filtros, paginação, modal de detalhes com diff, exportação em PDF. Exige plano Avançado (gating por plano, 29/07)
- **Parametrização** (27/07 — saiu da sidebar, só acessível pelo menu "Preferências" do header): chave Pix da associação, dias de alerta de vencimento de cobrança, logo da associação (`PUT /configuracoes/logo`, 28/07 — antes só o Super Admin podia trocar). Seções adicionais (financeiro avançado, alertas, comunicação, cadastro de associados, sistema, segurança, integrações) fazem parte de um pedido maior de reorganização, entregues uma etapa por vez

**Matriz de permissões dos 4 perfis granulares** (28/07, `PERMISSOES`/`podeFazer()` no front, `autorizar(...)` no backend):

| Perfil | Associados | Cobranças | Comunicados | Usuários/Config |
|---|---|---|---|---|
| Financeiro | ver | ver + criar/editar/pagar | ver | — |
| Atendimento | ver + criar/editar | ver | ver + criar/editar/excluir | — |
| Operador | ver + criar/editar | ver + criar/editar/pagar | ver + criar/editar/excluir | — |
| Consulta | ver | ver | ver | — |

Estornar/excluir cobrança e excluir associado continuam só `admin`, pros 4 perfis novos também.

### 4.3 Associado
- **Modal de boas-vindas no primeiro acesso** (30/07): nome da associação e orientação do que dá pra fazer no portal (Pix, comunicados, foto, carteirinha — este último item some se o plano da associação não for Intermediário+). Mesma flag/coluna do modal do admin (`usuarios.boas_vindas_visto_em`), nunca mais reaparece depois de fechado
- **Início** (28/07, tela inicial do portal): mini-dashboard com situação financeira (próxima cobrança pendente + botão "Pagar com Pix") e resumo de comunicados (badge de não lidos + 3 mais recentes)
- **Meus Dados**: ficha completa (28/07) — dados pessoais, RG, endereço estruturado, categoria/situação, associado desde — além do já existente (nome, CPF, categoria, status), upload de foto (redimensionada no navegador). **Carteirinha digital** (28/07, plano Intermediário+): cartão com foto/nome/associação/categoria/status + QR code identificador (`ASSOCIADO:<id>`, sem endpoint de verificação por scan ainda — é cosmético/identificador por enquanto)
- **Financeiro** (28/07, virou aba própria, antes ficava dentro de "Meus Dados"): pagamento via Pix (QR code + copia-e-cola) e envio de comprovante
- **Comunicados**: mural com indicador de "não lido" e destaque visual, selo "Comunicado oficial" nos avisos enviados pelo Super Admin (28/07)

### 4.4 Transversal
- Login só com e-mail + senha (sem código/ID de associação)
- Senha provisória obrigatória para trocar no primeiro acesso (associação nova, associado novo, convite de usuário, reset feito por admin/super-admin)
- Sessão persistente (sobrevive a atualizar a página — `localStorage` + revalidação com o backend a cada requisição)
- Recuperação de senha: autosserviço por e-mail **não está ativo** (não há provedor de e-mail integrado ainda) — quem esquece a senha pede para o admin gerar um link (`POST /usuarios/:id/gerar-link-redefinicao`)
- Responsividade (desktop, tablet, celular)

## 5. Principais rotas da API

| Recurso | Rotas |
|---|---|
| Autenticação (associação) | `POST /auth/login`, `POST /auth/esqueci-senha`, `POST /auth/redefinir-senha`, `PUT /auth/senha`, `POST /auth/logout`, `PATCH /auth/boas-vindas-visto` (30/07, qualquer papel autenticado — marca o modal de boas-vindas como visto) |
| Super Admin | `POST /superadmin/bootstrap` (exige `BOOTSTRAP_SECRET`), `POST /superadmin/login`, `GET/POST/PUT/DELETE /superadmin/associacoes`, `GET /superadmin/associacoes/:id`, `GET /superadmin/associacoes/:id/associados`, `GET /superadmin/associacoes/:id/cobrancas`, `PATCH /superadmin/associacoes/:id/resetar-senha-admin`, `GET /superadmin/dashboard`, `GET/POST/PUT /superadmin/admins`, `PATCH /superadmin/admins/:id/status`, `PATCH /superadmin/admins/:id/senha`, `PUT /superadmin/perfil/senha`, `GET /superadmin/logs`, `GET /superadmin/logs/exportar/:formato` (só PDF desde 29/07), `GET/PATCH /superadmin/solicitacoes-plano...`, `GET/PUT /superadmin/configuracoes-plataforma`, `POST /superadmin/comunicados-plataforma` (28/07, broadcast pra todas as associações ativas) |
| Associados | `GET/POST/PUT/DELETE /associados` (POST já cria o login junto; campos incluem endereço estruturado e RG; POST bloqueia com 403 `LIMITE_ASSOCIADOS_ATINGIDO` ao atingir o limite do plano, 30/07; GET aceita paginação opt-in `?pagina=`/`?por_pagina=`, 28/07), `GET /associados/:id/comunicados` (histórico de leitura, filtro `?lido=lidos|nao_lidos`) |
| Financeiro | `GET/POST/PUT/DELETE /cobrancas` (`?associado_id=` filtra por associado; GET aceita paginação opt-in, 28/07), `PATCH /cobrancas/:id/pagar`, `PATCH /cobrancas/:id/estornar`, `GET /cobrancas/:id/comprovante` |
| Comunicados | `GET/POST/PUT/DELETE /comunicados` (PUT/DELETE bloqueiam com 403 em comunicado `origem_plataforma`, 28/07), `POST /comunicados/:id/marcar-lido`, `GET /comunicados/:id/leituras`, `GET /comunicados/:id/leituras/exportar/:formato` (só PDF desde 29/07) |
| Atividades | `GET /atividades` (últimas ~15 da associação, alimenta o Dashboard) |
| Auditoria (por associação) | `GET /auditoria`, `GET /auditoria/exportar/:formato` (mesma ideia de `/superadmin/logs`, já escopado pelo tenant; só PDF desde 29/07). Exige plano Avançado (`exigirPlano('avancado')`, 29/07) |
| Usuários | `GET/POST/PUT/DELETE /usuarios` (aceitam os 4 papéis granulares novos, 28/07, com checagem de plano ao atribuir um deles, 29/07), `GET /usuarios/associados-sem-login`, `PATCH /usuarios/:id/desativar`, `PATCH /usuarios/:id/reativar`, `PATCH /usuarios/:id/redefinir-senha`, `POST /usuarios/:id/gerar-link-redefinicao` (sem consumidor no front hoje), `GET /usuarios/logs-autenticacao` |
| Portal do associado | `GET /portal/meus-dados` (ganhou `boas_vindas_pendente`/`nome_associacao`, 30/07), `PUT /portal/minha-foto`, `GET /portal/minhas-cobrancas`, `PUT /portal/minhas-cobrancas/:id/comprovante` |
| Configurações | `GET/PUT /configuracoes/pix`, `GET/PUT /configuracoes/alertas` (PUT exige plano Intermediário+, 29/07), `GET /configuracoes/identidade`, `PUT /configuracoes/logo` (28/07, admin da associação troca a própria logo) |
| Plano da associação | `GET /plano` (ganhou `boas_vindas_pendente`, `alerta_limite`, `proximo_plano`, `planos_gerenciaveis`, `plano_renovacao_sugerido`, 30/07), `POST /plano/solicitar-contratacao` |
| Sprint (backlog interno) | `GET/POST/PUT/DELETE /sprint`, `PATCH /sprint/:id/status` |

Todas as rotas (exceto login/bootstrap/esqueci-senha/redefinir-senha) exigem token JWT (`Authorization: Bearer <token>`). O middleware `autenticar` revalida o token contra o banco a cada requisição (usuário/associação ainda ativos, papel em dia, e desde 29/07 também `senha_alterada_em` — um token emitido antes da última troca de senha é rejeitado mesmo sem ter expirado) — não confia só na assinatura do token.

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
cliente (agora restrito a `super_admin`/`administrador`). `helmet`
adicionado em `server.js` (HSTS, `nosniff`, `frame-options`, remove o
cabeçalho `X-Powered-By: Express`) — CSP equivalente do lado do painel
em `vercel.json`.

### ✅ Auditoria pré-lançamento — 5 achados médios + itens de severidade baixa (29/07/2026)
Auditoria completa pedida pelo usuário antes de abrir a plataforma pra clientes reais, cobrindo as 3 integrações (Super Admin/Painel/Portal):
- **IP forjável nos logs** (`utils/authLog.js`/`utils/auditoria.js` liam `X-Forwarded-For` manualmente, posição que o próprio cliente controla) — trocado por `req.ip`, que já respeita `trust proxy`.
- **`nome` de usuário sem validação** — novo `nomeValido()` (máx. 120 caracteres, bloqueia caracteres de controle) em `POST`/`PUT /usuarios`.
- **JWT não invalidado ao trocar senha** — nova coluna `senha_alterada_em` (seção 3), comparada com o `iat` do token a cada requisição.
- **Race condition em `POST /plano/solicitar-contratacao`** — índice único parcial no banco (`solicitacoes_plano_pendente_unica`) garante que duas requisições simultâneas nunca criem duas solicitações pendentes.
- **Exportação Excel removida por completo, só PDF continua** — `npm audit` reportava ~10 vulnerabilidades (na cadeia `exceljs → archiver`) sem correção disponível em nenhuma versão publicada do `exceljs`; a pedido do usuário, a lib foi removida inteira (`npm audit`: 10 → 0). Afeta `GET /superadmin/logs/exportar/:formato`, `GET /auditoria/exportar/:formato` e `GET /comunicados/:id/leituras/exportar/:formato` — os 3 só aceitam `pdf` agora.
- Itens menores da mesma auditoria: limite de tamanho em upload de logo do Super Admin (igualado às outras rotas de imagem), log de auditoria parou de gravar a logo em base64 inteira a cada edição de associação (só o essencial).

### ✅ Gating de funcionalidades por plano (29/07/2026)
Antes disso, nenhuma diferença de comportamento existia entre os planos além do limite de associados (só informativo). `exigirPlano(nivelMinimo)` (`middleware/auth.js`) aplicado a: alertas automáticos (`PUT /configuracoes/alertas`, Intermediário+), atribuir perfil de acesso granular (`POST`/`PUT /usuarios`, Intermediário+), exportar leituras de comunicado (Intermediário+), auditoria completa (`GET /auditoria*`, Avançado). Resposta 403 padronizada (`codigo: 'PLANO_INSUFICIENTE'`). **Grandfathering**: quem já usava um recurso continua, só bloqueia atribuir algo novo acima do plano atual.

### 🟡 Pendente, não urgente
- Token de sessão fica em `localStorage` no front-end — já bem mitigado pelo CORS restrito; o ideal estrutural seria migrar para cookie `httpOnly`
- Sem cache na revalidação de JWT — cada requisição autenticada faz uma consulta extra ao banco. Irrelevante no volume atual; só vale revisitar se o uso crescer muito
- Paginação nas listagens (`/associados`, `/cobrancas`, `/auditoria`) é **opt-in** desde 28/07 (só pagina se `?pagina=`/`?por_pagina=` vierem na query) — a busca/filtro das telas de Associados/Financeiro ainda carrega o array completo no front, mover isso pro backend também fica pra quando o volume real justificar
- Fotos/comprovantes guardados em base64 dentro do Postgres (`foto_base64`, `comprovante_base64`, `logo_base64`) — funciona no volume atual, mas migrar para armazenamento de objeto (Supabase Storage/S3, guardando só a URL) evita dor ao crescer
- Sem testes automatizados, principalmente de isolamento entre tenants
- Sem ferramenta de migração automatizada (migrations são `.sql` avulsos, aplicados manualmente — ver `supabase/README.md`)
- Falsificação do log de auditoria — o `nome` exibido nas descrições vem de `req.usuario.nome`, sem restrição de conteúdo além do `nomeValido()` acima (achado de 27/07, ainda não corrigido)
- Ausência de envio real de e-mail e de política de privacidade/LGPD (a plataforma guarda CPF/RG/endereço/foto) — levantado na auditoria de 27/07, fora do escopo de código

## 7. Cálculo de MRR e preços por plano

Novo arquivo `backend/utils/precos.js` (24/07/2026) centraliza a tabela de preços
e a lógica de cálculo de mensalidade para toda a plataforma. Cada plano tem um
preço-base + um preço por associado ativo:

```js
const PRECOS_PLANO = {
  trial:         { base: 0,     porAssociado: 0 },
  basico:        { base: 49.90, porAssociado: 2.00 },
  intermediario: { base: 99.90, porAssociado: 1.50 },
  avancado:      { base: 199.90, porAssociado: 1.00 },
};
```

Planos renomeados de `profissional`/`enterprise` para `intermediario`/`avancado` em 29/07/2026 (mesmos preços/faixas, só o rótulo — ver seção 3). Faixa de associados por plano (`LIMITE_ASSOCIADOS_PLANO`, só informativo até 29/07, **bloqueia cadastro de verdade desde 30/07** — ver seção 4.2): Básico até 50, Intermediário até 200, Avançado sem teto.

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
- **Downgrade de plano pelo cliente** — de propósito não implementado (decisão de negócio, 30/07): downgrade só pode ser feito pelo Super Admin, manualmente, depois de validar que a quantidade de associados cabe no plano menor. O cliente só consegue subir de plano (`planosGerenciaveis()`, `utils/precos.js`)
- Integração real de pagamento (Pix via gateway — Asaas/Efí) — contratação/upgrade/renovação de plano continuam manuais (comprovante + aprovação do Super Admin), decisão confirmada em 30/07 ao implementar o controle de limite/upgrade
- Envio de e-mail transacional (senha provisória, recuperação de senha por e-mail depende disso) — ver seção 6 para os demais pendentes de segurança (falsificação do log de auditoria, LGPD)
- Itens que dependem de serviço externo, tratados como projetos futuros separados: WhatsApp API, 2FA, backups automáticos, Central de Suporte, integrações de pagamento adicionais (Mercado Pago, Stripe)

## 10. Convenções do projeto

- Todo o frontend é HTML/CSS/JS puro, sem build step — arquivos são editados e publicados diretamente
- Migrações de banco são scripts `.sql` avulsos em `supabase/migrations/`, nomeados por timestamp, aplicados manualmente (não há ferramenta de migração automatizada) — ver `supabase/README.md` para o processo
- Deploy é automático via push no GitHub (Render e Vercel observam os respectivos repositórios)
- Ver `CLAUDE.md` para o contexto voltado a sessões de IA trabalhando neste repositório (arquitetura resumida, decisões não-óbvias, cuidados ao mexer em RLS/deploy)
