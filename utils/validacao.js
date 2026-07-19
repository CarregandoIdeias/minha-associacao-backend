// utils/validacao.js

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

module.exports = { cpfValido, emailValido };
