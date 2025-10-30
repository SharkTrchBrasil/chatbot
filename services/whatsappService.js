// services/whatsappService.js - NOVO MÓDULO DE UTILITÁRIOS

import { forwardMessageToFastAPI } from '../utils/forwarder.js';
import { cacheManager } from './cacheService.js';

// Importa funções e estado do Session Manager
import {
    activeSessions,
    PLATFORM_BOT_ID,
    INACTIVITY_PAUSE_MS,
    startSession,
    disconnectSession,
    restoreActiveSessions,
    shutdown,
    getSocketForStore
} from './whatsappSessionManager.js';

// ✅ ANTI-BAN: Delays e controles (importado para reuso)
const OPERATION_DELAY = 2000;
const antiSpamDelay = () => new Promise(resolve => setTimeout(resolve, OPERATION_DELAY));

// ============================================================
// 💬 FUNÇÕES DE ENVIO E CHAT
// ============================================================

/**
 * Envia mensagem (COM ANTI-BAN)
 */
const sendMessage = async (sessionId, number, message, mediaUrl, mediaType, mediaFilename) => {
    const session = activeSessions.get(String(sessionId));
    if (!session?.sock || session.status !== 'open' || !session.sock.user) {
        console.warn(`[SESSION ${sessionId}] Cannot send message: session not active/open.`);
        return false;
    }

    try {
        await antiSpamDelay();

        const chatId = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        let payload;

        if (mediaType === 'image' && mediaUrl) {
            payload = { image: { url: mediaUrl }, caption: message };
        } else if (mediaType === 'audio' && mediaUrl) {
            payload = { audio: { url: mediaUrl }, ptt: true };
        } else if (mediaType === 'document' && mediaUrl) {
            payload = { document: { url: mediaUrl }, fileName: mediaFilename || 'documento.pdf', caption: message };
        } else {
            payload = { text: message };
        }

        const result = await session.sock.sendMessage(chatId, payload);

        // Encaminha a própria mensagem enviada para o FastAPI
        if (result && sessionId !== PLATFORM_BOT_ID) {
            forwardMessageToFastAPI(sessionId, result, session.sock).catch((err) => {
                console.error(`[SESSION ${sessionId}] Forward sent message failed:`, err.message);
            });
        }

        return true;
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Send error:`, err.message);
        return false;
    }
};

/**
 * Pausa chat para suporte humano
 */
const pauseChatForHuman = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || session.status !== 'open') return false;

    const cacheKey = `state:${chatId}`;
    let stateResult = await cacheManager.get('conversationState', cacheKey);
    let state = stateResult?.value || {};

    // Adiciona o tempo de inatividade (30 minutos)
    state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
    await cacheManager.set('conversationState', cacheKey, state, INACTIVITY_PAUSE_MS / 1000);

    return true;
};

/**
 * Obtém URL da foto de perfil
 */
const getProfilePictureUrl = async (storeId, chatId) => {
    const sock = getSocketForStore(storeId);
    if (!sock) return null;

    try {
        return await sock.profilePictureUrl(chatId, 'image');
    } catch {
        return null;
    }
};

/**
 * Obtém nome do contato
 */
const getContactName = async (storeId, chatId) => {
    const sock = getSocketForStore(storeId);
    if (!sock) return null;

    try {
        // Tenta obter o nome pelo método onWhatsApp para verificar existência e JID
        const [result] = await sock.onWhatsApp(chatId);
        return result?.exists ? result.jid.split('@')[0] : null;
    } catch {
        return null;
    }
};

/**
 * Envia mensagem pelo bot da plataforma
 */
const sendPlatformMessage = async (number, message, mediaUrl = null, mediaType = null, mediaFilename = null) => {
    return await sendMessage(PLATFORM_BOT_ID, number, message, mediaUrl, mediaType, mediaFilename);
};

// ============================================================
// 📤 EXPORTS (AGORA EXPORTA AS FUNÇÕES DO SESSION MANAGER DIRETAMENTE)
// ============================================================

export default {
    activeSessions,
    startSession,
    disconnectSession,
    sendMessage,
    restoreActiveSessions,
    shutdown,
    pauseChatForHuman,
    sendPlatformMessage,
    getProfilePictureUrl,
    getContactName,
    getSocketForStore,
    PLATFORM_BOT_ID,
    INACTIVITY_PAUSE_MS
};