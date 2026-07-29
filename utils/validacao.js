// utils/validacao.js
const crypto = require('crypto');

// Valida CPF usando o algoritmo oficial de dígitos verificadores
// (rejeita CPFs com todos os dígitos iguais, tipo 111.111.111-11)
function cpfValido(cpf) {
    if (!cpf) return false;
    var limpo = cpf.replace(/[^\d]/g, '');

    if (limpo.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(limpo)) return false;

    var soma = 0;
    for (var i = 0; i < 9; i++) {
        soma += parseInt(limpo.charAt(i), 10) * (10 - i);
    }
    var resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(limpo.charAt(9), 10)) return false;

    soma = 0;
    for (var i = 0; i < 10; i++) {
        soma += parseInt(limpo.charAt(i), 10) * (11 - i);
    }
    resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(limpo.charAt(10), 10)) return false;

    return true;
}

// Validação de formato de e-mail (RFC simplificada, suficiente para cadastro)
function emailValido(email) {
    if (!email) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Valida nome de usuário/pessoa (achado na auditoria de 29/07/2026: o nome
// de usuário não tinha validação nenhuma além de "não vazio", e esse valor
// vira `usuario_nome`/descrição em logs_auditoria e atividades -- dava pra
// cadastrar um usuário com um nome tipo frase inteira, se passando por outra
// ação no histórico de auditoria). Bloqueia caracteres de controle e o
// mesmo alfabeto que sanitizarCelulaExcel() neutraliza (defesa em
// profundidade -- essa validação barra na entrada, aquela protege na saída
// pra qualquer outro campo de texto livre que acabe exportado).
function nomeValido(nome) {
    if (!nome || typeof nome !== 'string') return false;
    const limpo = nome.trim();
    if (limpo.length < 1 || limpo.length > 120) return false;
    if (/[\x00-\x1F\x7F]/.test(limpo)) return false;
    return true;
}

// Neutraliza formula injection em planilhas Excel (achado na auditoria de
// 29/07/2026): uma célula cujo texto começa com =, +, -, @ ou tab é
// interpretada como fórmula por padrão pelo Excel/LibreOffice ao abrir o
// arquivo -- se esse texto vier de um campo de usuário (nome, descrição,
// título de comunicado), um `atendimento`/`operador` malicioso pode
// injetar algo como "=HYPERLINK(...)" que executa quando o admin/Super
// Admin abre a planilha exportada. Prefixar com aspas simples faz o
// Excel tratar como texto literal, sem mudar o que aparece pro usuário.
function sanitizarCelulaExcel(valor) {
    if (valor === null || valor === undefined) return valor;
    const texto = String(valor);
    if (/^[=+\-@\t\r]/.test(texto)) return "'" + texto;
    return texto;
}

// Valida um data URL base64 de ponta a ponta (não só o prefixo).
//
// IMPORTANTE -- essa validação é de SEGURANÇA, não só de formato. Antes existia
// só um startsWith('data:image/'), o que deixava o resto da string livre: dava
// pra guardar `data:image/png;base64,X" onerror="..."` e, como o front-end
// montava <img src="..."> por concatenação, o valor escapava do atributo e
// virava XSS armazenado na sessão de quem visualizasse (um comprovante enviado
// por um cliente executava script na tela do Super Admin). A regex abaixo só
// aceita o alfabeto base64 real, onde aspas simplesmente não existem.
//
// O front-end também foi corrigido para não concatenar em HTML (ver
// painel/CLAUDE.md), mas as duas camadas ficam de propósito: mesmo que um sink
// novo apareça no futuro, o dado guardado no banco continua inofensivo.
const MIMES_IMAGEM = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const MIME_PDF = 'application/pdf';

function dataUrlValido(valor, mimesPermitidos) {
    if (!valor || typeof valor !== 'string') return false;

    const separador = valor.indexOf(';base64,');
    if (separador === -1) return false;

    const mime = valor.substring(5, separador); // pula o "data:"
    if (!valor.startsWith('data:') || !mimesPermitidos.includes(mime)) return false;

    const dados = valor.substring(separador + 8);
    if (dados.length === 0) return false;
    // Alfabeto base64 estrito: sem aspas, sem espaço, sem '<' ou '>'.
    return /^[A-Za-z0-9+/]+={0,2}$/.test(dados);
}

// Imagem pura (foto de perfil, logo da associação)
function imagemBase64Valida(valor) {
    return dataUrlValido(valor, MIMES_IMAGEM);
}

// Comprovante: imagem ou PDF
function comprovanteBase64Valido(valor) {
    return dataUrlValido(valor, MIMES_IMAGEM.concat([MIME_PDF]));
}

// Política de senha forte: mínimo 8 caracteres, com ao menos uma maiúscula,
// uma minúscula e um número. Usada em toda troca de senha feita pelo próprio
// usuário (primeiro acesso obrigatório e troca voluntária).
function senhaForte(senha) {
    if (!senha || senha.length < 8) return false;
    if (!/[a-z]/.test(senha)) return false;
    if (!/[A-Z]/.test(senha)) return false;
    if (!/[0-9]/.test(senha)) return false;
    return true;
}

// Gera uma senha provisória aleatória que já satisfaz senhaForte(), usada nos
// fluxos automáticos (nova associação, novo associado, convite de diretoria).
// Evita caracteres ambíguos (I, l, 1, O, 0) porque a senha costuma ser
// repassada manualmente por quem criou a conta.
function gerarSenhaProvisoria() {
    const maiusculas = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const minusculas = 'abcdefghijkmnpqrstuvwxyz';
    const numeros = '23456789';
    const todos = maiusculas + minusculas + numeros;

    function aleatorio(alfabeto) {
        return alfabeto[crypto.randomInt(alfabeto.length)];
    }

    const senha = [aleatorio(maiusculas), aleatorio(minusculas), aleatorio(numeros)];
    for (let i = senha.length; i < 12; i++) {
        senha.push(aleatorio(todos));
    }

    for (let i = senha.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [senha[i], senha[j]] = [senha[j], senha[i]];
    }

    return senha.join('');
}

module.exports = {
    cpfValido,
    emailValido,
    nomeValido,
    sanitizarCelulaExcel,
    senhaForte,
    gerarSenhaProvisoria,
    imagemBase64Valida,
    comprovanteBase64Valido,
};
