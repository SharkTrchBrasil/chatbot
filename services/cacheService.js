// services/cacheService.js - VERSÃO CORRIGIDA COM MÉTODO DELETE
import NodeCache from 'node-cache';

class SecureCacheManager {
    constructor() {
        this.cache = new NodeCache({
            stdTTL: 60,
            maxKeys: 500,
            checkperiod: 120,
            useClones: false,
            deleteOnExpire: true
        });
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
            const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
            if (size > 512 * 1024) {
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

    // ✅ NOVO: Método delete
    async delete(namespace, key) {
        try {
            const fullKey = `${namespace}:${key}`;
            const deleted = this.cache.del(fullKey);

            if (deleted > 0) {
                console.log(`[CACHE] ✅ Deleted key: ${fullKey}`);
                return true;
            }
            return false;
        } catch (error) {
            console.error('[CACHE] Delete error:', error.message);
            return false;
        }
    }

    // ✅ NOVO: Deletar múltiplas chaves por padrão
    async deletePattern(namespace, pattern = '*') {
        try {
            const searchKey = `${namespace}:${pattern}`;
            const allKeys = this.cache.keys();
            const matchedKeys = allKeys.filter(key => {
                if (pattern === '*') {
                    return key.startsWith(`${namespace}:`);
                }
                // Suporte básico para wildcards
                const regex = new RegExp(searchKey.replace(/\*/g, '.*'));
                return regex.test(key);
            });

            if (matchedKeys.length > 0) {
                this.cache.del(matchedKeys);
                console.log(`[CACHE] ✅ Deleted ${matchedKeys.length} keys matching ${searchKey}`);
                return matchedKeys.length;
            }
            return 0;
        } catch (error) {
            console.error('[CACHE] Delete pattern error:', error.message);
            return 0;
        }
    }

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