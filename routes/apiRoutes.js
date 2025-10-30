// routes/apiRoutes.js - VERSÃO CORRIGIDA COM PREFIXO

import express from 'express';
import rateLimit from 'express-rate-limit';
import whatsappService from '../services/whatsappService.js';
import { body, param, validationResult } from 'express-validator';
import { verifyWebhookSecret } from '../middleware/security.js';

const router = express.Router();

// ✅ Rate limiters
const createStoreLimiter = (max, windowMs) => rateLimit({
    windowMs,
    max,
    keyGenerator: (req) => {
        const storeId = req.body.storeId || req.params.storeId || 'unknown';
        return `${req.ip}-store-${storeId}`;
    },
    handler: (req, res) => {
        res.status(429).json({
            error: 'Too many requests. Please try again later.',
            retryAfter: Math.ceil(windowMs / 1000)
        });
    },
    standardHeaders: true,
    legacyHeaders: false
});

const connectionLimiter = createStoreLimiter(10, 15 * 60 * 1000);
const messageLimiter = createStoreLimiter(100, 60 * 1000);
const statusLimiter = createStoreLimiter(60, 60 * 1000);

// ✅ Validação
const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            error: 'Validation failed',
            details: errors.array()
        });
    }
    next();
};

// ✅ APLICAR SEGURANÇA
router.use(verifyWebhookSecret);

// ✅ ENDPOINT: Iniciar sessão
router.post('/start-session',
    connectionLimiter,
    [
        body('storeId').isInt({ min: 1 }),
        body('method').isIn(['qr', 'pairing']),
        body('phoneNumber').optional().matches(/^\d{10,15}$/)
    ],
    validateRequest,
    async (req, res) => {
        const { storeId, phoneNumber, method } = req.body;

        if (method === 'pairing' && !phoneNumber) {
            return res.status(400).json({
                error: 'phoneNumber is required for pairing method'
            });
        }

        const session = whatsappService.activeSessions.get(String(storeId));
        if (session && ['connecting', 'open'].includes(session.status)) {
            return res.status(200).json({
                message: `Session is already ${session.status}`,
                status: session.status
            });
        }

        try {
            await whatsappService.startSession(storeId, phoneNumber, method);
            res.status(202).json({
                message: 'Connection process initiated',
                storeId,
                method
            });
        } catch (error) {
            console.error(`[API] Failed to start session for store ${storeId}:`, error.message);
            res.status(500).json({
                error: 'Failed to initiate connection',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
);

// ✅ ENDPOINT: Desconectar
router.post('/disconnect',
    connectionLimiter,
    [body('storeId').isInt({ min: 1 })],
    validateRequest,
    async (req, res) => {
        const { storeId } = req.body;

        try {
            await whatsappService.disconnectSession(storeId);
            res.status(200).json({
                message: 'Disconnection completed',
                storeId
            });
        } catch (error) {
            console.error(`[API] Failed to disconnect:`, error.message);
            res.status(500).json({
                error: 'Failed to disconnect'
            });
        }
    }
);

// ✅ ENDPOINT: Enviar mensagem
router.post('/send-message',
    messageLimiter,
    [
        body('storeId').isInt({ min: 1 }),
        body('number').matches(/^\d{10,15}$/),
        body('message').optional().isString().isLength({ min: 1, max: 4096 }),
        body('mediaUrl').optional().isURL(),
        body('mediaType').optional().isIn(['image', 'audio', 'document']),
        body('mediaFilename').optional().isString().isLength({ max: 255 })
    ],
    validateRequest,
    async (req, res) => {
        const { storeId, number, message, mediaUrl, mediaType, mediaFilename } = req.body;

        if (!message && !mediaUrl) {
            return res.status(400).json({
                error: 'Either message or mediaUrl is required'
            });
        }

        if (message && !message.trim()) {
            return res.status(400).json({ error: 'message cannot be blank' });
        }

        try {
            const success = await whatsappService.sendMessage(
                storeId,
                number,
                message || '',
                mediaUrl,
                mediaType,
                mediaFilename
            );

            if (success) {
                res.status(200).json({
                    success: true,
                    message: 'Message sent successfully',
                    storeId,
                    recipient: number
                });
            } else {
                res.status(409).json({
                    error: 'Session not ready or message failed',
                    storeId
                });
            }
        } catch (error) {
            console.error(`[API] Failed to send message:`, error.message);
            res.status(500).json({
                error: 'Failed to send message'
            });
        }
    }
);

// ✅ ENDPOINT: Atualizar status
router.post('/update-status',
    statusLimiter,
    [
        body('storeId').isInt({ min: 1 }),
        body('isActive').isBoolean()
    ],
    validateRequest,
    (req, res) => {
        const { storeId, isActive } = req.body;
        const session = whatsappService.activeSessions.get(String(storeId));

        if (session && session.status === 'open') {
            session.isActive = isActive;
            whatsappService.activeSessions.set(String(storeId), session);

            res.status(200).json({
                message: 'Status updated successfully',
                storeId,
                isActive
            });
        } else {
            res.status(404).json({
                error: 'Session not found or not connected',
                storeId
            });
        }
    }
);

// ✅ ENDPOINT: Pausar chat
router.post('/pause-chat',
    statusLimiter,
    [
        body('storeId').isInt({ min: 1 }),
        body('chatId').matches(/^\d+@s\.whatsapp\.net$/)
    ],
    validateRequest,
    (req, res) => {
        const { storeId, chatId } = req.body;

        try {
            const success = whatsappService.pauseChatForHuman(storeId, chatId);

            if (success) {
                res.status(200).json({
                    message: 'Chat paused for human support',
                    storeId,
                    chatId,
                    pauseDuration: '30 minutes'
                });
            } else {
                res.status(404).json({
                    error: 'Session not found or not ready',
                    storeId
                });
            }
        } catch (error) {
            console.error(`[API] Failed to pause chat:`, error.message);
            res.status(500).json({
                error: 'Failed to pause chat'
            });
        }
    }
);

// ✅ ENDPOINT: Buscar foto de perfil
router.get('/profile-picture/:storeId/:chatId',
    statusLimiter,
    [
        param('storeId').isInt({ min: 1 }),
        param('chatId').matches(/^\d+@s\.whatsapp\.net$/)
    ],
    validateRequest,
    async (req, res) => {
        const { storeId, chatId } = req.params;

        try {
            const url = await whatsappService.getProfilePictureUrl(storeId, chatId);

            if (url) {
                res.status(200).json({
                    profilePicUrl: url,
                    chatId
                });
            } else {
                res.status(404).json({
                    error: 'Profile picture not found',
                    chatId
                });
            }
        } catch (error) {
            console.error(`[API] Failed to fetch profile picture:`, error.message);
            res.status(500).json({
                error: 'Failed to fetch profile picture'
            });
        }
    }
);

// ✅ ENDPOINT: Buscar nome do contato
router.get('/contact-name/:storeId/:chatId',
    statusLimiter,
    [
        param('storeId').isInt({ min: 1 }),
        param('chatId').matches(/^\d+@s\.whatsapp\.net$/)
    ],
    validateRequest,
    async (req, res) => {
        const { storeId, chatId } = req.params;

        try {
            const name = await whatsappService.getContactName(storeId, chatId);

            if (name) {
                res.status(200).json({
                    name,
                    chatId
                });
            } else {
                res.status(404).json({
                    error: 'Contact name not found',
                    chatId
                });
            }
        } catch (error) {
            console.error(`[API] Failed to fetch contact name:`, error.message);
            res.status(500).json({
                error: 'Failed to fetch contact name'
            });
        }
    }
);

export default router;