// middleware/monitoring.js - Sistema de Monitoramento e Observabilidade

import { conversationStateManager, cacheManager } from '../services/cacheService.js';
import { checkHealth as checkDbHealth } from '../config/database.js';
import whatsappService from '../services/whatsappService.js';

// ✅ Métricas em memória (idealmente usar Prometheus)
class MetricsCollector {
    constructor() {
        this.metrics = {
            requestsTotal: 0,
            requestsSuccess: 0,
            requestsError: 0,
            responseTimeMs: [],
            activeConnections: 0,
            messagesProcessed: 0,
            messagesForwarded: 0,
            cachehits: 0,
            cacheMisses: 0
        };

        // ✅ Limitar tamanho do array de tempos de resposta
        this.maxResponseTimes = 1000;
    }

    recordRequest(success, responseTime) {
        this.metrics.requestsTotal++;

        if (success) {
            this.metrics.requestsSuccess++;
        } else {
            this.metrics.requestsError++;
        }

        this.metrics.responseTimeMs.push(responseTime);

        // ✅ Limitar memória
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
    }
}

export const metricsCollector = new MetricsCollector();

// ✅ Middleware de request logging e timing
export const requestLogger = (req, res, next) => {
    const startTime = Date.now();

    // ✅ Log apenas requisições importantes
    const shouldLog = !req.path.includes('/health') && !req.path.includes('/metrics');

    if (shouldLog) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }

    // ✅ Capturar resposta
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

// ✅ Middleware de error handling global
export const errorHandler = (err, req, res, next) => {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err);

    // ✅ Não expor detalhes internos em produção
    const isDev = process.env.NODE_ENV === 'development';

    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        path: req.path,
        timestamp: new Date().toISOString(),
        ...(isDev && { stack: err.stack })
    });
};

// ✅ Health check detalhado
export const getDetailedHealth = async () => {
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
    const memoryHealth = {
        heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        external: `${(memUsage.external / 1024 / 1024).toFixed(2)} MB`,
        heapUtilization: `${((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(2)}%`
    };

    // ✅ Determinar status geral
    let overallStatus = 'healthy';
    const issues = [];

    if (dbHealth.status !== 'healthy') {
        overallStatus = 'degraded';
        issues.push('Database connection issues');
    }

    if (memUsage.heapUsed / memUsage.heapTotal > 0.9) {
        overallStatus = 'degraded';
        issues.push('High memory usage (>90%)');
    }

    if (stateStats.utilizationPercent > 80) {
        overallStatus = 'degraded';
        issues.push(`Conversation state near limit (${stateStats.utilizationPercent}%)`);
    }

    if (sessionsHealth.open === 0 && sessionsHealth.total > 0) {
        overallStatus = 'degraded';
        issues.push('No active sessions despite configuration');
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
};

// ✅ Middleware de circuit breaker simples
export class CircuitBreaker {
    constructor(name, threshold = 5, timeout = 60000) {
        this.name = name;
        this.threshold = threshold;
        this.timeout = timeout;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.timeout) {
                this.state = 'HALF_OPEN';
                console.log(`[CircuitBreaker:${this.name}] Entering HALF_OPEN state`);
            } else {
                throw new Error(`Circuit breaker ${this.name} is OPEN`);
            }
        }

        try {
            const result = await fn();

            if (this.state === 'HALF_OPEN') {
                this.state = 'CLOSED';
                this.failureCount = 0;
                console.log(`[CircuitBreaker:${this.name}] Recovered, now CLOSED`);
            }

            return result;
        } catch (error) {
            this.failureCount++;
            this.lastFailureTime = Date.now();

            if (this.failureCount >= this.threshold) {
                this.state = 'OPEN';
                console.error(`[CircuitBreaker:${this.name}] Opened after ${this.failureCount} failures`);
            }

            throw error;
        }
    }

    getState() {
        return {
            name: this.name,
            state: this.state,
            failureCount: this.failureCount,
            lastFailureTime: this.lastFailureTime
        };
    }
}

// ✅ Monitoramento de recursos do sistema
export const startResourceMonitoring = () => {
    const MONITOR_INTERVAL = 30000; // 30 segundos
    const MEMORY_THRESHOLD = 0.85; // 85% da heap

    setInterval(() => {
        const memUsage = process.memoryUsage();
        const heapUtilization = memUsage.heapUsed / memUsage.heapTotal;

        if (heapUtilization > MEMORY_THRESHOLD) {
            console.warn(`[MONITOR] ⚠️ High memory usage: ${(heapUtilization * 100).toFixed(2)}%`);

            // ✅ Forçar garbage collection se disponível
            if (global.gc) {
                console.log('[MONITOR] Running manual garbage collection...');
                global.gc();
            }

            // ✅ Limpar estados antigos
            conversationStateManager.cleanup(true);
        }

        const stateStats = conversationStateManager.getStats();
        if (stateStats.utilizationPercent > 75) {
            console.warn(`[MONITOR] ⚠️ Conversation state utilization: ${stateStats.utilizationPercent}%`);
        }

    }, MONITOR_INTERVAL);
};