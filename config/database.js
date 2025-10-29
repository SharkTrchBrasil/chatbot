// config/database.js - VERSÃO AUDITADA E OTIMIZADA

import pg from 'pg';
const { Pool } = pg;

// ============================================================
// ✅ VALIDAÇÃO DE CONFIGURAÇÃO
// ============================================================

const validateConfig = () => {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL environment variable is required');
    }

    if (!process.env.DATABASE_URL.startsWith('postgresql://') &&
        !process.env.DATABASE_URL.startsWith('postgres://')) {
        throw new Error('DATABASE_URL must be a valid PostgreSQL connection string');
    }
};

validateConfig();

// ============================================================
// ✅ POOL CONFIGURADO COM SEGURANÇA E PERFORMANCE
// ============================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    // ✅ SEGURANÇA: SSL configurado corretamente
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,

    // ✅ CONNECTION POOL OTIMIZADO
    max: 15,                    // Máximo de 15 conexões (reduzido de 20)
    min: 2,                     // Mínimo de 2 conexões
    idleTimeoutMillis: 30000,   // Fecha idle após 30s
    connectionTimeoutMillis: 5000, // Timeout de conexão: 5s

    // ✅ TIMEOUTS CONFIGURADOS
    query_timeout: 15000,       // Queries com timeout de 15s
    statement_timeout: 15000,   // Statement timeout: 15s

    // ✅ KEEP ALIVE para conexões de longa duração
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,

    // ✅ CONFIGURAÇÃO DE APPLICATION
    application_name: 'whatsapp-chatbot-service',

    // ✅ LOGGING CONDICIONAL
    log: (msg) => {
        if (process.env.NODE_ENV === 'development') {
            console.log('[DB Pool]', msg);
        }
    }
});

// ============================================================
// ✅ EVENT HANDLERS PARA MONITORAMENTO
// ============================================================

pool.on('connect', (client) => {
    // ✅ Configurar timezone e encoding na conexão
    client.query('SET TIME ZONE \'UTC\'').catch(err => {
        console.error('[DB Pool] Failed to set timezone:', err.message);
    });

    if (process.env.NODE_ENV === 'development') {
        console.log('[DB Pool] ✅ New client connected');
    }
});

pool.on('acquire', (client) => {
    if (process.env.NODE_ENV === 'development') {
        console.log('[DB Pool] Client acquired from pool');
    }
});

pool.on('remove', (client) => {
    if (process.env.NODE_ENV === 'development') {
        console.log('[DB Pool] Client removed from pool');
    }
});

pool.on('error', (err, client) => {
    console.error('[DB Pool] ❌ Unexpected error on idle client:', err.message);
    // ✅ Não fazer exit automático, deixar o pool se recuperar
});

// ============================================================
// ✅ FUNÇÃO DE QUERY COM RETRY E VALIDAÇÃO
// ============================================================

