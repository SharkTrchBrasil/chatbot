// app.js - VERSÃO À PROVA DE BALAS COM TODAS AS OTIMIZAÇÕES

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import whatsappService from './services/whatsappService.js';
import apiRoutes from './routes/apiRoutes.js';
import platformApiRoutes from './routes/platformApiRoutes.js';
import { closePool } from './config/database.js';
import {
    requestLogger,
    errorHandler,
    getDetailedHealth,
    startResourceMonitoring
} from './middleware/monitoring.js';

// ✅ SEGURANÇA: Validação de variáveis de ambiente obrigatórias
const requiredEnvVars = ['FASTAPI_URL', 'CHATBOT_WEBHOOK_SECRET', 'DATABASE_URL'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
    console.error(`❌ CRITICAL ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
}

const { PORT = 3000, NODE_ENV = 'production' } = process.env;
const app = express();

// ✅ PERFORMANCE: Compression middleware
app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    },
    level: 6 // Balanceamento entre CPU e tamanho
}));

// ✅ SEGURANÇA: Helmet com configurações seguras
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// ✅ PERFORMANCE: Limitar tamanho do body
app.use(express.json({
    limit: '10mb',
    strict: true
}));
app.use(express.urlencoded({
    extended: true,
    limit: '10mb'
}));

// ✅ OBSERVABILIDADE: Request logging
app.use(requestLogger);

// ✅ Health check público (sem autenticação)
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'WhatsApp Chatbot Service',
        version: '2.0.0',
        timestamp: new Date().toISOString()
    });
});

// ✅ Health check detalhado
app.get('/health', async (req, res) => {
    try {
        const health = await getDetailedHealth();
        const statusCode = health.status === 'healthy' ? 200 : 503;
        res.status(statusCode).json(health);
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ✅ Metrics endpoint (proteger em produção)
app.get('/metrics', (req, res) => {
    if (NODE_ENV === 'production' && req.headers['x-metrics-token'] !== process.env.METRICS_TOKEN) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    getDetailedHealth().then(health => {
        res.status(200).json(health);
    }).catch(error => {
        res.status(500).json({ error: error.message });
    });
});

// ✅ Rotas da API com prefixos
app.use('/api', apiRoutes);
app.use('/platform-api', platformApiRoutes);

// ✅ 404 Handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.path,
        method: req.method
    });
});

// ✅ SEGURANÇA: Global error handler
app.use(errorHandler);

// ✅ ROBUSTEZ: Startup com retry
const startServer = async (retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🚀 Starting WhatsApp Chatbot Service (Attempt ${attempt}/${retries})`);
            console.log(`${'='.repeat(60)}\n`);

            // ✅ Iniciar monitoramento de recursos
            startResourceMonitoring();
            console.log('✅ Resource monitoring started');

            // ✅ Restaurar sessões ativas
            console.log('🔄 Restoring active sessions...');
            await whatsappService.restoreActiveSessions();
            console.log('✅ Session restore completed');

            // ✅ Iniciar servidor HTTP
            const server = app.listen(PORT, () => {
                console.log(`\n${'='.repeat(60)}`);
                console.log(`✅ Server running on port ${PORT}`);
                console.log(`📊 Environment: ${NODE_ENV}`);
                console.log(`🕐 Started at: ${new Date().toISOString()}`);
                console.log(`${'='.repeat(60)}\n`);
            });

            // ✅ ROBUSTEZ: Configurar timeouts do servidor
            server.keepAliveTimeout = 65000; // Maior que ALB timeout (60s)
            server.headersTimeout = 66000;

            // ✅ ROBUSTEZ: Graceful shutdown handlers
            const gracefulShutdown = async (signal) => {
                console.log(`\n⚠️  ${signal} received. Starting graceful shutdown...`);

                server.close(async () => {
                    console.log('✅ HTTP server closed');

                    try {
                        await whatsappService.shutdown();
                        console.log('✅ WhatsApp sessions closed');

                        await closePool();
                        console.log('✅ Database connections closed');

                        console.log('✅ Graceful shutdown completed');
                        process.exit(0);
                    } catch (error) {
                        console.error('❌ Error during shutdown:', error);
                        process.exit(1);
                    }
                });

                // ✅ Forçar saída após 30s se não completar
                setTimeout(() => {
                    console.error('❌ Forced shutdown after timeout');
                    process.exit(1);
                }, 30000);
            };

            process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
            process.on('SIGINT', () => gracefulShutdown('SIGINT'));

            // ✅ ROBUSTEZ: Handlers para erros não capturados
            process.on('uncaughtException', (error) => {
                console.error('❌ UNCAUGHT EXCEPTION:', error);
                gracefulShutdown('UNCAUGHT_EXCEPTION');
            });

            process.on('unhandledRejection', (reason, promise) => {
                console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
                // Não fazer shutdown para rejeições não tratadas em desenvolvimento
                if (NODE_ENV === 'production') {
                    gracefulShutdown('UNHANDLED_REJECTION');
                }
            });

            return; // Sucesso, sair do loop

        } catch (error) {
            console.error(`❌ Startup failed (attempt ${attempt}/${retries}):`, error.message);

            if (attempt < retries) {
                const delay = attempt * 5000; // Exponential backoff
                console.log(`⏳ Retrying in ${delay/1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error('❌ Max startup retries reached. Exiting.');
                process.exit(1);
            }
        }
    }
};

// ✅ Iniciar aplicação
startServer().catch(error => {
    console.error('❌ Fatal startup error:', error);
    process.exit(1);
});