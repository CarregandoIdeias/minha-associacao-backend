// utils/exportarLogs.js
// Gera o PDF de exportação da tela de Auditoria a partir da mesma lista de
// linhas já filtrada/ordenada pela rota GET /superadmin/logs.
//
// Exportação em Excel (exceljs) foi removida em 29/07/2026, achado na
// auditoria de segurança pré-lançamento: TODA versão publicada do exceljs
// depende, direta ou indiretamente, do pacote `archiver` (usado pra montar
// o .xlsx como zip), cuja árvore de dependências (glob/minimatch/
// brace-expansion/rimraf/uuid/zip-stream) carrega ~10 vulnerabilidades
// (9 high, 1 moderate) sem nenhuma versão do exceljs que escape disso --
// testado trocando entre 4.4.0/3.10.0/3.4.0, `npm audit` sempre reportava
// exceljs como vulnerável de novo, só mudando o range. Decisão do usuário:
// já que só o Excel dependia do exceljs, manter só a exportação em PDF
// (pdfkit, sem essa cadeia de dependências, `npm audit` limpo) em vez de
// arriscar um downgrade que não resolve o problema de verdade.
const PDFDocument = require('pdfkit');

const ROTULOS_TIPO_ACAO = {
    login: 'Login',
    logout: 'Logout',
    criacao: 'Criação',
    edicao: 'Edição',
    exclusao: 'Exclusão',
    alteracao_senha: 'Alteração de senha',
    alteracao_permissoes: 'Alteração de permissões',
    exportacao: 'Exportação de dados',
};

function nomeAtor(linha) {
    return linha.super_admin_nome || linha.usuario_nome || linha.usuario_email || linha.super_admin_email || '—';
}

// pdfkit não tem suporte nativo a tabelas -- desenha manualmente com larguras
// fixas, quebrando página quando o conteúdo não cabe mais.
function gerarPdfLogs(linhas) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
        const buffers = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        const colunas = [
            { chave: 'data', titulo: 'Data/Hora', largura: 100 },
            { chave: 'usuario', titulo: 'Usuário', largura: 120 },
            { chave: 'associacao', titulo: 'Associação', largura: 110 },
            { chave: 'modulo', titulo: 'Módulo', largura: 90 },
            { chave: 'tipo_acao', titulo: 'Tipo de ação', largura: 110 },
            { chave: 'descricao', titulo: 'Descrição', largura: 240 },
        ];
        const margemEsquerda = doc.page.margins.left;
        const alturaLinha = 20;

        function desenharCabecalho() {
            doc.font('Helvetica-Bold').fontSize(9);
            let x = margemEsquerda;
            colunas.forEach((coluna) => {
                doc.text(coluna.titulo, x, doc.y, { width: coluna.largura, lineBreak: false });
                x += coluna.largura;
            });
            doc.moveDown();
            doc.font('Helvetica').fontSize(8);
        }

        doc.fontSize(14).font('Helvetica-Bold').text('Logs de auditoria', { align: 'left' });
        doc.moveDown(0.5);
        desenharCabecalho();

        linhas.forEach((linha) => {
            if (doc.y > doc.page.height - doc.page.margins.bottom - alturaLinha) {
                doc.addPage();
                desenharCabecalho();
            }
            const y = doc.y;
            let x = margemEsquerda;
            const valores = {
                data: new Date(linha.criado_em).toLocaleString('pt-BR'),
                usuario: nomeAtor(linha),
                associacao: linha.associacao_nome || '—',
                modulo: linha.modulo,
                tipo_acao: ROTULOS_TIPO_ACAO[linha.tipo_acao] || linha.tipo_acao,
                descricao: linha.descricao,
            };
            colunas.forEach((coluna) => {
                doc.text(String(valores[coluna.chave] || ''), x, y, { width: coluna.largura - 4, height: alturaLinha });
                x += coluna.largura;
            });
            doc.y = y + alturaLinha;
        });

        doc.end();
    });
}

module.exports = { gerarPdfLogs };
