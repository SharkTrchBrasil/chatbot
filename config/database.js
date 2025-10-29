// config/database.js - VERSÃO OTIMIZADA FINAL

import pg from 'pg';
const { Pool } = pg;

// ✅ VALIDAÇÃO
const validateConfig = () => {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL environment variable is required');
    }
};

validateConfig();

// ✅ POOL OTIMIZADO PARA PRODUÇÃO
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,

    // ✅ OTIMIZADO: Configurações conservadoras
    max: 10, // ⬇️ REDUZIDO de 15
    min: 1, // ⬇️ REDUZIDO de 2
    idleTimeoutMillis: 60000, // ⬆️ AUMENTADO de 30s para 60s
    connectionTimeoutMillis: 5000,
    query_timeout: 10000, // ⬇️ REDUZIDO de 15s para 10s
    statement_timeout: 10000,

    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    application_name: 'whatsapp-chatbot-service'
});

// ✅ EVENT HANDLERS SILENCIOSOS EM PRODUÇÃO
pool.on('connect', (client) => {
    client.query('SET TIME ZONE \'UTC\'').catch(() => {});
});

pool.on('error', (err) => {
    console.error('[DB Pool] ❌ Error:', err.message);
});

// ✅ QUERY ÚNICA COM VALIDAÇÃO
export const executeQuery = async (query, params = []) => {
    if (!query || typeof query !== 'string') {
        throw new Error('Query must be a non-empty string');
    }

    if (!Array.isArray(params)) {
        throw new Error('Params must be an array');
    }

    const client = await pool.connect();
    try {
        const result = await client.query(query, params);
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (err) {
        console.error('[DB] Query error:', err.message);
        throw err;
    } finally {
        client.release();
    }
};

// ✅ QUERY MÚLTIPLAS LINHAS
export const executeQueryMany = async (query, params = []) => {
    if (!query || typeof query !== 'string') {
        throw new Error('Query must be a non-empty string');
    }

    const client = await pool.connect();
    try {
        const result = await client.query(query, params);
        return result.rows;
    } catch (err) {
        console.error('[DB] Query error:', err.message);
        return [];
    } finally {
        client.release();
    }
};

// ✅ TRANSAÇÃO
export const executeTransaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

// ✅ HEALTH CHECK
export const checkHealth = async () => {
    try {
        const start = Date.now();
        const result = await pool.query('SELECT NOW() as now');
        const latency = Date.now() - start;

        return {
            status: 'healthy',
            latency: `${latency}ms`,
            pool: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount
            }
        };
    } catch (err) {
        return {
            status: 'unhealthy',
            error: err.message
        };
    }
};

// ✅ GRACEFUL SHUTDOWN
export const closePool = async () => {
    console.log('[DB Pool] 🛑 Closing...');
    try {
        await Promise.race([
            pool.end(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 10000)
            )
        ]);
        console.log('[DB Pool] ✅ Closed');
    } catch (err) {
        console.error('[DB Pool] ❌ Error closing:', err.message);
    }
};

// ✅ TESTE INICIAL
(async () => {
    try {
        const health = await checkHealth();
        if (health.status === 'healthy') {
            console.log(`[DB Pool] ✅ Connected (${health.latency})`);
        } else {
            console.error('[DB Pool] ❌ Unhealthy:', health.error);
        }
    } catch (err) {
        console.error('[DB Pool] ❌ Connection failed:', err.message);
    }
})();

export default pool;