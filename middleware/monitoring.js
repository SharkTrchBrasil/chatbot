// middleware/monitoring.js - CORRIGIDO PARA MEMORY LEAK

import { conversationStateManager, cacheManager } from '../services/cacheService.js';
import { checkHealth as checkDbHealth } from '../config/database.js';
import whatsappService from '../services/whatsappService.js';

// ============================================================
// 📊 MÉTRICAS (em memória, com LIMITE)
// ============================================================

class MetricsCollector {
    constructor() {
        this.metrics = {
            requestsTotal: 0,
            requestsSuccess: 0,
            requestsError: 0,
            responseTimeMs: [],
            messagesProcessed: 0,
            messagesForwarded: 0,
            cachehits: 0,
            cacheMisses: 0
        };

        // ✅ CRÍTICO: Limitar drasticamente o tamanho
        this.maxResponseTimes = 100; // ⬇️ 1000 → 100
        this.maxMetricsRetention = 30 * 60 * 1000; // 30 min
        this.metricsStartTime = Date.now();

        // ✅ NOVO: Cleanup automático de métricas antigas
        setInterval(() => this._cleanupOldMetrics(), 5 * 60 * 1000);
    }

    _cleanupOldMetrics() {
        // ✅ Resetar métricas a cada 30 min para não acumular
        const elapsed = Date.now() - this.metricsStartTime;

        if (elapsed > this.maxMetricsRetention) {
            console.log('[Metrics] 🔄 Resetting old metrics...');
            this.metrics.responseTimeMs = [];
            this.metricsStartTime = Date.now();
        }
    }

    recordRequest(success, responseTime) {
        this.metrics.requestsTotal++;

        if (success) {
            this.metrics.requestsSuccess++;
        } else {
            this.metrics.requestsError++;
        }

        // ✅ Adicionar e remover se exceder limite
        this.metrics.responseTimeMs.push(responseTime);
        if (this.metrics.responseTimeMs.length > this.maxResponseTimes) {
            this.metrics.responseTimeMs.shift();
        }
    }

    recordMessage(forwarded = false) {
        this.metrics.messagesProcessed++;
        if (forwarded) {
            this.metrics.messagesForwarded++;
        }
    }

    recordCacheHit(isHit) {
        if (isHit) {
            this.metrics.cachehits++;
        } else {
            this.metrics.cacheMisses++;
        }
    }

    getStats() {
        const responseTimes = this.metrics.responseTimeMs;
        const sorted = [...responseTimes].sort((a, b) => a - b);

        return {
            requests: {
                total: this.metrics.requestsTotal,
                success: this.metrics.requestsSuccess,
                errors: this.metrics.requestsError,
                errorRate: this.metrics.requestsTotal > 0
                    ? ((this.metrics.requestsError / this.metrics.requestsTotal) * 100).toFixed(2) + '%'
                    : '0%'
            },
            responseTime: {
                avg: responseTimes.length > 0
                    ? (responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length).toFixed(2)
                    : 0,
                p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
                p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
                p99: sorted[Math.floor(sorted.length * 0.99)] || 0,
                max: sorted[sorted.length - 1] || 0
            },
            messages: {
                processed: this.metrics.messagesProcessed,
                forwarded: this.metrics.messagesForwarded,
                forwardRate: this.metrics.messagesProcessed > 0
                    ? ((this.metrics.messagesForwarded / this.metrics.messagesProcessed) * 100).toFixed(2) + '%'
                    : '0%'
            },
            cache: {
                hits: this.metrics.cachehits,
                misses: this.metrics.cacheMisses,
                hitRate: (this.metrics.cachehits + this.metrics.cacheMisses) > 0
                    ? ((this.metrics.cachehits / (this.metrics.cachehits + this.metrics.cacheMisses)) * 100).toFixed(2) + '%'
                    : '0%'
            }
        };
    }

