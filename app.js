// app.js - VERSÃO ROBUSTA E SEGURA

import express from 'express';
import dotenv from 'dotenv';
import whatsappService from './services/whatsappService.js';
import apiRoutes from './routes/apiRoutes.js';
import platformApiRoutes from './routes/platformApiRoutes.js';
import { closePool } from './config/database.js';
import {
    requestLogger,
    errorHandler,
    startResourceMonitoring
} from './middleware/monitoring.js';
import { startDLQProcessor } from './utils/forwarder.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const MAX_STARTUP_ATTEMPTS = 3;
const STARTUP_DELAY = 5000;

// ✅ Estado da aplicação
let isShuttingDown = false;
let isStartupComplete = false;
let server = null;

// ============================================================
// MIDDLEWARES
// ============================================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ✅ Middleware de logging
app.use(requestLogger);

// ✅ SEGURANÇA: Headers de segurança
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// ✅ Health check endpoint (sem autenticação)
app.get('/health', (req, res) => {
    const healthStatus = {
        status: isStartupComplete ? 'healthy' : 'starting',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        sessions: {
            total: whatsappService.activeSessions.size,
            connected: Array.from(whatsappService.activeSessions.values())
                .filter(s => s.status === 'open').length
        },
        memory: {
            used: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
            total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB`
        }
    };

    const statusCode = isStartupComplete ? 200 : 503;
    res.status(statusCode).json(healthStatus);
});

// ✅ Rotas da API
app.use('/api', apiRoutes);
app.use('/api', platformApiRoutes);

// ✅ Rota 404
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.path,
        method: req.method
    });
});

// ✅ Error handler global
app.use(errorHandler);

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

const gracefulShutdown = async (signal) => {
    if (isShuttingDown) {
        console.log('[SHUTDOWN] Already shutting down. Ignoring duplicate signal.');
        return;
    }

    isShuttingDown = true;
    console.log(`\n[SHUTDOWN] 🛑 ${signal} received. Starting graceful shutdown...`);

    // ✅ CORREÇÃO: Aguardar startup completar antes de desligar
    if (!isStartupComplete) {
        console.log('[SHUTDOWN] ⏳ Waiting for startup to complete (max 10s)...');
        let waited = 0;
        while (!isStartupComplete && waited < 10000) {
            await new Promise(resolve => setTimeout(resolve, 500));
            waited += 500;
        }
    }

    try {
        // ✅ Passo 1: Parar de aceitar novas requisições
        if (server) {
            console.log('[SHUTDOWN] 📴 Closing HTTP server...');
            await new Promise((resolve, reject) => {
                server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            console.log('[SHUTDOWN] ✅ HTTP server closed');
        }

        // ✅ Passo 2: Fechar conexões WhatsApp
        console.log('[SHUTDOWN] 📱 Closing WhatsApp sessions...');
        await whatsappService.shutdown();
        console.log('[SHUTDOWN] ✅ WhatsApp sessions closed');

        // ✅ Passo 3: Fechar pool de banco de dados
        console.log('[SHUTDOWN] 🗄️ Closing database connections...');
        await closePool();
        console.log('[SHUTDOWN] ✅ Database connections closed');

        console.log('[SHUTDOWN] ✅ Graceful shutdown completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('[SHUTDOWN] ❌ Error during shutdown:', error);
        process.exit(1);
    }
};

// ✅ Event handlers para shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ✅ CRÍTICO: Handler para uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('\n============================================================');
    console.error('❌ UNCAUGHT EXCEPTION:', error.name, error.message);
    console.error('============================================================');
    console.error('Stack Trace:', error.stack);
    console.error('============================================================');
    console.error('⚠️  UNCAUGHT_EXCEPTION received. Starting graceful shutdown...');

    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// ✅ Handler para unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('\n============================================================');
    console.error('❌ UNHANDLED REJECTION at:', promise);
    console.error('Reason:', reason);
    console.error('============================================================');

    // ✅ Não fazer shutdown em rejections, apenas logar
    // Alguns são esperados (ex: timeout de conexão)
});

// ============================================================
// STARTUP COM RETRY
// ============================================================

const startServer = async (attempt = 1) => {
    console.log('\n============================================================');
    console.log(`🚀 Starting WhatsApp Chatbot Service (Attempt ${attempt}/${MAX_STARTUP_ATTEMPTS})`);
    console.log('============================================================');

    try {
        // ✅ Validar variáveis de ambiente críticas
        const requiredEnvVars = [
            'DATABASE_URL',
            'FASTAPI_URL',
            'CHATBOT_WEBHOOK_SECRET'
        ];

        const missingVars = requiredEnvVars.filter(v => !process.env[v]);
        if (missingVars.length > 0) {
            throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
        }

        // ✅ Iniciar servidor HTTP ANTES de restaurar sessões
        server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server running on port ${PORT}`);
            console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🕐 Started at: ${new Date().toISOString()}`);
        });

        // ✅ Aguardar servidor estar pronto
        await new Promise(resolve => setTimeout(resolve, 1000));

        // ✅ Iniciar monitoramento de recursos
        startResourceMonitoring();
        console.log('✅ Resource monitoring started');

        // ✅ Iniciar processador de DLQ
        startDLQProcessor();

        // ✅ CRÍTICO: Restaurar sessões DEPOIS do servidor estar pronto
        console.log('🔄 Restoring active sessions...');
        await whatsappService.restoreActiveSessions();
        console.log('✅ Session restore completed');

        // ✅ Marcar startup como completo
        isStartupComplete = true;

        console.log('============================================================');
        console.log('✅ STARTUP COMPLETED SUCCESSFULLY');
        console.log('============================================================\n');

    } catch (error) {
        console.error('\n============================================================');
        console.error('❌ STARTUP FAILED:', error.message);
        console.error('============================================================\n');

        // ✅ Retry com backoff exponencial
        if (attempt < MAX_STARTUP_ATTEMPTS) {
            const delay = STARTUP_DELAY * attempt;
            console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return startServer(attempt + 1);
        } else {
            console.error('❌ Max startup attempts reached. Exiting...');
            process.exit(1);
        }
    }
};

// ✅ Iniciar aplicação
startServer();

export default app;