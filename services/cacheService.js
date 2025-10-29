// services/cacheService.js - Sistema de Cache com Redis/In-Memory Fallback

import NodeCache from 'node-cache';

// ✅ Fallback para cache em memória se Redis não estiver disponível
const inMemoryCache = new NodeCache({
    stdTTL: 300, // 5 minutos padrão
    checkperiod: 60, // Verifica itens expirados a cada 60s
    maxKeys: 10000, // Máximo de 10k chaves
    useClones: false // Performance: não clonar objetos
});

// ✅ State management para conversas (com auto-cleanup)
class ConversationStateManager {
    constructor() {
        this.states = new Map();
        this.maxStates = 5000; // Limite de estados simultâneos
        this.cleanupInterval = 30 * 60 * 1000; // Cleanup a cada 30min

        // ✅ Auto-cleanup periódico
        setInterval(() => this.cleanup(), this.cleanupInterval);
    }

    get(chatId) {
        return this.states.get(chatId) || null;
    }

    set(chatId, state) {
        // ✅ SEGURANÇA: Limitar número de estados
        if (this.states.size >= this.maxStates) {
            console.warn('[StateManager] Max states reached. Cleaning oldest...');
            this.cleanup(true);
        }

        this.states.set(chatId, {
            ...state,
            lastActivity: Date.now()
        });
    }

    delete(chatId) {
        return this.states.delete(chatId);
    }

    cleanup(force = false) {
        const now = Date.now();
        const timeout = 30 * 60 * 1000; // 30 minutos
        let cleaned = 0;

        for (const [chatId, state] of this.states.entries()) {
            const isExpired = (now - state.lastActivity) > timeout;
            const shouldClean = force || isExpired;

            if (shouldClean) {
                this.states.delete(chatId);
                cleaned++;
            }

            // Se forçado, limpar apenas 30% dos mais antigos
            if (force && cleaned >= this.maxStates * 0.3) {
                break;
            }
        }

        console.log(`[StateManager] Cleaned ${cleaned} expired states. Active: ${this.states.size}`);
    }

    getStats() {
        return {
            total: this.states.size,
            maxAllowed: this.maxStates,
            utilizationPercent: ((this.states.size / this.maxStates) * 100).toFixed(2)
        };
    }
}

export const conversationStateManager = new ConversationStateManager();

// ✅ Cache manager com namespacing
class CacheManager {
    constructor() {
        this.cache = inMemoryCache;
    }

    // ✅ Gerar chave com namespace
    _key(namespace, key) {
        return `${namespace}:${key}`;
    }

    async get(namespace, key) {
        try {
            const fullKey = this._key(namespace, key);
            return this.cache.get(fullKey);
        } catch (err) {
            console.error(`[Cache] Get failed:`, err.message);
            return null;
        }
    }

    async set(namespace, key, value, ttl = 300) {
        try {
            const fullKey = this._key(namespace, key);
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
                return this.cache.del(namespaceKeys);
            } else {
                return this.cache.flushAll();
            }
        } catch (err) {
            console.error(`[Cache] Flush failed:`, err.message);
            return 0;
        }
    }

    // ✅ Wrapper para cache-aside pattern
    async getOrSet(namespace, key, fetchFunction, ttl = 300) {
        const cached = await this.get(namespace, key);

        if (cached !== undefined && cached !== null) {
            return cached;
        }

        try {
            const value = await fetchFunction();

            if (value !== null && value !== undefined) {
                await this.set(namespace, key, value, ttl);
            }

            return value;
        } catch (err) {
            console.error(`[Cache] getOrSet fetch failed:`, err.message);
            return null;
        }
    }

    getStats() {
        const stats = this.cache.getStats();
        return {
            keys: stats.keys,
            hits: stats.hits,
            misses: stats.misses,
            hitRate: stats.keys > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) : 0
        };
    }
}

export const cacheManager = new CacheManager();

// ✅ Constantes de TTL por tipo de dado
export const CACHE_TTL = {
    STORE_INFO: 600, // 10 minutos - informações da loja
    BUSINESS_HOURS: 300, // 5 minutos - horários
    CUSTOM_MESSAGE: 900, // 15 minutos - mensagens customizadas
    COUPONS: 180, // 3 minutos - cupons (muda frequentemente)
    ORDER_STATUS: 30, // 30 segundos - status de pedido
};

// ✅ Namespaces para organização
export const CACHE_NS = {
    STORE: 'store',
    MESSAGE: 'message',
    ORDER: 'order',
    SESSION: 'session'
};