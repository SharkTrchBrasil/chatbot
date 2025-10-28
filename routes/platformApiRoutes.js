// Crie um novo arquivo de rotas, ex: platformApiRoutes.js, para separar as responsabilidades

import express from 'express';
import whatsappService from '../services/whatsappService.js';

const router = express.Router();
const { CHATBOT_WEBHOOK_SECRET } = process.env; // Use a mesma chave secreta para comunicação interna

// Middleware de segurança
const verifySecret = (req, res, next) => {
    const receivedSecret = req.headers['x-webhook-secret'];
    if (receivedSecret && receivedSecret === CHATBOT_WEBHOOK_SECRET) {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized access.' });
};

router.use(verifySecret);

const PLATFORM_BOT_ID = 'platform';

// ✅ ROTA PARA CONECTAR O BOT DA PLATAFORMA (VOCÊ CHAMA ISSO MANUALMENTE OU VIA UM PAINEL DE ADMIN SEU)
router.post('/platform-bot/connect', (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'phoneNumber is required.' });
    }
    console.log(`[PLATFORM BOT] Received connection request for ${phoneNumber}.`);

    whatsappService.startSession(PLATFORM_BOT_ID, phoneNumber, 'pairing');

    res.status(202).json({ message: 'Platform bot connection process initiated.' });
});

// ✅ ROTA PARA ENVIAR MENSAGEM TRANSACIONAL (SUA API FASTAPI VAI CHAMAR ESTA ROTA)
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