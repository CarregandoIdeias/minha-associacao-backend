// utils/exportarLeiturasComunicado.js
// Gera os arquivos de exportação da lista de leitura de um comunicado
// (item de sprint 3, "Confirmação de Leitura") -- mesmo padrão de
// utils/exportarLogs.js (exceljs/pdfkit), lista já vem pronta da rota.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { sanitizarCelulaExcel } = require('./validacao');

async function gerarExcelLeituras(tituloComunicado, linhas) {
    const workbook = new ExcelJS.Workbook();
    const planilha = workbook.addWorksheet('Leituras');

    planilha.columns = [
        { header: 'Associado', key: 'nome', width: 30 },
        { header: 'E-mail', key: 'email', width: 32 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Data da leitura', key: 'data', width: 20 },
    ];
    planilha.getRow(1).font = { bold: true };

    linhas.forEach((linha) => {
        planilha.addRow({
            nome: sanitizarCelulaExcel(linha.nome),
            email: sanitizarCelulaExcel(linha.email),
            status: linha.lido ? 'Lido' : 'Não lido',
            data: linha.lido_em ? new Date(linha.lido_em).toLocaleString('pt-BR') : '—',
        });
    });

    return workbook.xlsx.writeBuffer();
}

// pdfkit não tem suporte nativo a tabelas -- desenha manualmente, mesmo
// padrão de utils/exportarLogs.js.
function gerarPdfLeituras(tituloComunicado, linhas) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        const buffers = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        const colunas = [
            { chave: 'nome', titulo: 'Associado', largura: 170 },
            { chave: 'email', titulo: 'E-mail', largura: 170 },
            { chave: 'status', titulo: 'Status', largura: 70 },
            { chave: 'data', titulo: 'Data da leitura', largura: 100 },
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

        doc.fontSize(14).font('Helvetica-Bold').text('Leituras — ' + tituloComunicado, { align: 'left' });
        const lidos = linhas.filter((l) => l.lido).length;
        doc.fontSize(9).font('Helvetica').text(
            'Enviado para ' + linhas.length + ' associados · Lido por ' + lidos + ' · Pendente ' + (linhas.length - lidos) +
            ' · Taxa de leitura ' + (linhas.length ? ((lidos / linhas.length) * 100).toFixed(1) : '0') + '%'
        );
        doc.moveDown(0.8);
        desenharCabecalho();

        linhas.forEach((linha) => {
            if (doc.y > doc.page.height - doc.page.margins.bottom - alturaLinha) {
                doc.addPage();
                desenharCabecalho();
            }
            const y = doc.y;
            let x = margemEsquerda;
            const valores = {
                nome: linha.nome,
                email: linha.email,
                status: linha.lido ? 'Lido' : 'Não lido',
                data: linha.lido_em ? new Date(linha.lido_em).toLocaleString('pt-BR') : '—',
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

module.exports = { gerarExcelLeituras, gerarPdfLeituras };
