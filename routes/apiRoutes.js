// routes/apiRoutes.js - VERSÃO SEGURA COM CENTRALIZAÇÃO DE AUTH

import express from 'express';
// ❌ crypto não é mais necessário aqui
import rateLimit from 'express-rate-limit';
import whatsappService from '../services/whatsappService.js';
import { body, param, validationResult } from 'express-validator';
// ✅ CORREÇÃO: Importar o middleware de segurança centralizado
import { verifyWebhookSecret } from '../middleware/security.js';

const router = express.Router();
// ❌ A variável CHATBOT_WEBHOOK_SECRET não é mais necessária aqui
// const { CHATBOT_WEBHOOK_SECRET } = process.env;

// ❌ REMOVIDO: Função 'verifySecret' local duplicada.
// Estamos importando 'verifyWebhookSecret' do 'security.js'


// ✅ SEGURANÇA: Rate limiter por loja (Lógica mantida, pois é especializada)
const createStoreLimiter = (max, windowMs) => rateLimit({
    windowMs,
    max,
    keyGenerator: (req) => {
        // Rate limit baseado em storeId + IP
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
    legacyHeaders: false,
    skip: (req) => req.ip === '127.0.0.1' // Skip localhost em dev
});

// ✅ Rate limiters específicos por endpoint (Mantidos)
const connectionLimiter = createStoreLimiter(10, 15 * 60 * 1000); // 10 conexões a cada 15min
const messageLimiter = createStoreLimiter(100, 60 * 1000); // 100 mensagens por minuto
const statusLimiter = createStoreLimiter(60, 60 * 1000); // 60 updates por minuto

// ✅ Middleware de validação de erros (Mantido)
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

// ✅ Aplicar security middleware
// ✅ CORREÇÃO: Usando a função importada
router.use(verifyWebhookSecret);

// ✅ ENDPOINT: Iniciar sessão com validação completa
router.post('/start-session',
    connectionLimiter,
    [
        body('storeId').isInt({ min: 1 }).withMessage('storeId must be a positive integer'),
        body('method').isIn(['qr', 'pairing']).withMessage('method must be "qr" or "pairing"'),
        body('phoneNumber').optional().matches(/^\d{10,15}$/).withMessage('phoneNumber must be 10-15 digits')
    ],
    validateRequest,
    async (req, res) => {
        const { storeId, phoneNumber, method } = req.body;

        // ✅ Validação condicional
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

// ... (O restante do arquivo 'apiRoutes.js' permanece exatamente o mesmo) ...
// (disconnect, send-message, update-status, pause-chat, profile-picture, contact-name, health)

// ✅ ENDPOINT: Desconectar sessão
router.post('/disconnect',
    connectionLimiter,
    [
        body('storeId').isInt({ min: 1 }).withMessage('storeId must be a positive integer')
    ],
    validateRequest,
    async (req, res) => {
        const { storeId } = req.body;

        try {
            console.log(`[API] Disconnecting store ${storeId}`);
            await whatsappService.disconnectSession(storeId);

            res.status(200).json({
                message: 'Disconnection completed',
                storeId
            });
        } catch (error) {
            console.error(`[API] Failed to disconnect store ${storeId}:`, error.message);
            res.status(500).json({
                error: 'Failed to disconnect',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
);

// ✅ ENDPOINT: Enviar mensagem com validação
router.post('/send-message',
    messageLimiter,
    [
        body('storeId').isInt({ min: 1 }).withMessage('storeId must be a positive integer'),
        body('number').matches(/^\d{10,15}$/).withMessage('number must be 10-15 digits'),
        body('message').optional().isString().isLength({ max: 4096 }).withMessage('message too long'),
        body('mediaUrl').optional().isURL().withMessage('mediaUrl must be a valid URL'),
        body('mediaType').optional().isIn(['image', 'audio', 'document']).withMessage('Invalid mediaType'),
        body('mediaFilename').optional().isString().isLength({ max: 255 })
    ],
    validateRequest,
    async (req, res) => {
        const { storeId, number, message, mediaUrl, mediaType, mediaFilename } = req.body;

        // ✅ Validação: mensagem OU mídia obrigatória
        if (!message && !mediaUrl) {
            return res.status(400).json({
                error: 'Either message or mediaUrl is required'
            });
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
            console.error(`[API] Failed to send message for store ${storeId}:`, error.message);
            res.status(500).json({
                error: 'Failed to send message',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
);

// ✅ ENDPOINT: Atualizar status de atividade
router.post('/update-status',
    statusLimiter,
    [
        body('storeId').isInt({ min: 1 }).withMessage('storeId must be a positive integer'),
        body('isActive').isBoolean().withMessage('isActive must be boolean')
    ],
    validateRequest,
    (req, res) => {
        const { storeId, isActive } = req.body;

        const session = whatsappService.activeSessions.get(String(storeId));

        if (session && session.status === 'open') {
            session.isActive = isActive;
            whatsappService.activeSessions.set(String(storeId), session);

            console.log(`[API] Store ${storeId} activity status: ${isActive}`);

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

// ✅ ENDPOINT: Pausar chat para atendimento humano
router.post('/pause-chat',
    statusLimiter,
    [
        body('storeId').isInt({ min: 1 }).withMessage('storeId must be a positive integer'),
        body('chatId').matches(/^\d+@s\.whatsapp\.net$/).withMessage('Invalid chatId format')
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
            console.error(`[API] Failed to pause chat for store ${storeId}:`, error.message);
            res.status(500).json({
                error: 'Failed to pause chat',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
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
                error: 'Failed to fetch profile picture',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
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
                error: 'Failed to fetch contact name',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
);

// ✅ ENDPOINT: Health check (sem autenticação)
router.get('/health', (req, res) => {
    const activeSessions = whatsappService.activeSessions.size;
    const openSessions = Array.from(whatsappService.activeSessions.values())
        .filter(s => s.status === 'open').length;

    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        sessions: {
            total: activeSessions,
            connected: openSessions
        },
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

export default router;