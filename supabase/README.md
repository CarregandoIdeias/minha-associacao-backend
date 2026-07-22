# Migrations do Supabase

Esta pasta versiona o schema PostgreSQL usado pela API.

## Regra de segurança

`20260722000000_baseline_schema.sql` é um retrato do banco existente em 22/07/2026.
**Não execute esse arquivo no Supabase de produção atual**, pois as tabelas já existem.

As próximas alterações devem ser adicionadas em um novo arquivo com timestamp maior, por exemplo:

`20260723090000_adicionar_documentos.sql`

Antes de aplicar uma migration em produção:

1. Faça backup do banco no Supabase.
2. Revise o SQL e teste em um projeto de desenvolvimento.
3. Execute a migration pelo SQL Editor ou por uma futura configuração do Supabase CLI.
4. Registre o commit correspondente no Git antes do deploy da API que depende dela.

## RLS

O schema possui políticas de isolamento por `associacao_id`. As tabelas pertencem ao papel `postgres` e o RLS ainda não está forçado. Não altere isso isoladamente: a correção exige separar o acesso privilegiado do superadmin do acesso tenant da aplicação, para não interromper rotas existentes.
