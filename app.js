// app.js - VERSÃO FINAL ROBUSTA E COMPLETA

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import cors from 'cors';

// ✅ Imports dos serviços e rotas
import apiRoutes from './routes/apiRoutes.js';
import platformApiRoutes from './routes/platformApiRoutes.js';
import whatsappService from './services/whatsappService.js';
import { startDLQProcessor, stopDLQProcessor } from './utils/forwarder.js';
import { checkHealth as checkDbHealth, closePool } from './config/database.js';
import { metricsCollector, startResourceMonitoring } from './middleware/monitoring.js';
import { cacheManager } from './services/cacheService.js';
import { verifyHmacSignature } from './middleware/hmacAuth.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// ============================================================
// ✅ MIDDLEWARE DE SEGURANÇA E PERFORMANCE
// ============================================================
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            defaultSrc: ["'none'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'", process.env.FASTAPI_URL || ''],
        }
    },
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(express.json({ limit: '10mb' })); // Aumentado para 10mb para uploads de mídia
app.disable('x-powered-by');
app.use(correlationIdMiddleware);

// ============================================================
// ✅ CORS CONFIGURADO (com suporte a HMAC/correlation headers)
// ============================================================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true); // permitir ferramentas locais (curl, etc.)
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-webhook-secret',
        'x-signature',
        'x-timestamp',
        'x-nonce',
        'x-correlation-id'
    ],
    exposedHeaders: ['x-correlation-id'],
    optionsSuccessStatus: 204
}));

// ============================================================
// ✅ ROTAS DE HEALTH CHECK E MÉTRICAS
// ============================================================

// Health check detalhado (inclui DB)
app.get('/health', async (req, res) => {
    const dbHealth = await checkDbHealth();
    const openSessions = Array.from(whatsappService.activeSessions.values())
        .filter(s => s.status === 'open').length;

    const healthStatus = dbHealth.status === 'healthy' ? 200 : 503;

    res.status(healthStatus).json({
        status: dbHealth.status === 'healthy' ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        database: dbHealth,
        sessions: {
            total: whatsappService.activeSessions.size,
            connected: openSessions
        },
        cache: cacheManager.getStats()
    });
});

// Métricas de performance
app.get('/metrics', (req, res) => {
    res.json(metricsCollector.getStats());
});

// ============================================================
// ✅ ROTAS DA APLICAÇÃO (COM AUTENTICAÇÃO)
// ============================================================

// Rotas para o Python (FastAPI) controlar este serviço (protegidas por HMAC)
app.use('/api', verifyHmacSignature(), apiRoutes);
// Rotas para o bot da plataforma (envio de notificações) (protegidas por HMAC)
app.use('/platform-api', verifyHmacSignature(), platformApiRoutes);

// ============================================================
// ✅ TRATAMENTO DE ERROS GLOBAL
// ============================================================
app.use((error, req, res, next) => {
    console.error('❌ Global error handler:', error);
    metricsCollector.recordRequest(false, 0);

    res.status(500).json({
        error: 'Internal server error',
        timestamp: new Date().toISOString(),
        path: req.path
    });
});

// ============================================================
// ✅ INICIALIZAÇÃO DO SERVIÇO E GRACEFUL SHUTDOWN
// ============================================================

const startServer = () => {
    app.listen(PORT, () => {
        console.log(`[APP] ✅ Servidor Node.js rodando na porta ${PORT}`);
        console.log(`[APP] 📊 Ambiente: ${process.env.NODE_ENV}`);

        // 1. Inicia monitoramento de recursos
        startResourceMonitoring();

        // 2. Inicia o processador da Dead Letter Queue (DLQ)
        startDLQProcessor(whatsappService.getSocketForStore);

        // 3. Restaura sessões ativas do WhatsApp
        whatsappService.restoreActiveSessions();
    });
};

const shutdown = async (signal) => {
    console.log(`\n[APP] 🛑 ${signal} recebido. Iniciando graceful shutdown...`);

    // 1. Parar processadores e serviços
    stopDLQProcessor();
    await whatsappService.shutdown();

    // 2. Fechar o pool do banco de dados
    await closePool();

    // 3. Fechar o cache
    cacheManager.close();

    console.log('[APP] ✅ Shutdown completo. Encerrando processo.');
    process.exit(0);
};

// Capturar sinais de término
process.on('SIGTERM', () => shutdown('SIGTERM')); // Terminação padrão
process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C

// Iniciar o servidor
startServer();