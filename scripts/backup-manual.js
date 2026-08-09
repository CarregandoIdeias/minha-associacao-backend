#!/usr/bin/env node
// backup-manual.js
//
// Backup lógico manual, via SQL puro, sem pg_dump/psql (não instalados nesta
// máquina -- confirmado na auditoria de segurança de 08/08/2026, seção
// SEC-029). Usa o pacote `pg`, que o backend já traz como dependência.
//
// O que faz: conecta com o mesmo bypass de RLS que o Super Admin usa
// (app.superadmin_bypass = 'true'), descobre as tabelas do schema `public`
// dinamicamente e grava cada uma como um .json (array de linhas) numa pasta
// com timestamp. Puramente leitura -- nenhum UPDATE/INSERT/DELETE, e
// `app_runtime` não tem DDL mesmo que tivesse.
//
// Pasta de saída: por padrão, fora de qualquer repositório git (um nível
// acima de backend/ e painel/), pra não ter risco nenhum de CPF/RG/dado
// financeiro ir parar num commit por engano.
//
// USO:
//   node scripts/backup-manual.js
//     -> usa o DATABASE_URL do .env local (hoje aponta pra staging)
//
//   Rodando contra produção, SEM tocar no .env (evita o risco documentado
//   de esquecer de reverter -- ver CLAUDE.md, incidente de 27/07):
//   PowerShell:
//     $env:DATABASE_URL = "postgres://...producao..."; node scripts/backup-manual.js; Remove-Item Env:\DATABASE_URL
//   bash:
//     DATABASE_URL="postgres://...producao..." node scripts/backup-manual.js
//
// Nenhuma outra variável de ambiente é necessária -- este script não usa
// config/env.js de propósito (aquele módulo exige JWT_SECRET/CORS_ORIGINS
// quando NODE_ENV=production, o que não tem nada a ver com um backup).

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('DATABASE_URL não definida (nem no .env, nem no ambiente). Abortando.');
    process.exit(1);
}

// Mesma CA do db.js -- certificado público, não é segredo.
const supabaseCa = fs.readFileSync(path.join(__dirname, '..', 'config', 'supabase-ca.pem'), 'utf8');

const TENANT_NENHUM = '00000000-0000-0000-0000-000000000000';

function timestampArquivo() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function hostMascarado(url) {
    try {
        const u = new URL(url);
        return `${u.hostname} (usuário ${u.username})`;
    } catch {
        return '(não consegui interpretar a URL)';
    }
}

async function main() {
    const pastaSaida = path.join(__dirname, '..', '..', 'backups', `backup_${timestampArquivo()}`);
    fs.mkdirSync(pastaSaida, { recursive: true });

    console.log(`Conectando em: ${hostMascarado(DATABASE_URL)}`);
    console.log(`Saída: ${pastaSaida}`);

    const client = new Client({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: true, ca: supabaseCa },
    });
    await client.connect();

    try {
        // Mesmo padrão de sqlSessao() do middleware/auth.js: sem tenant, com
        // bypass de super-admin ligado -- enxerga todas as linhas de todas as
        // tabelas, do mesmo jeito que o painel de Super Admin enxerga.
        await client.query(
            `SELECT set_config('app.current_associacao_id', $1, false),
                    set_config('app.superadmin_bypass', $2, false),
                    set_config('app.auth_bypass', $3, false)`,
            [TENANT_NENHUM, 'true', 'false']
        );

        const { rows: tabelas } = await client.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
             ORDER BY table_name`
        );

        const manifesto = { geradoEm: new Date().toISOString(), host: hostMascarado(DATABASE_URL), tabelas: [] };

        for (const { table_name: tabela } of tabelas) {
            const ident = client.escapeIdentifier ? client.escapeIdentifier(tabela) : `"${tabela.replace(/"/g, '""')}"`;
            const { rows } = await client.query(`SELECT * FROM ${ident}`);
            const arquivo = path.join(pastaSaida, `${tabela}.json`);
            fs.writeFileSync(arquivo, JSON.stringify(rows, null, 2), 'utf8');
            manifesto.tabelas.push({ tabela, linhas: rows.length });
            console.log(`  ${tabela}: ${rows.length} linha(s)`);
        }

        fs.writeFileSync(path.join(pastaSaida, '_manifesto.json'), JSON.stringify(manifesto, null, 2), 'utf8');
        console.log(`\nOK -- ${manifesto.tabelas.length} tabelas gravadas em ${pastaSaida}`);
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('Backup falhou:', err);
    process.exit(1);
});