    // ✅ NOVO: Reset manual se necessário
    reset() {
        this.metrics = {
            requestsTotal: 0,
            requestsSuccess: 0,
            requestsError: 0,
            responseTimeMs: [],
            messagesProcessed: 0,
            messagesForwarded: 0,
            cachehits: 0,
            cacheMisses: 0
        };
        this.metricsStartTime = Date.now();
    }
}

export const metricsCollector = new MetricsCollector();

// ============================================================
// 📝 REQUEST LOGGING (com limite)
// ============================================================

const requestLogBuffer = [];
const MAX_LOG_BUFFER = 100; // ✅ Buffer limitado

export const requestLogger = (req, res, next) => {
    const startTime = Date.now();
    const shouldLog = !req.path.includes('/health') && !req.path.includes('/metrics');

    if (shouldLog && requestLogBuffer.length < MAX_LOG_BUFFER) {
        requestLogBuffer.push({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.path
        });
    }

    // ✅ Limitar buffer
    if (requestLogBuffer.length > MAX_LOG_BUFFER) {
        requestLogBuffer.shift();
    }

    if (shouldLog) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }

    const originalSend = res.send;
    res.send = function(data) {
        const responseTime = Date.now() - startTime;
        const success = res.statusCode < 400;

        metricsCollector.recordRequest(success, responseTime);

        if (shouldLog && responseTime > 1000) {
            console.warn(`[SLOW REQUEST] ${req.method} ${req.path} took ${responseTime}ms`);
        }

        return originalSend.call(this, data);
    };

    next();
};

// ============================================================
// ❌ ERROR HANDLER
// ============================================================

export const errorHandler = (err, req, res, next) => {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

    const isDev = process.env.NODE_ENV === 'development';

    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        path: req.path,
        timestamp: new Date().toISOString(),
        ...(isDev && { stack: err.stack })
    });
};

// ============================================================
// 💊 HEALTH CHECK DETALHADO (com proteção de memory)
// ============================================================

export const getDetailedHealth = async () => {
    try {
        const dbHealth = await checkDbHealth();
        const cacheStats = cacheManager.getStats();
        const stateStats = conversationStateManager.getStats();

        const sessions = Array.from(whatsappService.activeSessions.values());
        const sessionsHealth = {
            total: sessions.length,
            open: sessions.filter(s => s.status === 'open').length,
            connecting: sessions.filter(s => s.status === 'connecting').length,
            active: sessions.filter(s => s.isActive).length
        };

        const memUsage = process.memoryUsage();
        const heapUtilization = (memUsage.heapUsed / memUsage.heapTotal) * 100;

        const memoryHealth = {
            heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
            heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
            rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
            external: `${(memUsage.external / 1024 / 1024).toFixed(2)} MB`,
            heapUtilization: `${heapUtilization.toFixed(2)}%`
        };

        // ✅ Determinar status geral
        let overallStatus = 'healthy';
        const issues = [];

        if (dbHealth.status !== 'healthy') {
            overallStatus = 'degraded';
            issues.push('Database connection issues');
        }

        // ✅ CRÍTICO: Alertar se heap > 80% (not 90%)
        if (heapUtilization > 80) {
            overallStatus = 'degraded';
            issues.push(`High memory usage (${heapUtilization.toFixed(2)}%)`);

            // ✅ FORÇAR cleanup imediato
            console.warn('[HEALTH] 🚨 CRITICAL: Forcing emergency cleanup');
            conversationStateManager.cleanup(true);
            cacheManager.flush();
            if (global.gc) {
                global.gc();
                console.log('[HEALTH] ✅ Emergency GC executed');
            }
        }

        if (stateStats.utilizationPercent > 70) {
            overallStatus = 'degraded';
            issues.push(`Conversation state near limit (${stateStats.utilizationPercent}%)`);
        }

        if (sessionsHealth.open === 0 && sessionsHealth.total > 0) {
            overallStatus = 'degraded';
            issues.push('No active sessions');
        }

        return {
            status: overallStatus,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            issues: issues.length > 0 ? issues : null,
            components: {
                database: dbHealth,
                cache: cacheStats,
                conversationState: stateStats,
                sessions: sessionsHealth,
                memory: memoryHealth,
                metrics: metricsCollector.getStats()
            }
        };
    } catch (err) {
        console.error('[HEALTH] Error:', err.message);
        return {
            status: 'error',
            error: err.message
        };
    }
};

