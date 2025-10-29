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
            cacheMisses: 0
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

// ✅ CORRIGIDO: Monitoramento otimizado e sem duplicação
export const startResourceMonitoring = () => {
    const MONITOR_INTERVAL = 120000; // ⬆️ 2 minutos (reduz overhead)
    const MEMORY_THRESHOLD = 0.85;
    const CRITICAL_THRESHOLD = 0.92;

    let lastCleanup = 0;
    let consecutiveHighMemory = 0;

    const monitor = setInterval(() => {
        const memUsage = process.memoryUsage();
        const heapUtilization = memUsage.heapUsed / memUsage.heapTotal;
        const now = Date.now();

        // ✅ LOG CONDICIONAL (não polui logs)
        if (heapUtilization > MEMORY_THRESHOLD) {
            console.warn(`⚠️ Memory: ${(heapUtilization * 100).toFixed(1)}% | Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB`);
        }

        // ✅ CLEANUP INTELIGENTE (não excessivo)
        if (heapUtilization > MEMORY_THRESHOLD) {
            consecutiveHighMemory++;

            // Só limpa se:
            // 1. Memória alta por 2 ciclos consecutivos
            // 2. Passou pelo menos 2 minutos desde último cleanup
            if (consecutiveHighMemory >= 2 && (now - lastCleanup) > 120000) {
                console.log('🔄 Cleaning cache...');
                cacheManager.flush();
                lastCleanup = now;
                consecutiveHighMemory = 0;

                // ✅ GC FORÇADO apenas se crítico
                if (global.gc && heapUtilization > CRITICAL_THRESHOLD) {
                    console.log('🔧 Running GC...');
                    global.gc();
                }
            }
        } else {
            // Reset contador quando memória normaliza
            consecutiveHighMemory = 0;
        }
    }, MONITOR_INTERVAL);

    // ✅ IMPORTANTE: Limpar interval no shutdown
    process.on('SIGTERM', () => clearInterval(monitor));
    process.on('SIGINT', () => clearInterval(monitor));

    console.log(`[MONITOR] ✅ Started (${MONITOR_INTERVAL / 1000}s interval, ${(MEMORY_THRESHOLD * 100)}% threshold)`);
};