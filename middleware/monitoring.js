// middleware/monitoring.js - VERSÃO CORRIGIDA PARA PRODUÇÃO

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

    // ... (métodos existentes) ...
}

export const metricsCollector = new SafeMetricsCollector();

// ✅ CORREÇÃO: MONITORAMENTO OTIMIZADO PARA PRODUÇÃO
export const startResourceMonitoring = () => {
    const MONITOR_INTERVAL = 60000; // ⬆️ 1 minuto (era 10s)
    const MEMORY_THRESHOLD = 0.90; // ⬆️ 90% (era 80%)
    const GC_THRESHOLD = 0.95; // ⬆️ 95% (era 90%)

    let consecutiveHighMemory = 0;
    let lastCleanup = Date.now();

    setInterval(() => {
        const memUsage = process.memoryUsage();
        const heapUtilization = memUsage.heapUsed / memUsage.heapTotal;

        // ✅ LOG APENAS SE REALMENTE ALTO
        if (heapUtilization > 0.85) {
            console.log(`📊 Memory: ${(heapUtilization * 100).toFixed(1)}%`);
        }

        // ✅ CLEANUP APENAS SE NECESSÁRIO E NÃO MUITO FREQUENTE
        if (heapUtilization > MEMORY_THRESHOLD) {
            consecutiveHighMemory++;

            // ✅ EVITA CLEANUP EXCESSIVO - MÁXIMO 1x POR MINUTO
            const now = Date.now();
            if (consecutiveHighMemory >= 2 && (now - lastCleanup) > 60000) {
                console.warn(`🔄 High memory (${(heapUtilization * 100).toFixed(1)}%), cleaning cache...`);

                // Limpar cache
                if (global.cacheManager) {
                    global.cacheManager.flush();
                }

                lastCleanup = now;
                consecutiveHighMemory = 0;

                // GC apenas se disponível e realmente necessário
                if (global.gc && heapUtilization > GC_THRESHOLD) {
                    global.gc();
                }
            }
        } else if (consecutiveHighMemory > 0) {
            consecutiveHighMemory = Math.max(0, consecutiveHighMemory - 1);
        }

    }, MONITOR_INTERVAL);

    console.log(`[MONITOR] ✅ Started (interval: ${MONITOR_INTERVAL}ms, threshold: ${(MEMORY_THRESHOLD * 100).toFixed(0)}%)`);
};