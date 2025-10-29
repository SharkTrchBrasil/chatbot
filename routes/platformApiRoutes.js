// Crie um novo arquivo de rotas, ex: platformApiRoutes.js, para separar as responsabilidades

import express from 'express';
import crypto from 'crypto'; // ✅ ADICIONADO
import rateLimit from 'express-rate-limit'; // ✅ ADICIONADO
import whatsappService from '../services/whatsappService.js';

const router = express.Router();
const { CHATBOT_WEBHOOK_SECRET } = process.env;

// ✅ ADICIONADO: Rate Limiter
const platformLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // 100 requisições por IP a cada 15 min
    keyGenerator: (req) => req.ip, // Limita por IP
    handler: (req, res) => {
        res.status(429).json({
            error: 'Too many requests. Please try again later.',
        });
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ✅ CORRIGIDO: Middleware de segurança (Timing-Safe)
const verifySecret = (req, res, next) => {
    const receivedSecret = req.headers['x-webhook-secret'];

    if (!receivedSecret || !CHATBOT_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'Unauthorized access.' });
    }

    try {
        const receivedBuffer = Buffer.from(receivedSecret);
        const expectedBuffer = Buffer.from(CHATBOT_WEBHOOK_SECRET);

        if (receivedBuffer.length !== expectedBuffer.length) {
            return res.status(403).json({ error: 'Unauthorized access.' });
        }

        // Use crypto.timingSafeEqual para prevenir timing attacks
        const isValid = crypto.timingSafeEqual(receivedBuffer, expectedBuffer);

        if (!isValid) {
            return res.status(403).json({ error: 'Unauthorized access.' });
        }

        return next();
    } catch (error) {
        return res.status(403).json({ error: 'Unauthorized access.' });
    }
};

router.use(platformLimiter); // ✅ APLICAR RATE LIMIT
router.use(verifySecret); // ✅ APLICAR VERIFICAÇÃO SEGURA

const PLATFORM_BOT_ID = 'platform';

// ✅ ROTA PARA CONECTAR O BOT DA PLATAFORMA
router.post('/platform-bot/connect', (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'phoneNumber is required.' });
    }
    console.log(`[PLATFORM BOT] Received connection request for ${phoneNumber}.`);

    whatsappService.startSession(PLATFORM_BOT_ID, phoneNumber, 'pairing');

    res.status(202).json({ message: 'Platform bot connection process initiated.' });
});

// ✅ ROTA PARA ENVIAR MENSAGEM TRANSACIONAL
router.post('/platform-bot/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) {
        return res.status(400).json({ error: 'number and message are required.' });
    }

    try {
        const success = await whatsappService.sendPlatformMessage(number, message);
        if (success) {
            res.status(200).json({ success: true, message: 'Platform message sent successfully.' });
        } else {
            res.status(409).json({ error: 'Platform bot is not connected.' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Failed to send platform message.' });
    }
});

export default router;