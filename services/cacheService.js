// services/cacheService.js - CORRIGIDO (Memory Leak Removido)
import NodeCache from 'node-cache';

// ✅ CRÍTICO: Usar opciones mais agressivas para evitar memory leak
const inMemoryCache = new NodeCache({
    stdTTL: 60,        // ⬇️ REDUZIDO: 5min → 1min (era 300)
    checkperiod: 10,   // ⬇️ REDUZIDO: 60s → 10s (limpar mais frequente)
    maxKeys: 1000,     // ⬇️ REDUZIDO: 10k → 1k (menos dados em memória)
    useClones: false,
    deleteOnExpire: true // ✅ ADICIONADO: Deletar imediatamente ao expirar
});

// ✅ MONITORAR tamanho do cache
inMemoryCache.on('set', () => {
    const stats = inMemoryCache.getStats();
    if (stats.keys > 500) {
        console.warn(`[CACHE] ⚠️ Cache size: ${stats.keys} keys (threshold: 500)`);
    }
});

// ✅ GARBAGE COLLECTION manual se cache crescer demais
setInterval(() => {
    const stats = inMemoryCache.getStats();
    if (stats.keys > 800) {
        console.warn(`[CACHE] 🗑️ Forçando garbage collection. Keys: ${stats.keys}`);
        inMemoryCache.flushAll();
        if (global.gc) {
            global.gc();
            console.log('[CACHE] ✅ GC executado');
        }
    }
}, 30000);

// ============================================================
// ✅ MELHORADO: ConversationStateManager com limite rigoroso
// ============================================================

class ConversationStateManager {
    constructor() {
        this.states = new Map();
        this.maxStates = 100; // ⬇️ REDUZIDO: 5k → 100 (produção real)
        this.cleanupInterval = 5 * 60 * 1000; // ⬇️ REDUZIDO: 30min → 5min
        this.stateMaxAge = 10 * 60 * 1000; // ⬇️ NOVO: TTL de 10min para estados

        // ✅ Auto-cleanup AGRESSIVO
        setInterval(() => this.cleanup(), this.cleanupInterval);

        // ✅ NOVO: Monitor de tamanho
        setInterval(() => this._monitorSize(), 30000);
    }

    _monitorSize() {
        const stats = this.getStats();
        console.log(`[StateManager] Status: ${stats.total}/${stats.maxAllowed} states (${stats.utilizationPercent}%)`);

        if (stats.utilizationPercent > 70) {
            console.warn(`[StateManager] ⚠️ High utilization. Forcing cleanup...`);
            this.cleanup(true);
        }
    }

    get(chatId) {
        const state = this.states.get(chatId);

        // ✅ Validar se expirou
        if (state && Date.now() - state.lastActivity > this.stateMaxAge) {
            console.log(`[StateManager] Removendo estado expirado: ${chatId}`);
            this.states.delete(chatId);
            return null;
        }

        return state || null;
    }

    set(chatId, state) {
        // ✅ Limitar ANTES de adicionar
        if (this.states.size >= this.maxStates) {
            console.warn('[StateManager] 🗑️ Limit reached. Cleaning oldest 30%...');
            this.cleanup(true);
        }

        this.states.set(chatId, {
            ...state,
            lastActivity: Date.now(),
            createdAt: state.createdAt || Date.now()
        });
    }

    delete(chatId) {
        return this.states.delete(chatId);
    }

