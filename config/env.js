const isProduction = process.env.NODE_ENV === 'production';

function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`A variável de ambiente ${name} é obrigatória.`);
    }
    return value;
}

const defaultLocalOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
];

const origins = (process.env.CORS_ORIGINS || (isProduction ? '' : defaultLocalOrigins.join(',')))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

if (isProduction && origins.length === 0) {
    throw new Error('A variável CORS_ORIGINS é obrigatória em produção.');
}

module.exports = {
    isProduction,
    port: Number(process.env.PORT) || 3000,
    databaseUrl: isProduction ? required('DATABASE_URL') : process.env.DATABASE_URL,
    jwtSecret: isProduction ? required('JWT_SECRET') : (process.env.JWT_SECRET || 'somente-desenvolvimento-nao-use-em-producao'),
    corsOrigins: origins,
};