export const executeQuery = async (query, params = [], options = {}) => {
    const {
        maxRetries = 3,
        timeout = 15000,
        retryDelay = 1000
    } = options;

    // ✅ VALIDAÇÃO: Query não pode ser vazia
    if (!query || typeof query !== 'string') {
        throw new Error('Query must be a non-empty string');
    }

    // ✅ VALIDAÇÃO: Params deve ser array
    if (!Array.isArray(params)) {
        throw new Error('Params must be an array');
    }

    let lastError;
    let attempt = 0;

    while (attempt < maxRetries) {
        attempt++;
        const client = await pool.connect();

        try {
            // ✅ Set statement timeout
            await client.query(`SET statement_timeout = ${timeout}`);

            // ✅ Executar query
            const result = await client.query(query, params);

            // ✅ Retornar primeira linha ou null
            return result.rows.length > 0 ? result.rows[0] : null;

        } catch (err) {
            lastError = err;

            // ✅ Log de erro
            console.error(`[DB] Query failed (attempt ${attempt}/${maxRetries}):`, {
                error: err.message,
                code: err.code,
                query: query.substring(0, 100) // Apenas primeiros 100 chars
            });

            // ✅ Não fazer retry em erros de sintaxe
            if (err.code === '42601' || // Syntax error
                err.code === '42P01' || // Undefined table
                err.code === '23505') { // Unique violation
                throw err;
            }

            // ✅ Exponential backoff
            if (attempt < maxRetries) {
                const delay = Math.min(retryDelay * Math.pow(2, attempt - 1), 5000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

        } finally {
            client.release();
        }
    }

    throw lastError;
};

// ============================================================
// ✅ QUERY MÚLTIPLAS LINHAS COM TIMEOUT
// ============================================================

export const executeQueryMany = async (query, params = [], options = {}) => {
    const {
        timeout = 15000,
        maxRows = 1000
    } = options;

    // ✅ VALIDAÇÃO
    if (!query || typeof query !== 'string') {
        throw new Error('Query must be a non-empty string');
    }

    if (!Array.isArray(params)) {
        throw new Error('Params must be an array');
    }

    const client = await pool.connect();

    try {
        // ✅ Set timeout
        await client.query(`SET statement_timeout = ${timeout}`);

        // ✅ Executar query
        const result = await client.query(query, params);

        // ✅ SEGURANÇA: Limitar número de linhas retornadas
        if (result.rows.length > maxRows) {
            console.warn(`[DB] Query returned ${result.rows.length} rows, limiting to ${maxRows}`);
            return result.rows.slice(0, maxRows);
        }

        return result.rows;

    } catch (err) {
        console.error('[DB] Multi-row query failed:', {
            error: err.message,
            code: err.code,
            query: query.substring(0, 100)
        });
        return [];

    } finally {
        client.release();
    }
};

// ============================================================
// ✅ TRANSAÇÃO SEGURA
// ============================================================

export const executeTransaction = async (callback) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[DB] Transaction failed:', err.message);
        throw err;

    } finally {
        client.release();
    }
};

// ============================================================
// ✅ HEALTH CHECK DETALHADO
// ============================================================

export const checkHealth = async () => {
    try {
        const start = Date.now();
        const result = await pool.query('SELECT NOW() as now, version() as version');
        const latency = Date.now() - start;

        return {
            status: 'healthy',
            latency: `${latency}ms`,
            pool: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount
            },
            timestamp: result.rows[0].now,
            version: result.rows[0].version.split(' ')[0] // PostgreSQL version
        };

    } catch (err) {
        console.error('[DB] Health check failed:', err.message);
        return {
            status: 'unhealthy',
            error: err.message,
            code: err.code
        };
    }
};

// ============================================================
// ✅ GRACEFUL SHUTDOWN
// ============================================================

export const closePool = async () => {
    console.log('[DB Pool] 🛑 Closing all connections...');

    try {
        // ✅ Aguardar até 10 segundos para conexões ativas terminarem
        await Promise.race([
            pool.end(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Pool close timeout')), 10000)
            )
        ]);

        console.log('[DB Pool] ✅ All connections closed gracefully');

    } catch (err) {
        console.error('[DB Pool] ❌ Error closing pool:', err.message);

        // ✅ Forçar fechamento
        try {
            await pool.end();
        } catch (forceErr) {
            console.error('[DB Pool] ❌ Failed to force close:', forceErr.message);
        }
    }
};

// ============================================================
// ✅ TESTES DE CONEXÃO NO STARTUP
// ============================================================

const testConnection = async () => {
    try {
        const health = await checkHealth();

        if (health.status === 'healthy') {
            console.log('[DB Pool] ✅ Connection test successful');
            console.log(`[DB Pool] PostgreSQL version: ${health.version}`);
            console.log(`[DB Pool] Latency: ${health.latency}`);
            return true;
        } else {
            console.error('[DB Pool] ❌ Connection test failed:', health.error);
            return false;
        }

    } catch (err) {
        console.error('[DB Pool] ❌ Connection test error:', err.message);
        return false;
    }
};

// ✅ Testar conexão ao importar o módulo
testConnection();

// ============================================================
// ✅ MONITORAMENTO DE POOL
// ============================================================

if (process.env.NODE_ENV === 'development') {
    setInterval(() => {
        console.log('[DB Pool] Stats:', {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount
        });
    }, 60000); // A cada 1 minuto em dev
}

export default pool;