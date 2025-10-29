// services/cacheService.js - VERSÃO CORRIGIDA
import NodeCache from 'node-cache';

class SecureCacheManager {
    constructor() {
        this.cache = new NodeCache({
            stdTTL: 60,
            maxKeys: 1000, // ✅ LIMITE RÍGIDO
            checkperiod: 60,
            useClones: false,
            deleteOnExpire: true
        });

        // ✅ MONITORAMENTO DE MEMÓRIA
        this.memoryThreshold = 0.85; // 85%
        this.startMemoryMonitoring();
    }

    startMemoryMonitoring() {
        setInterval(() => {
            const usage = process.memoryUsage();
            const heapUsage = usage.heapUsed / usage.heapTotal;

            if (heapUsage > this.memoryThreshold) {
                console.warn('🔄 High memory usage, clearing cache...');
                this.cache.flushAll();
                if (global.gc) global.gc();
            }
        }, 30000);
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
            console.error('Cache get error:', error);
            return { found: false, value: null, error: error.message };
        }
    }

    async set(namespace, key, value, ttl = 60) {
        try {
            // ✅ VALIDAÇÃO DE TAMANHO
            const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
            if (size > 1024 * 1024) { // 1MB max
                console.warn('Object too large for cache:', size);
                return false;
            }

            const fullKey = `${namespace}:${key}`;
            return this.cache.set(fullKey, value, ttl);
        } catch (error) {
            console.error('Cache set error:', error);
            return false;
        }
    }

    getStats() {
        const stats = this.cache.getStats();
        return {
            keys: stats.keys,
            hits: stats.hits,
            misses: stats.misses,
            ksize: stats.ksize,
            vsize: stats.vsize,
            memoryUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`
        };
    }

    close() {
            this.cache.close();
            console.log('[CACHE] ✅ Cache fechado.');
        }
}

export const cacheManager = new SecureCacheManager();