# Documentação — Plataforma para Associações

**Produto:** Sistema de gestão multi-tenant para associações, com camada de Super Admin (SaaS)
**Mantido por:** Julião — Carregando Ideias
**Última atualização:** 24 de julho de 2026

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

**Identidade visual:** paleta e tipografia do AvaliaPlus (outro produto do Carregando Ideias) — dourado `#C9A84C`, preto `#0A0A0A` / bege claro `#F7F5EF`, fontes Playfair Display + Inter + JetBrains Mono. Tema claro/escuro em ambos os painéis.

**Conexão com o banco:** o backend conecta como a role `app_runtime`, criada especificamente para isso e **sem ser dona das tabelas** (o dono é `postgres`, usado só para rodar migrações). Isso é o que faz o isolamento entre associações (RLS) valer de verdade — ver seção 6.

## 3. Modelo de dados (tabelas principais)

- `associacoes` — tenant. Campos: nome, tipo, cnpj, plano, ativo, email, telefone, endereco, cidade, estado, chave_pix, nome_recebedor_pix, cidade_pix, dias_alerta_vencimento
- `usuarios` — login de cada pessoa (papel: admin/diretoria/associado), vinculado a uma associação. E-mail é **único em toda a plataforma** (não só dentro da associação). Tem `deve_trocar_senha` (força troca no primeiro acesso)
- `associados` — cadastro do membro (nome, cpf, telefone, categoria, status, observação, foto_base64, usuario_id opcional)
- `cobrancas` — mensalidades/taxas (valor, vencimento, status, comprovante_base64)
- `pagamentos` — histórico de pagamentos confirmados
- `comunicados` — mural (destaque, status, agendamento)
- `comunicado_leituras` — quem já visualizou cada comunicado
- `password_resets` — tokens de redefinição de senha (gerados por um admin para outra pessoa da associação)
- `super_admins` — super-admins da plataforma (tabela separada do sistema multi-tenant, sem RLS — não tem coluna de tenant para isolar)
- `auth_logs` — log de eventos de autenticação (login, logout, troca/redefinição de senha) por associação

Isolamento entre associações garantido em duas camadas independentes: filtro explícito `associacao_id = ...` em toda query da aplicação **e** Row Level Security forçada no Postgres (ver seção 6) — mesmo uma rota nova que esqueça o filtro não consegue ler dado de outro tenant.

## 4. Funcionalidades por papel

### 4.1 Super Admin
- Login próprio (e-mail + senha), separado do sistema das associações
- Dashboard: saudação personalizada, KPIs (associações, associados, receita mensal, mensalidades vencidas, ativas/bloqueadas), gráficos de crescimento (associações e novos associados, últimos 7 meses)
- CRUD de associações, com filtros (nome, cidade, plano, status)
- Ao criar uma associação, informa só nome do admin + e-mail principal (que já é o login) — senha provisória é gerada automaticamente e exibida uma única vez
- Tela de detalhe por associação, com abas: Informações, Usuário (+ gerar senha provisória nova para o admin), Financeiro (recebido/a receber/próximo vencimento), Associados (só-leitura), Cobranças (só-leitura), Configurações
- Bloquear uma associação (`ativo = false`) impede login de todos os usuários dela imediatamente
- Autocadastro público de associações foi **removido** — só o super-admin cria novas associações

