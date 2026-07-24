# Documentação — Plataforma para Associações

**Produto:** Sistema de gestão multi-tenant para associações, com camada de Super Admin (SaaS)
**Mantido por:** Julião — Carregando Ideias
**Última atualização:** 23 de julho de 2026

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

## 3. Modelo de dados (tabelas principais)

- `associacoes` — tenant. Campos: nome, tipo, cnpj, plano, ativo, email, telefone, endereco, cidade, estado, chave_pix, nome_recebedor_pix, cidade_pix, dias_alerta_vencimento
- `usuarios` — login de cada pessoa (papel: admin/diretoria/associado), vinculado a uma associação
- `associados` — cadastro do membro (nome, cpf, telefone, categoria, status, observação, foto_base64, usuario_id opcional)
- `cobrancas` — mensalidades/taxas (valor, vencimento, status, comprovante_base64)
- `pagamentos` — histórico de pagamentos confirmados
- `comunicados` — mural (destaque, status, agendamento)
- `comunicado_leituras` — quem já visualizou cada comunicado
- `password_resets` — tokens de redefinição de senha (associações)
- `super_admins` — super-admins da plataforma (tabela separada do sistema multi-tenant)

Isolamento entre associações feito por `associacao_id` em cada tabela + filtro nas queries da aplicação (ver seção de Segurança sobre RLS).

## 4. Funcionalidades por papel

### 4.1 Super Admin
- Login próprio, separado do sistema das associações
- Dashboard: saudação personalizada, KPIs (associações, associados, receita mensal, mensalidades vencidas, ativas/bloqueadas), gráficos de crescimento (associações e novos associados, últimos 7 meses)
- CRUD de associações, com filtros (nome, cidade, plano, status)
- Tela de detalhe por associação, com abas: Informações, Usuário (+ redefinir senha do admin), Financeiro (recebido/a receber/próximo vencimento), Associados (só-leitura), Cobranças (só-leitura), Configurações
- Autocadastro público de associações foi **removido** — só o super-admin cria novas associações

### 4.2 Admin / Diretoria da associação
- **Associados**: CRUD completo, validação de CPF (dígito verificador) e categoria/observação/telefone, busca e filtro por status, KPIs clicáveis
- **Financeiro**: cobranças com Pix estático (QR code real + "copia e cola", sem gateway externo), upload de comprovante pelo associado, confirmação manual pelo admin, estorno de pagamento, edição/exclusão, alerta de vencimento configurável (dias de antecedência)
- **Comunicados**: mural com busca, filtro por status, agendamento de publicação, destaque, contagem de visualizações
- **Usuários**: convite de novos usuários (diretoria/associado) via link, vínculo de login a um cadastro de associado específico, edição de papel, exclusão
- **Configurações**: chave Pix da associação, dias de alerta de vencimento

### 4.3 Associado
- **Meus Dados**: perfil próprio (nome, CPF, categoria, status), upload de foto (redimensionada no navegador)
- **Minhas cobranças**: pagamento via Pix (QR code + copia-e-cola) e envio de comprovante
- **Comunicados**: mural com indicador de "não lido" e destaque visual

### 4.4 Transversal
- Sessão persistente (sobrevive a atualizar a página — `localStorage` + revalidação com o backend)
- Recuperação de senha (ver ressalva de segurança abaixo)
- Responsividade (desktop, tablet, celular)

## 5. Principais rotas da API

| Recurso | Rotas |
|---|---|
| Autenticação (associação) | `POST /auth/login`, `POST /auth/esqueci-senha`, `POST /auth/redefinir-senha` |
| Super Admin | `POST /superadmin/bootstrap`, `POST /superadmin/login`, `GET/POST/PUT/DELETE /superadmin/associacoes`, `GET /superadmin/associacoes/:id`, `GET /superadmin/associacoes/:id/associados`, `GET /superadmin/associacoes/:id/cobrancas`, `PATCH /superadmin/associacoes/:id/resetar-senha-admin`, `GET /superadmin/dashboard` |
| Associados | `GET/POST/PUT/DELETE /associados` |
| Financeiro | `GET/POST/PUT/DELETE /cobrancas`, `PATCH /cobrancas/:id/pagar`, `PATCH /cobrancas/:id/estornar`, `GET /cobrancas/:id/comprovante` |
| Comunicados | `GET/POST/PUT/DELETE /comunicados`, `POST /comunicados/:id/marcar-lido` |
| Usuários | `GET/POST/PUT/DELETE /usuarios`, `GET /usuarios/associados-sem-login`, `PATCH /usuarios/:id/desativar` |
| Portal do associado | `GET /portal/meus-dados`, `PUT /portal/minha-foto`, `GET /portal/minhas-cobrancas`, `PUT /portal/minhas-cobrancas/:id/comprovante` |
| Configurações | `GET/PUT /configuracoes/pix`, `GET/PUT /configuracoes/alertas` |

Todas as rotas (exceto login/bootstrap) exigem token JWT (`Authorization: Bearer <token>`), verificado por middleware.

## 6. Segurança — situação atual e recomendações

### ✅ Corrigido — recuperação de senha
A rota `POST /auth/esqueci-senha` **não gera mais token nenhum**. Agora, só um admin autenticado pode gerar um link de redefinição para outra pessoa da própria associação, pela rota `POST /usuarios/:id/gerar-link-redefinicao` (botão "Gerar link de senha" na aba Usuários do painel). Isso elimina o sequestro de conta que existia antes (qualquer pessoa com e-mail + ID da associação conseguia o token direto).

