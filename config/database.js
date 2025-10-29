// config/database.js - Pool de Conexões Centralizado e Otimizado

import pg from 'pg';
const { Pool } = pg;

// ✅ Pool único para toda a aplicação
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },

    // ✅ SEGURANÇA: Limites de conexão
    max: 20, // Máximo de 20 conexões simultâneas
    min: 2, // Mínimo de 2 conexões sempre ativas

    // ✅ PERFORMANCE: Timeouts configurados
    idleTimeoutMillis: 30000, // Fecha conexões ociosas após 30s
    connectionTimeoutMillis: 5000, // Timeout de 5s para nova conexão

    // ✅ ROBUSTEZ: Query timeout
    query_timeout: 10000, // Queries abortadas após 10s

    // ✅ OBSERVABILIDADE: Logging
    log: (msg) => {
        if (process.env.NODE_ENV !== 'production') {
            console.log('[DB Pool]', msg);
        }
    }
});

// ✅ Event handlers para monitoramento
pool.on('connect', (client) => {
    console.log('[DB Pool] New client connected');
});

pool.on('error', (err, client) => {
    console.error('[DB Pool] Unexpected error on idle client', err);
});

pool.on('remove', (client) => {
    console.log('[DB Pool] Client removed from pool');
});

// ✅ Função helper com retry automático
export const executeQuery = async (query, params = [], maxRetries = 3) => {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await pool.query(query, params);
            return res.rows.length ? res.rows[0] : null;
        } catch (err) {
            lastError = err;
            console.error(`[DB] Query failed (attempt ${attempt}/${maxRetries}):`, err.message);

            // ✅ Não fazer retry em erros de sintaxe
            if (err.code === '42601' || err.code === '42P01') {
                throw err;
            }

            // ✅ Exponential backoff
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
};

// ✅ Query múltiplas linhas com timeout
export const executeQueryMany = async (query, params = [], timeout = 10000) => {
    const client = await pool.connect();

    try {
        // ✅ Set query timeout no cliente
        await client.query(`SET statement_timeout = ${timeout}`);
        const res = await client.query(query, params);
        return res.rows;
    } catch (err) {
        console.error(`[DB] Multi-row query failed:`, err.message);
        return [];
    } finally {
        client.release();
    }
};

// ✅ Graceful shutdown
export const closePool = async () => {
    console.log('[DB Pool] Closing all connections...');
    await pool.end();
    console.log('[DB Pool] All connections closed.');
};

// ✅ Health check
export const checkHealth = async () => {
    try {
        const result = await pool.query('SELECT NOW()');
        return {
            status: 'healthy',
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount,
            timestamp: result.rows[0].now
        };
    } catch (err) {
        return {
            status: 'unhealthy',
            error: err.message
        };
    }
};

export default pool;