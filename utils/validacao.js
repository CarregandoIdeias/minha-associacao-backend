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
// ação no histórico de auditoria). Bloqueia caracteres de controle.
function nomeValido(nome) {
    if (!nome || typeof nome !== 'string') return false;
    const limpo = nome.trim();
    if (limpo.length < 1 || limpo.length > 120) return false;
    if (/[\x00-\x1F\x7F]/.test(limpo)) return false;
    return true;
}

// Valida campo de texto livre longo (observação do associado, etc.). Achado na
// auditoria de 07/08/2026: `observacao` não tinha validação NENHUMA e a coluna
// é `text` (sem teto) no Postgres -- dava pra gravar megabytes por associado, e
// o valor ia parar dentro de um atributo HTML no painel.
//
// Diferente de nomeValido(): permite \t, \n e \r (quebra de linha é legítima
// aqui) e aceita bem mais caracteres, mas continua barrando os demais
// caracteres de controle e impondo um teto de tamanho.
//
// NÃO bloqueia aspas de propósito -- são legítimas em texto livre ("o associado
// disse que não viria"). A defesa contra XSS é o escape correto na renderização
// (escapeHtml no painel, que desde 07/08/2026 escapa aspas também); esta função
// é a segunda camada, não a principal.
function textoLivreValido(valor, maxLength) {
    if (valor === null || valor === undefined || valor === '') return true; // campo opcional
    if (typeof valor !== 'string') return false;
    if (valor.length > (maxLength || 2000)) return false;
    // Barra controles, menos \t (09), \n (0A) e \r (0D).
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(valor)) return false;
    return true;
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
    textoLivreValido,
    senhaForte,
    gerarSenhaProvisoria,
    imagemBase64Valida,
    comprovanteBase64Valido,
};
