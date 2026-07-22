# API da Plataforma de Associações

## Variáveis de ambiente

Copie `.env.example` para `.env` no ambiente local e preencha os valores.

No Render, configure obrigatoriamente:

- `NODE_ENV=production`
- `DATABASE_URL`: conexão PostgreSQL fornecida pelo Supabase
- `JWT_SECRET`: segredo longo e aleatório, exclusivo do ambiente de produção
- `CORS_ORIGINS=https://minha-associacao-painel.vercel.app`

`PORT` é fornecida automaticamente pelo Render; não é necessário configurá-la.

## Verificação de disponibilidade

Após publicar, acesse `GET /health`. A resposta esperada é:

```json
{ "status": "ok" }
```

## Execução local

```bash
npm install
npm run dev
```