### ✅ Corrigido — isolamento entre associações (achado durante a auditoria motivada pela questão da RLS)
Fizemos uma auditoria completa de todas as rotas em busca de queries que dependiam só da RLS para isolar dados por associação. Encontramos e corrigimos **9 pontos** que, sem a RLS, deixavam dados de uma associação visíveis/editáveis por outra:

- `GET /cobrancas`, `GET /comunicados`, `GET /usuarios`, `GET /associados`, `GET /usuarios/associados-sem-login` — listagens sem filtro por `associacao_id` (expunham dados de todas as associações da plataforma)
- `PATCH /cobrancas/:id/pagar`, `PATCH /cobrancas/:id/estornar`, `GET /cobrancas/:id/comprovante`, `PUT /cobrancas/:id`, `DELETE /cobrancas/:id` — filtravam só por `id`, sem confirmar a associação
- `PUT/DELETE /associados/:id`, `PUT/DELETE /comunicados/:id`, `PUT/PATCH/DELETE /usuarios/:id` — mesmo padrão
- Vínculo de usuário↔associado ao convidar alguém — não confirmava que o associado pertencia à mesma associação do admin que estava convidando

Todas essas rotas agora exigem explicitamente `associacao_id = <associação de quem está autenticado>` nas queries, independente da RLS.

### ✅ Corrigido — rate limiting e aviso de JWT_SECRET
Login (associação e super-admin) e redefinição de senha agora bloqueiam depois de várias tentativas em 15 minutos (`express-rate-limit`). O servidor também registra um aviso no log de inicialização se o `JWT_SECRET` não estiver definido ou estiver usando o valor padrão de exemplo.

### 🟠 RLS forçada — em andamento, houve um incidente
Ao aplicar `FORCE ROW LEVEL SECURITY` nas tabelas (`usuarios`, `associados`, `cobrancas`, `comunicados`, `pagamentos`), descobrimos que, ao contrário do esperado, o papel `postgres` no Supabase **não** ignora a RLS forçada automaticamente — ou seja, ela passou a ser aplicada de fato, imediatamente. Isso expôs duas rotas que consultavam essas tabelas sem passar pelo mecanismo que informa ao banco qual associação está sendo acessada: `POST /auth/login` e `POST /auth/redefinir-senha`. Resultado: login parou de funcionar para todo mundo até identificarmos e corrigirmos.

**Correção aplicada:** as duas rotas agora usam a conexão de bypass do super-admin (`comConexaoSuperAdmin`) — seguro nesse caso porque a verificação real de qual associação pertence a qual usuário já é feita explicitamente no `WHERE` da query (ou pelo token secreto de redefinição), independente da RLS.

**Rollback de emergência usado durante o incidente** (documentado para referência futura, caso precise de novo):
```sql
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE associados NO FORCE ROW LEVEL SECURITY;
ALTER TABLE cobrancas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE comunicados NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pagamentos NO FORCE ROW LEVEL SECURITY;
```

**Status:** código corrigido, aguardando reaplicação cuidadosa do `FORCE ROW LEVEL SECURITY` e da troca para o usuário de banco não-dono (`app_backend`), com testes completos de login em cada papel antes e depois.

### 🟡 Recomendado, não urgente
- CORS aberto para qualquer origem

### ✅ Já implementado corretamente
- Senhas armazenadas com hash bcrypt (nunca em texto puro)
- Validação de UUID antes de interpolar em SQL (`comConexaoTenant`), evitando injeção nesse ponto
- Tokens JWT com expiração (8h)
- HTTPS nativo (Render e Vercel)
- Permissões por papel (admin/diretoria/associado) verificadas em cada rota sensível
- `.env` fora do controle de versão (git)
- Isolamento entre associações garantido explicitamente em toda rota que lê/edita/exclui dados (ver auditoria acima)
- Rate limiting em rotas de autenticação

## 7. Variáveis de ambiente (backend)

```
DATABASE_URL=<connection string do Supabase — Session Pooler>
JWT_SECRET=<segredo forte e único>
PORT=3000
NODE_ENV=production
```

## 8. Pendências conhecidas / roadmap

- Reaplicar `FORCE ROW LEVEL SECURITY` + trocar para usuário de banco `app_backend` (código já corrigido; falta reexecutar a migração com cuidado e testar)
- Reordenar menu do associado (Meus Dados como página inicial)
- Saudação personalizada no cabeçalho do painel da associação (já existe no Super Admin)
- Login por nome da associação em vez de ID
- Revisão geral de UX/UI do painel da associação
- Integração real de pagamento (Pix via gateway — Asaas/Efí), hoje é confirmação manual
- Comunicados em massa (Super Admin → várias associações) e Relatórios exportáveis
- Usuários da plataforma com perfis (Super Admin, Suporte, Financeiro) e Configurações gerais
- Logs de auditoria (login, exclusão, mudança de senha, etc.)
- Itens que dependem de serviço externo, tratados como projetos futuros separados: WhatsApp API, 2FA, backups automáticos, Central de Suporte, integrações de pagamento adicionais (Mercado Pago, Stripe)

## 9. Convenções do projeto

- Todo o frontend é HTML/CSS/JS puro, sem build step — arquivos são editados e publicados diretamente
- Migrações de banco são scripts `.sql` avulsos, executados manualmente no SQL Editor do Supabase (não há ferramenta de migração automatizada)
- Deploy é automático via push no GitHub (Render e Vercel observam os respectivos repositórios)
