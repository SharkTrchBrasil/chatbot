// middleware/monitoring.js - VERSÃO FINAL CORRIGIDA

import { cacheManager } from '../services/cacheService.js';

class SafeMetricsCollector {
    constructor() {
        this.metrics = {
            requestsTotal: 0,
            requestsSuccess: 0,
            requestsError: 0,
            messagesProcessed: 0,
            cacheHits: 0,
            cacheMisses: 0,
            dlqSaved: 0,
            dlqReprocessed: 0,
            dlqRetriesFailed: 0,
            dlqSize: 0
        };
        this.maxHistory = 100;
        this.responseTimes = [];
        this.startTime = Date.now();
    }

    recordRequest(success, responseTime) {
        this.metrics.requestsTotal++;
        if (success) {
            this.metrics.requestsSuccess++;
        } else {
            this.metrics.requestsError++;
        }

        this.responseTimes.push(responseTime);
        if (this.responseTimes.length > this.maxHistory) {
            this.responseTimes.shift();
        }
    }

    recordMessage() {
        this.metrics.messagesProcessed++;
    }

    recordCacheHit() {
        this.metrics.cacheHits++;
    }

    recordCacheMiss() {
        this.metrics.cacheMisses++;
    }

    getStats() {
        const avgResponseTime = this.responseTimes.length > 0
            ? (this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length).toFixed(2)
            : 0;

        return {
            ...this.metrics,
            avgResponseTime: `${avgResponseTime}ms`,
            uptime: `${Math.floor((Date.now() - this.startTime) / 1000)}s`,
            successRate: this.metrics.requestsTotal > 0
                ? `${((this.metrics.requestsSuccess / this.metrics.requestsTotal) * 100).toFixed(1)}%`
                : '0%'
        };
    }
}

export const metricsCollector = new SafeMetricsCollector();

// DLQ helpers
export const recordDlqSaved = () => { metricsCollector.metrics.dlqSaved++; };
export const recordDlqReprocessed = () => { metricsCollector.metrics.dlqReprocessed++; };
export const recordDlqRetryFailed = () => { metricsCollector.metrics.dlqRetriesFailed++; };
export const setDlqSize = (n) => { metricsCollector.metrics.dlqSize = n; };

// ✅ CORRIGIDO: Monitoramento otimizado e sem duplicação
export const startResourceMonitoring = () => {
    const MONITOR_INTERVAL = 120000; // 2 minutos
    const MEMORY_THRESHOLD = 0.85;
    const CRITICAL_THRESHOLD = 0.92;

    let lastCleanup = 0;
    let consecutiveHighMemory = 0;

    const monitor = setInterval(() => {
        const memUsage = process.memoryUsage();
        const heapUtilization = memUsage.heapUsed / memUsage.heapTotal;
        const now = Date.now();

        // ✅ LOG CONDICIONAL
        if (heapUtilization > MEMORY_THRESHOLD) {
            console.warn(`⚠️ Memory: ${(heapUtilization * 100).toFixed(1)}% | Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB`);
        }

        // ✅ CLEANUP INTELIGENTE
        if (heapUtilization > MEMORY_THRESHOLD) {
            consecutiveHighMemory++;

            if (consecutiveHighMemory >= 2 && (now - lastCleanup) > 120000) {
                console.log('🔄 Cleaning cache...');
                cacheManager.flush();
                lastCleanup = now;
                consecutiveHighMemory = 0;

                // ✅ GC FORÇADO se crítico
                if (global.gc && heapUtilization > CRITICAL_THRESHOLD) {
                    console.log('🔧 Running GC...');
                    global.gc();
                }
            }
        } else {
            consecutiveHighMemory = 0;
        }
    }, MONITOR_INTERVAL);

    // ✅ NOVA: Limpeza agressiva a cada 10 minutos
    const aggressiveCleanup = setInterval(() => {
        const memUsage = process.memoryUsage();
        const heapUtilization = memUsage.heapUsed / memUsage.heapTotal;

        if (heapUtilization > 0.80) {
            console.log('🧹 Aggressive cleanup...');
            cacheManager.flush();

            if (global.gc) {
                global.gc();
                console.log('✅ GC completed');
            }
        }
    }, 600000); // 10 minutos

    // ✅ Limpar intervals no shutdown
    const cleanup = () => {
        clearInterval(monitor);
        clearInterval(aggressiveCleanup);
    };

    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    console.log(`[MONITOR] ✅ Started (${MONITOR_INTERVAL / 1000}s interval, ${(MEMORY_THRESHOLD * 100)}% threshold)`);
};