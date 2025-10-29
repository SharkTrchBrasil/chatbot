// middleware/monitoring.js - VERSÃO CORRIGIDA
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

        this.maxHistory = 100; // ✅ LIMITE FIXO
        this.responseTimes = [];
        this.startTime = Date.now();

        // ✅ CLEANUP AUTOMÁTICO
        setInterval(() => this.cleanup(), 60000);
    }

    recordRequest(success, responseTime) {
        this.metrics.requestsTotal++;

        if (success) {
            this.metrics.requestsSuccess++;
        } else {
            this.metrics.requestsError++;
        }

        // ✅ LIMITE DE HISTÓRICO
        this.responseTimes.push(responseTime);
        if (this.responseTimes.length > this.maxHistory) {
            this.responseTimes.shift();
        }
    }

    recordMessage() {
        this.metrics.messagesProcessed++;
    }

    recordCache(hit) {
        if (hit) {
            this.metrics.cacheHits++;
        } else {
            this.metrics.cacheMisses++;
        }
    }

    cleanup() {
        // ✅ MANTÉM APENAS OS ÚLTIMOS 100 REGISTROS
        if (this.responseTimes.length > this.maxHistory) {
            this.responseTimes = this.responseTimes.slice(-this.maxHistory);
        }

        // ✅ RESETA A CADA 24H PARA EVITAR CRESCIMENTO INFINITO
        const uptime = Date.now() - this.startTime;
        if (uptime > 24 * 60 * 60 * 1000) {
            this.responseTimes = [];
            this.startTime = Date.now();
        }
    }

    getStats() {
        const times = this.responseTimes;
        const sorted = [...times].sort((a, b) => a - b);

        return {
            requests: {
                total: this.metrics.requestsTotal,
                success: this.metrics.requestsSuccess,
                error: this.metrics.requestsError,
                successRate: this.metrics.requestsTotal > 0 ?
                    ((this.metrics.requestsSuccess / this.metrics.requestsTotal) * 100).toFixed(1) + '%' : '0%'
            },
            performance: {
                avgResponseTime: times.length ?
                    (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2) : 0,
                p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
                max: sorted[sorted.length - 1] || 0
            },
            messages: {
                processed: this.metrics.messagesProcessed
            },
            cache: {
                hitRate: (this.metrics.cacheHits + this.metrics.cacheMisses) > 0 ?
                    ((this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses)) * 100).toFixed(1) + '%' : '0%'
            },
            uptime: Math.floor((Date.now() - this.startTime) / 1000) + 's'
        };
    }
}

export const metricsCollector = new SafeMetricsCollector();