### 4.2 Admin / Diretoria da associação
- **Associados**: cadastro já pede e-mail e cria o login junto (senha provisória automática, exibida uma vez), CRUD completo, validação de CPF (dígito verificador), busca e filtro por status, KPIs clicáveis
- **Financeiro**: cobranças com Pix estático (QR code real + "copia e cola", sem gateway externo), upload de comprovante pelo associado, confirmação manual pelo admin, estorno de pagamento, edição/exclusão, alerta de vencimento configurável (dias de antecedência)
- **Comunicados**: mural com busca, filtro por status, agendamento de publicação, destaque, contagem de visualizações
- **Usuários**: convite de novos usuários (diretoria/associado) com senha provisória automática, vínculo de login a um cadastro de associado específico, edição de papel, desativação (corta acesso imediatamente, mesmo com token válido), exclusão
- **Configurações**: chave Pix da associação, dias de alerta de vencimento

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
| Super Admin | `POST /superadmin/bootstrap` (exige `BOOTSTRAP_SECRET`), `POST /superadmin/login`, `GET/POST/PUT/DELETE /superadmin/associacoes`, `GET /superadmin/associacoes/:id`, `GET /superadmin/associacoes/:id/associados`, `GET /superadmin/associacoes/:id/cobrancas`, `PATCH /superadmin/associacoes/:id/resetar-senha-admin`, `GET /superadmin/dashboard` |
| Associados | `GET/POST/PUT/DELETE /associados` (POST já cria o login junto) |
| Financeiro | `GET/POST/PUT/DELETE /cobrancas`, `PATCH /cobrancas/:id/pagar`, `PATCH /cobrancas/:id/estornar`, `GET /cobrancas/:id/comprovante` |
| Comunicados | `GET/POST/PUT/DELETE /comunicados`, `POST /comunicados/:id/marcar-lido` |
| Usuários | `GET/POST/PUT/DELETE /usuarios`, `GET /usuarios/associados-sem-login`, `PATCH /usuarios/:id/desativar`, `POST /usuarios/:id/gerar-link-redefinicao`, `GET /usuarios/logs-autenticacao` |
| Portal do associado | `GET /portal/meus-dados`, `PUT /portal/minha-foto`, `GET /portal/minhas-cobrancas`, `PUT /portal/minhas-cobrancas/:id/comprovante` |
| Configurações | `GET/PUT /configuracoes/pix`, `GET/PUT /configuracoes/alertas` |

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

### 🟡 Pendente, não urgente
- Token de sessão fica em `localStorage` no front-end — já bem mitigado pelo CORS restrito; o ideal estrutural seria migrar para cookie `httpOnly`
- Sem cache na revalidação de JWT — cada requisição autenticada faz uma consulta extra ao banco. Irrelevante no volume atual; só vale revisitar se o uso crescer muito
- Sem paginação nas listagens (`/associados`, `/cobrancas`) — ok para o volume atual
- Sem testes automatizados, principalmente de isolamento entre tenants
- Sem ferramenta de migração automatizada (migrations são `.sql` avulsos, aplicados manualmente — ver `supabase/README.md`)

## 7. Variáveis de ambiente (backend)

```
DATABASE_URL=<connection string do Supabase — Session Pooler, usuário app_runtime>
JWT_SECRET=<segredo forte e único>
PORT=3000
NODE_ENV=production
CORS_ORIGINS=https://minha-associacao-painel.vercel.app
BOOTSTRAP_SECRET=<segredo forte, usado só para criar o primeiro super-admin>
```

Em produção, o servidor recusa subir se `DATABASE_URL`, `JWT_SECRET` ou `CORS_ORIGINS` estiverem faltando. `BOOTSTRAP_SECRET` é opcional — se faltar, a rota de bootstrap fica sempre bloqueada (falha segura), não derruba o servidor.

## 8. Pendências conhecidas / roadmap

- Reordenar menu do associado (Meus Dados como página inicial)
- Saudação personalizada no cabeçalho do painel da associação (já existe no Super Admin)
- Revisão geral de UX/UI do painel da associação
- Integração real de pagamento (Pix via gateway — Asaas/Efí), hoje é confirmação manual
- Comunicados em massa (Super Admin → várias associações) e Relatórios exportáveis
- Usuários da plataforma com perfis (Super Admin, Suporte, Financeiro) e Configurações gerais
- Envio de e-mail transacional (senha provisória, recuperação de senha por e-mail depende disso)
- Itens que dependem de serviço externo, tratados como projetos futuros separados: WhatsApp API, 2FA, backups automáticos, Central de Suporte, integrações de pagamento adicionais (Mercado Pago, Stripe)

## 9. Convenções do projeto

- Todo o frontend é HTML/CSS/JS puro, sem build step — arquivos são editados e publicados diretamente
- Migrações de banco são scripts `.sql` avulsos em `supabase/migrations/`, nomeados por timestamp, aplicados manualmente (não há ferramenta de migração automatizada) — ver `supabase/README.md` para o processo
- Deploy é automático via push no GitHub (Render e Vercel observam os respectivos repositórios)
- Ver `CLAUDE.md` para o contexto voltado a sessões de IA trabalhando neste repositório (arquitetura resumida, decisões não-óbvias, cuidados ao mexer em RLS/deploy)
