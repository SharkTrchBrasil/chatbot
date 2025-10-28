// routes/apiRoutes.js

import express from 'express';
import whatsappService from '../services/whatsappService.js';

const router = express.Router();
const { CHATBOT_WEBHOOK_SECRET } = process.env;

// Security verification middleware
const verifySecret = (req, res, next) => {
    const receivedSecret = req.headers['x-webhook-secret'];
    if (receivedSecret && receivedSecret === CHATBOT_WEBHOOK_SECRET) {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized access. Invalid secret key.' });
};

// Applying the middleware to all routes in this file
router.use(verifySecret);


router.post('/start-session', (req, res) => {
    // ✅ 1. Extrai os três parâmetros do corpo da requisição.
    const { storeId, phoneNumber, method } = req.body;

    // ✅ 2. Validação: phoneNumber agora só é obrigatório se o método for 'pairing'.
    if (!storeId || !method) {
        return res.status(400).json({ error: 'storeId and method ("qr" or "pairing") are required.' });
    }
    if (method === 'pairing' && !phoneNumber) {
        return res.status(400).json({ error: 'phoneNumber is required for pairing method.' });
    }
    if (method !== 'qr' && method !== 'pairing') {
        return res.status(400).json({ error: 'method must be either "qr" or "pairing".' });
    }

    const session = whatsappService.activeSessions.get(String(storeId));
    if (session && ['connecting', 'open', 'closing'].includes(session.status)) {
        return res.status(200).json({ message: `Session is already ${session.status}.` });
    }

    // ✅ 3. Passa TODOS os parâmetros para a função de serviço.
    whatsappService.startSession(storeId, phoneNumber, method);
    res.status(202).json({ message: 'Connection process initiated.' });
});

router.post('/disconnect', async (req, res) => {
    const { storeId } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId is required.' });

    console.log(`[STORE ${storeId}] Received disconnection request.`);
    // ✅ CORRIGIDO: Passando o storeId para a função de serviço
    await whatsappService.disconnectSession(storeId);
    res.status(200).json({ message: 'Disconnection process completed and session removed.' });
});



router.post('/send-message', async (req, res) => {
    // 1. ✅ Extrai TODOS os campos do corpo da requisição
    const { storeId, number, message, mediaUrl, mediaType, mediaFilename } = req.body;

    // 2. ✅ Validação ajustada: permite mensagem vazia se houver mídia
    if (!storeId || !number) {
        return res.status(400).json({ error: 'storeId and number are required.' });
    }
    if (!message && !mediaUrl) {
        return res.status(400).json({ error: 'Either message or mediaUrl is required.' });
    }


    try {
        // 3. ✅ Passa TODOS os parâmetros para a função de serviço
        const success = await whatsappService.sendMessage(
            storeId,
            number,
            message || '', // Garante que message seja sempre uma string
            mediaUrl,
            mediaType,
            mediaFilename
        );

        if (success) {
            res.status(200).json({ success: true, message: 'Message sent successfully.' });
        } else {
            // Este erro agora faz mais sentido, pois pode falhar se a sessão não estiver ativa
            res.status(409).json({ error: 'Chatbot is not connected for this store.' });
        }
    } catch (e) {
        console.error(`[STORE ${storeId}] Failed to send message to ${number}:`, e);
        res.status(500).json({ error: 'Failed to send message via WhatsApp.' });
    }
});


router.post('/update-status', (req, res) => {
    const { storeId, isActive } = req.body;
    if (!storeId || typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'storeId and isActive (boolean) fields are required.' });
    }

    const session = whatsappService.activeSessions.get(String(storeId));
    if (session && session.status === 'open') {
        session.isActive = isActive;
        whatsappService.activeSessions.set(String(storeId), session);
        console.log(`[STORE ${storeId}] Activity status changed to: ${isActive}`);
        res.status(200).json({ message: 'Status updated successfully.' });
    } else {
        res.status(404).json({ error: 'Session not found or not connected.' });
    }
});


router.post('/pause-chat', (req, res) => {
    const { storeId, chatId } = req.body;
    if (!storeId || !chatId) {
        return res.status(400).json({ error: 'storeId and chatId are required.' });
    }

    try {
        const success = whatsappService.pauseChatForHuman(storeId, chatId);
        if (success) {
            res.status(200).json({ message: 'Chat paused for human support successfully.' });
        } else {
            res.status(404).json({ error: 'Active session or conversation state not found.' });
        }
    } catch (e) {
        console.error(`[STORE ${storeId}] Failed to pause chat for ${chatId}:`, e);
        res.status(500).json({ error: 'Failed to process pause request.' });
    }
});

// Endpoint para buscar a foto de perfil
router.get('/profile-picture/:storeId/:chatId', async (req, res) => {
    const { storeId, chatId } = req.params;
    if (!storeId || !chatId) {
        return res.status(400).json({ error: 'storeId and chatId are required.' });
    }
    try {
        const url = await whatsappService.getProfilePictureUrl(storeId, chatId);
        if (url) {
            res.status(200).json({ profilePicUrl: url });
        } else {
            res.status(404).json({ error: 'Profile picture not found.' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// Endpoint para buscar o nome do contato
router.get('/contact-name/:storeId/:chatId', async (req, res) => {
    const { storeId, chatId } = req.params;
    if (!storeId || !chatId) {
        return res.status(400).json({ error: 'storeId and chatId are required.' });
    }
    try {
        const name = await whatsappService.getContactName(storeId, chatId);
        if (name) {
            res.status(200).json({ name: name });
        } else {
            res.status(404).json({ error: 'Contact name not found.' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});





export default router;