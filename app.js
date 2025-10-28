// app.js - VERSÃO CORRIGIDA E COM SEGURANÇA

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet'; // ✅ ADICIONADO: Segurança de Headers
import rateLimit from 'express-rate-limit'; // ✅ ADICIONADO: Limite de Requisições
import whatsappService from './services/whatsappService.js';
import apiRoutes from './routes/apiRoutes.js';
import platformApiRoutes from './routes/platformApiRoutes.js';
// ❌ REMOVIDO: import { removeSessionFromDB } from './services/authService.js';

const { FASTAPI_URL, CHATBOT_WEBHOOK_SECRET, PORT = 3000 } = process.env;
if (!FASTAPI_URL || !CHATBOT_WEBHOOK_SECRET) {
    console.error("CRITICAL ERROR: Environment variables are mandatory!");
    process.exit(1);
}

const app = express();

// ✅ 1. Middlewares de Segurança (devem vir primeiro)
app.use(helmet()); 
app.use(express.json());

// ✅ 2. Rate Limiter para as rotas de API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // Limita cada IP a 100 requisições por janela
    message: 'Too many requests from this IP, please try again after 15 minutes',
    standardHeaders: true,
    legacyHeaders: false,
});

app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Chatbot service is running.' });
});

// ✅ 3. Aplicando o limiter às rotas
app.use('/api', apiLimiter, apiRoutes);
app.use('/platform-api', apiLimiter, platformApiRoutes);

const startServer = async () => {
    try {
        // ✅ 4. CORREÇÃO: Lógica de limpeza removida, pois 'disconnectSession' já faz isso.
        // O restoreActiveSessions garantirá que tudo esteja correto.
        console.log('[INIT] Restoring active sessions from database...');
        await whatsappService.restoreActiveSessions();
        console.log('[INIT] Session restore process finished.');

        app.listen(PORT, () => {
            console.log(`Chatbot server running on port ${PORT}`);
        });
    } catch (e) {
        console.error('[INIT] Failed to start server:', e);
        process.exit(1);
    }
};

process.on('SIGINT', whatsappService.shutdown);
process.on('SIGTERM', whatsappService.shutdown);

startServer();
