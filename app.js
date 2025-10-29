// app.js - VERSÃO FINAL CORRIGIDA
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';

// ✅ IMPORTAÇÕES CORRIGIDAS
import { messageService } from './services/messageService.js';
import { SecurityManager, createRateLimiter } from './middleware/security.js';
import { metricsCollector } from './middleware/monitoring.js';
import { cacheManager } from './services/cacheService.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// ✅ CONFIGURAÇÃO DE SEGURANÇA
app.use(helmet({
    contentSecurityPolicy: false, // Desabilita se não usar HTML
    crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

// ✅ RATE LIMITING
app.use(createRateLimiter(15 * 60 * 1000, 100)); // 100 requests por 15min

// ✅ HEALTH CHECKS
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

app.get('/metrics', (req, res) => {
    res.json(metricsCollector.getStats());
});

// ✅ ROTAS PRINCIPAIS COM AUTENTICAÇÃO
app.use('/api', SecurityManager.validateWebhookSecret);
app.use('/api', createRateLimiter(60 * 1000, 60)); // 60 requests por minuto

// ✅ ERROR HANDLER GLOBAL
app.use((error, req, res, next) => {
    console.error('Global error handler:', error);

    metricsCollector.recordRequest(false, 0);

    res.status(500).json({
        error: 'Internal server error',
        timestamp: new Date().toISOString(),
        path: req.path
    });
});

// ✅ GRACEFUL SHUTDOWN
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, starting graceful shutdown...');

    // Fecha conexões
    await cacheManager.close?.();

    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
});