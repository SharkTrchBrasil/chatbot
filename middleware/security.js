// middleware/security.js - VERSÃO CORRIGIDA
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

// ✅ CORREÇÃO: Usar crypto.timingSafeEqual diretamente
export class SecurityManager {
    static timingSafeCompare(a, b) {
        try {
            const aBuffer = Buffer.from(a);
            const bBuffer = Buffer.from(b);

            if (aBuffer.length !== bBuffer.length) {
                return false;
            }

            // ✅ CORREÇÃO CRÍTICA: Usar crypto.timingSafeEqual
            return crypto.timingSafeEqual(aBuffer, bBuffer);
        } catch (error) {
            console.error('Timing safe compare error:', error);
            return false;
        }
    }

    static validateWebhookSecret(req, res, next) {
        const receivedSecret = req.headers['x-webhook-secret'];
        const expectedSecret = process.env.CHATBOT_WEBHOOK_SECRET;

        if (!receivedSecret || !expectedSecret) {
            return res.status(403).json({
                error: 'Authentication required',
                timestamp: new Date().toISOString()
            });
        }

        // ✅ CORREÇÃO: Usar o método estático corretamente
        if (!SecurityManager.timingSafeCompare(receivedSecret, expectedSecret)) {
            console.warn(`🔐 Failed authentication attempt from ${req.ip}`);
            return res.status(403).json({
                error: 'Invalid authentication token',
                timestamp: new Date().toISOString()
            });
        }

        next();
    }

    static sanitizeInput(input) {
        if (typeof input !== 'string') return input;

        return input
            .replace(/[<>]/g, '') // Remove < e >
            .replace(/javascript:/gi, '') // Remove javascript:
            .replace(/on\w+=/gi, '') // Remove event handlers
            .substring(0, 1000); // Limita tamanho
    }

    static validateStoreId(storeId) {
        const id = parseInt(storeId, 10);
        return !isNaN(id) && id > 0 && id < 1000000;
    }

    static validatePhoneNumber(phone) {
        return /^\d{10,15}$/.test(phone);
    }
}

// ✅ CORREÇÃO: Exportação correta para uso no Express
export const verifyWebhookSecret = SecurityManager.validateWebhookSecret;

export const createRateLimiter = (windowMs, max, message = 'Too many requests') => {
    return rateLimit({
        windowMs,
        max,
        message: { error: message },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => {
            const storeId = req.body?.storeId || req.params?.storeId || 'unknown';
            return `${req.ip}-${req.get('user-agent')}-${storeId}`.substring(0, 100);
        },
        handler: (req, res) => {
            res.status(429).json({
                error: message,
                retryAfter: Math.ceil(windowMs / 1000),
                timestamp: new Date().toISOString()
            });
        }
    });
};