    cleanup(force = false) {
        const now = Date.now();
        const timeout = this.stateMaxAge;
        let cleaned = 0;
        let targetToClean = force ? Math.ceil(this.states.size * 0.3) : Infinity;

        for (const [chatId, state] of this.states.entries()) {
            if (cleaned >= targetToClean) break;

            const isExpired = (now - state.lastActivity) > timeout;

            if (isExpired) {
                this.states.delete(chatId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[StateManager] 🧹 Cleaned ${cleaned} expired states. Active: ${this.states.size}`);
        }

        return cleaned;
    }

    getStats() {
        return {
            total: this.states.size,
            maxAllowed: this.maxStates,
            utilizationPercent: ((this.states.size / this.maxStates) * 100).toFixed(2)
        };
    }

    // ✅ NOVO: Método para debug
    getDebugInfo() {
        const oldest = Array.from(this.states.values())
            .sort((a, b) => a.lastActivity - b.lastActivity)
            .slice(0, 5);

        return {
            totalSize: this.states.size,
            oldest: oldest.map(s => ({
                age: Date.now() - s.lastActivity,
                lastActivity: new Date(s.lastActivity).toISOString()
            }))
        };
    }
}

export const conversationStateManager = new ConversationStateManager();

// ============================================================
// ✅ MELHORADO: CacheManager com limite de memória
// ============================================================

class CacheManager {
    constructor() {
        this.cache = inMemoryCache;
        this.maxMemoryMB = 50; // ✅ NOVO: Limite de 50MB
    }

    _checkMemory() {
        const used = process.memoryUsage().heapUsed / 1024 / 1024;

        if (used > this.maxMemoryMB) {
            console.warn(`[Cache] 🚨 Memory limit exceeded: ${used.toFixed(2)}MB/${this.maxMemoryMB}MB`);
            this.flush();
            if (global.gc) {
                global.gc();
            }
            return false;
        }
        return true;
    }

    _key(namespace, key) {
        return `${namespace}:${key}`;
    }

    async get(namespace, key) {
        try {
            this._checkMemory();
            const fullKey = this._key(namespace, key);
            return this.cache.get(fullKey);
        } catch (err) {
            console.error(`[Cache] Get failed:`, err.message);
            return null;
        }
    }

    async set(namespace, key, value, ttl = 60) {
        try {
            // ✅ Validar antes de salvar
            if (!this._checkMemory()) {
                console.warn(`[Cache] Rejected set due to memory limit`);
                return false;
            }

            const fullKey = this._key(namespace, key);

            // ✅ Estimar tamanho do objeto
            const size = JSON.stringify(value).length / 1024; // KB
            if (size > 1024) { // > 1MB
                console.warn(`[Cache] Object too large: ${size.toFixed(2)}KB. Rejected.`);
                return false;
            }

            return this.cache.set(fullKey, value, ttl);
        } catch (err) {
            console.error(`[Cache] Set failed:`, err.message);
            return false;
        }
    }

    async del(namespace, key) {
        try {
            const fullKey = this._key(namespace, key);
            return this.cache.del(fullKey);
        } catch (err) {
            console.error(`[Cache] Delete failed:`, err.message);
            return 0;
        }
    }

    async flush(namespace = null) {
        try {
            if (namespace) {
                const keys = this.cache.keys();
                const namespaceKeys = keys.filter(k => k.startsWith(`${namespace}:`));
                const deleted = this.cache.del(namespaceKeys);
                console.log(`[Cache] Flushed ${deleted} keys from ${namespace}`);
                return deleted;
            } else {
                this.cache.flushAll();
                console.log('[Cache] 🗑️ All cache cleared');
                return this.cache.getStats().keys;
            }
        } catch (err) {
            console.error(`[Cache] Flush failed:`, err.message);
            return 0;
        }
    }

    async getOrSet(namespace, key, fetchFunction, ttl = 60) {
        try {
            const cached = await this.get(namespace, key);

            if (cached !== undefined && cached !== null) {
                return cached;
            }

            const value = await fetchFunction();

            if (value !== null && value !== undefined) {
                await this.set(namespace, key, value, ttl);
            }

            return value;
        } catch (err) {
            console.error(`[Cache] getOrSet failed:`, err.message);
            return null;
        }
    }

    getStats() {
        const stats = this.cache.getStats();
        const hitRate = stats.keys > 0
            ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2)
            : 0;

        return {
            keys: stats.keys,
            hits: stats.hits,
            misses: stats.misses,
            hitRate: `${hitRate}%`,
            memoryUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`
        };
    }
}

export const cacheManager = new CacheManager();

// ============================================================
// ✅ CONSTANTES OTIMIZADAS
// ============================================================

export const CACHE_TTL = {
    STORE_INFO: 300,        // ⬇️ 10min → 5min
    BUSINESS_HOURS: 120,    // ⬇️ 5min → 2min
    CUSTOM_MESSAGE: 120,    // ⬇️ 15min → 2min
    COUPONS: 60,           // ⬇️ 3min → 1min
    ORDER_STATUS: 15,      // ⬇️ 30s → 15s
};

export const CACHE_NS = {
    STORE: 'store',
    MESSAGE: 'message',
    ORDER: 'order',
    SESSION: 'session'
};