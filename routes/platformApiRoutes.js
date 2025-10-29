// routes/platformApiRoutes.js - VERSÃO CORRIGIDA E SEGURA

import express from 'express';
// ❌ crypto não é mais necessário aqui
import rateLimit from 'express-rate-limit';
import whatsappService from '../services/whatsappService.js';
// ✅ CORREÇÃO: Importar o middleware de segurança centralizado
import { verifyWebhookSecret } from '../middleware/security.js';


const router = express.Router();
// ❌ A variável CHATBOT_WEBHOOK_SECRET não é mais necessária aqui
// const { CHATBOT_WEBHOOK_SECRET } = process.env;

// ✅ ADICIONADO: Rate Limiter (Lógica mantida, pois é especializada)
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

// ❌ REMOVIDO: Função 'verifySecret' local duplicada.
// Estamos importando 'verifyWebhookSecret' do 'security.js'

router.use(platformLimiter); // ✅ APLICAR RATE LIMIT
// ✅ CORREÇÃO: Usando a função importada
router.use(verifyWebhookSecret);

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