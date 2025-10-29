// services/messageService.js - NOVO ARQUIVO
import { cacheManager } from './cacheService.js';
import { SecurityManager } from '../middleware/security.js';

export class MessageService {
    constructor() {
        this.maxRetries = 3;
        this.retryDelay = 1000;
    }

    async processIncomingMessage(msg, storeId, waSocket, state) {
        // ✅ VALIDAÇÃO INICIAL
        if (!this.validateMessageStructure(msg)) {
            console.warn('Invalid message structure:', msg);
            return;
        }

        const chatId = SecurityManager.sanitizeInput(msg.key.remoteJid);
        const messageText = SecurityManager.sanitizeInput(
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text || ''
        );

        if (!messageText.trim()) {
            console.log('Empty message, skipping');
            return;
        }

        try {
            // ✅ CACHE INTELIGENTE
            const cacheKey = `msg:${storeId}:${chatId}:${Date.now()}`;
            const cached = await cacheManager.get('messages', cacheKey);

            if (cached.found) {
                console.log('Duplicate message detected, skipping');
                return;
            }

            await cacheManager.set('messages', cacheKey, true, 10); // 10 segundos

            // ✅ PROCESSAMENTO PRINCIPAL
            await this.handleMessageLogic(msg, storeId, waSocket, state, {
                chatId,
                messageText,
                clientName: SecurityManager.sanitizeInput(msg.pushName || 'Cliente')
            });

        } catch (error) {
            console.error('Message processing error:', error);
            await this.handleProcessingError(error, msg, storeId, waSocket);
        }
    }

    validateMessageStructure(msg) {
        return msg &&
               msg.key &&
               msg.key.remoteJid &&
               (msg.message?.conversation || msg.message?.extendedTextMessage);
    }

    async handleMessageLogic(msg, storeId, waSocket, state, context) {
        const { chatId, messageText, clientName } = context;

        // ✅ VERIFICAÇÃO DE ESTADO
        if (state.humanSupportUntil && new Date() < new Date(state.humanSupportUntil)) {
            console.log(`Chat ${chatId} paused for human support`);
            return;
        }

        // ✅ DETECÇÃO DE INTENÇÃO
        const intent = this.detectIntent(messageText);
        const response = await this.generateResponse(intent, storeId, state, {
            clientName,
            chatId
        });

        // ✅ ENVIO SEGURO
        await this.sendSafeReply(waSocket, storeId, chatId, response);

        // ✅ ATUALIZAÇÃO DE ESTADO
        this.updateConversationState(state, intent, chatId);
    }

    detectIntent(messageText) {
        const intents = {
            greeting: /\b(oi|ola|olá|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i,
            status: /\b(status|pedido|onde\s+está)\b/i,
            order: /\b(cardapio|menu|pedir)\b/i,
            support: /\b(atendente|humano|suporte)\b/i
        };

        for (const [intent, regex] of Object.entries(intents)) {
            if (regex.test(messageText)) {
                return intent;
            }
        }

        return 'unknown';
    }

    async sendSafeReply(waSocket, storeId, chatId, response) {
        try {
            // ✅ VERIFICAÇÃO DE CONEXÃO
            if (!waSocket || !waSocket.user) {
                throw new Error('WhatsApp socket not ready');
            }

            // ✅ TYPING INDICATOR
            await waSocket.sendPresenceUpdate('composing', chatId);
            await new Promise(resolve => setTimeout(resolve, 1000));

            // ✅ ENVIO DA MENSAGEM
            const result = await waSocket.sendMessage(chatId, {
                text: response.message
            });

            // ✅ LOG DE SUCESSO
            console.log(`✅ Message sent to ${chatId}`);

            return result;
        } catch (error) {
            console.error('Failed to send reply:', error);
            throw error;
        } finally {
            // ✅ SEMPRE PARA TYPING
            try {
                await waSocket.sendPresenceUpdate('paused', chatId);
            } catch (e) {
                // Ignora erro no cleanup
            }
        }
    }

    async handleProcessingError(error, msg, storeId, waSocket) {
        console.error('Processing error:', error);

        // ✅ TENTA ENVIAR MENSAGEM DE ERRO
        try {
            if (msg?.key?.remoteJid) {
                await this.sendSafeReply(
                    waSocket,
                    storeId,
                    msg.key.remoteJid,
                    { message: 'Desculpe, ocorreu um erro. Tente novamente.' }
                );
            }
        } catch (sendError) {
            console.error('Failed to send error message:', sendError);
        }

        // ✅ LOG PARA MONITORAMENTO
        this.logError(error, msg, storeId);
    }

    logError(error, msg, storeId) {
        const errorLog = {
            timestamp: new Date().toISOString(),
            storeId,
            chatId: msg?.key?.remoteJid,
            error: error.message,
            stack: error.stack,
            type: 'message_processing'
        };

        console.error('ERROR LOG:', errorLog);
    }
}

export const messageService = new MessageService();