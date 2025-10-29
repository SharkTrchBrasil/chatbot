// services/cacheService.js - VERSÃO FINAL CORRIGIDA
import NodeCache from 'node-cache';

class SecureCacheManager {
    constructor() {
        this.cache = new NodeCache({
            stdTTL: 60,
            maxKeys: 500, // ⬇️ REDUZIDO de 1000
            checkperiod: 120, // ⬆️ AUMENTADO de 60
            useClones: false,
            deleteOnExpire: true
        });

        // ✅ REMOVIDO: Monitoramento de memória duplicado
        // O monitoring.js já faz isso
    }

    async get(namespace, key) {
        try {
            const fullKey = `${namespace}:${key}`;
            const value = this.cache.get(fullKey);

            if (value === undefined) {
                return { found: false, value: null };
            }

            return { found: true, value };
        } catch (error) {
            console.error('[CACHE] Get error:', error.message);
            return { found: false, value: null, error: error.message };
        }
    }

    async set(namespace, key, value, ttl = 60) {
        try {
            // ✅ VALIDAÇÃO DE TAMANHO RIGOROSA
            const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
            if (size > 512 * 1024) { // ⬇️ REDUZIDO: 512KB max (era 1MB)
                console.warn(`[CACHE] Object too large: ${(size / 1024).toFixed(2)}KB`);
                return false;
            }

            const fullKey = `${namespace}:${key}`;
            return this.cache.set(fullKey, value, ttl);
        } catch (error) {
            console.error('[CACHE] Set error:', error.message);
            return false;
        }
    }

    // ✅ NOVO: Método flush público
    flush() {
        const count = this.cache.keys().length;
        this.cache.flushAll();
        console.log(`[CACHE] ✅ Flushed ${count} keys`);
    }

    getStats() {
        const stats = this.cache.getStats();
        return {
            keys: stats.keys,
            hits: stats.hits,
            misses: stats.misses,
            hitRate: stats.hits > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) + '%' : '0%'
        };
    }

    close() {
        this.cache.close();
        console.log('[CACHE] ✅ Closed');
    }
}

export const cacheManager = new SecureCacheManager();