// ============================================================
// ⚡ RESOURCE MONITORING - AGRESSIVO
// ============================================================

export const startResourceMonitoring = () => {
    const MONITOR_INTERVAL = 10000; // ⬇️ 30s → 10s (mais frequente)
    const MEMORY_THRESHOLD = 0.80; // ⬇️ 85% → 80%
    const GC_THRESHOLD = 0.90; // ✅ NOVO: Trigger GC se > 90%

    let consecutiveHighMemory = 0;

    setInterval(() => {
        const memUsage = process.memoryUsage();
        const heapUtilization = memUsage.heapUsed / memUsage.heapTotal;

        // ✅ Alerta se alta
        if (heapUtilization > MEMORY_THRESHOLD) {
            consecutiveHighMemory++;
            console.warn(`[MONITOR] ⚠️ High memory: ${(heapUtilization * 100).toFixed(2)}% (${consecutiveHighMemory}x)`);

            // ✅ Ações escalonadas
            if (consecutiveHighMemory >= 3) {
                console.warn('[MONITOR] 🚨 Memory crisis! Executing emergency cleanup...');

                // 1. Limpar estados
                conversationStateManager.cleanup(true);

                // 2. Limpar cache
                cacheManager.flush();

                // 3. Reset métricas
                metricsCollector.reset();

                // 4. Forçar GC
                if (global.gc) {
                    global.gc();
                    console.log('[MONITOR] ✅ Emergency GC executed');
                }

                consecutiveHighMemory = 0;
            }
        } else if (consecutiveHighMemory > 0) {
            consecutiveHighMemory--;
        }

        // ✅ Forçar GC se > 90%
        if (heapUtilization > GC_THRESHOLD) {
            if (global.gc) {
                console.log('[MONITOR] 🧹 Force GC (heap > 90%)');
                global.gc();
            }
        }

        // ✅ Monitorar estados
        const stateStats = conversationStateManager.getStats();
        if (stateStats.utilizationPercent > 60) {
            console.warn(`[MONITOR] ⚠️ States: ${stateStats.utilizationPercent}%`);
        }

    }, MONITOR_INTERVAL);

    console.log(`[MONITOR] ✅ Started (interval: ${MONITOR_INTERVAL}ms, threshold: ${(MEMORY_THRESHOLD * 100).toFixed(0)}%)`);
};

// ============================================================
// 🔌 CIRCUIT BREAKER (Simples)
// ============================================================

export class CircuitBreaker {
    constructor(name, threshold = 5, timeout = 60000) {
        this.name = name;
        this.threshold = threshold;
        this.timeout = timeout;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED';
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.timeout) {
                this.state = 'HALF_OPEN';
                console.log(`[CircuitBreaker:${this.name}] HALF_OPEN`);
            } else {
                throw new Error(`Circuit breaker ${this.name} is OPEN`);
            }
        }

        try {
            const result = await fn();

            if (this.state === 'HALF_OPEN') {
                this.state = 'CLOSED';
                this.failureCount = 0;
                console.log(`[CircuitBreaker:${this.name}] Recovered`);
            }

            return result;
        } catch (error) {
            this.failureCount++;
            this.lastFailureTime = Date.now();

            if (this.failureCount >= this.threshold) {
                this.state = 'OPEN';
                console.error(`[CircuitBreaker:${this.name}] OPEN`);
            }

            throw error;
        }
    }

    getState() {
        return {
            name: this.name,
            state: this.state,
            failureCount: this.failureCount
        };
    }
}