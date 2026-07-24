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

module.exports = { cpfValido, emailValido, senhaForte, gerarSenhaProvisoria };
