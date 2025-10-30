// services/whatsappService.js - CORRIGIDO PARA 6.7.18 (428 ERROR FIX)

import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { getStoresToReconnect, updateConversationMetadata } from './chatbotService.js';
import { notifyFastAPI } from '../utils/notifications.js';
import { processMessage } from '../controllers/chatbotController.js';
import { forwardMessageToFastAPI } from '../utils/forwarder.js';
import { cacheManager } from './cacheService.js';
import pool from '../config/database.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;
const MAX_RESTORE_ATTEMPTS = 3;
const SESSION_RESTORE_DELAY = 5000;

let isRestoringComplete = false;

// ✅ CRÍTICO: Diretório para auth_info (6.7.18 requer filesystem)
const AUTH_DIR = path.join(__dirname, '..', 'auth_sessions');

// ✅ Garantir que o diretório existe
const ensureAuthDir = async () => {
    try {
        await fs.mkdir(AUTH_DIR, { recursive: true });
    } catch (err) {
        console.error('[AUTH] Failed to create auth dir:', err.message);
    }
};

// ✅ Logger otimizado
const createLogger = (sessionId) => ({
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: (msg) => {
        if (process.env.NODE_ENV === 'development') {
            console.log(`[SESSION ${sessionId}][INFO]`, msg);
        }
    },
    warn: (msg) => console.warn(`[SESSION ${sessionId}][WARN]`, msg),
    error: (msg) => console.error(`[SESSION ${sessionId}][ERROR]`, msg),
    child: () => createLogger(sessionId)
});

// ✅ CORREÇÃO CRÍTICA: Usar useMultiFileAuthState (padrão do Baileys 6.7.18)
const getAuthState = async (sessionId) => {
    const authPath = path.join(AUTH_DIR, `session_${sessionId}`);

    try {
        await fs.mkdir(authPath, { recursive: true });
        return await useMultiFileAuthState(authPath);
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Auth state error:`, err.message);
        throw err;
    }
};

// ✅ Limpar auth state
const clearAuthState = async (sessionId) => {
    const authPath = path.join(AUTH_DIR, `session_${sessionId}`);

    try {
        await fs.rm(authPath, { recursive: true, force: true });
        console.log(`[SESSION ${sessionId}] Auth state cleared`);
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Clear auth error:`, err.message);
    }
};

// ✅ START SESSION - CORRIGIDO PARA 6.7.18
const startSession = async (sessionId, phoneNumber, method, attempt = 1) => {
    if (activeSessions.has(String(sessionId))) {
        const existing = activeSessions.get(String(sessionId));
        if (['connecting', 'open'].includes(existing.status)) {
            console.log(`[SESSION ${sessionId}] Already ${existing.status}`);
            return;
        }
    }

    console.log(`[SESSION ${sessionId}] Starting (${method}, attempt ${attempt})...`);

    try {
        const sessionEntry = {
            sock: null,
            method: method || 'qr',
            status: 'connecting',
            isActive: true,
            createdAt: Date.now(),
            lastError: null
        };
        activeSessions.set(String(sessionId), sessionEntry);

        // ✅ CORREÇÃO: Usar useMultiFileAuthState
        const { state, saveCreds } = await getAuthState(sessionId);

        // ✅ Verificar se há credenciais válidas
        const hasValidCreds = state.creds?.me?.id;

        if (hasValidCreds) {
            console.log(`[SESSION ${sessionId}] ✅ Found existing credentials`);
        } else {
            console.log(`[SESSION ${sessionId}] 🆕 Starting fresh connection`);
        }

        const { version } = await fetchLatestBaileysVersion();

        // ✅ CONFIGURAÇÃO OTIMIZADA PARA 6.7.18
        const waSocket = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            browser: ['PDVix Platform', 'Chrome', '120.0.0'],
            logger: createLogger(sessionId),

            // ✅ CRÍTICO: Configurações para evitar 428
            syncFullHistory: false,
            markOnlineOnConnect: false,
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,

            // ✅ getMessage otimizado
            getMessage: async (key) => {
                return { conversation: 'Mensagem não disponível' };
            },

            // ✅ Timeouts ajustados
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            qrTimeout: 60000,

            // ✅ Filtros
            shouldIgnoreJid: (jid) => {
                return jid.endsWith('@g.us') ||
                       jid.endsWith('@broadcast') ||
                       jid === 'status@broadcast';
            },

            // ✅ Retry config
            retryRequestDelayMs: 250,
            maxMsgRetryCount: 3,

            // ✅ NOVO: Link device config (importante para 6.7.18)
            linkPreviewImageThumbnailWidth: 192,
            transactionOpts: {
                maxCommitRetries: 3,
                delayBetweenTriesMs: 250
            }
        });

        sessionEntry.sock = waSocket;

        // ✅ EVENT: Salvar credenciais (CRÍTICO)
        waSocket.ev.on('creds.update', saveCreds);

        // ✅ EVENT: Connection
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;

            if (connection === 'connecting') {
                sessionEntry.status = 'connecting';
                console.log(`[SESSION ${sessionId}] 🔄 Connecting...`);
            }

            if (connection === 'open') {
                sessionEntry.status = 'open';
                sessionEntry.lastError = null;

                const userName = waSocket.user?.name || 'Unknown';
                const userId = waSocket.user?.id || 'Unknown';

                console.log(`[SESSION ${sessionId}] ✅ Connected as ${userName} (${userId})`);

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'connected',
                        whatsappName: userName,
                        whatsappId: userId,
                        isActive: true
                    }).catch((err) => {
                        console.error(`[SESSION ${sessionId}] Notify error:`, err.message);
                    });
                }
            }

            if (qr) {
                console.log(`[SESSION ${sessionId}] 📲 QR Code generated`);

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'awaiting_qr',
                        qrCode: qr
                    }).catch(() => {});
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                sessionEntry.status = 'disconnected';
                console.log(`[SESSION ${sessionId}] ❌ Closed (Code: ${statusCode})`);

                activeSessions.delete(String(sessionId));

                // ✅ CORREÇÃO: Limpar auth em casos específicos
                if ([DisconnectReason.loggedOut, 401, 403, 440].includes(statusCode)) {
                    console.log(`[SESSION ${sessionId}] 🗑️ Clearing auth state...`);
                    await clearAuthState(sessionId);
                }

                // ✅ CORREÇÃO: Retry apenas se não for logout
                if (shouldReconnect && attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
                    const delay = Math.min(SESSION_RESTORE_DELAY * Math.pow(2, attempt - 1), 30000);
                    console.log(`[SESSION ${sessionId}] ⏳ Retrying in ${delay}ms...`);

                    setTimeout(() => {
                        startSession(sessionId, phoneNumber, method, attempt + 1);
                    }, delay);
                }

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'disconnected',
                        reason: statusCode ? `Error ${statusCode}` : 'Unknown'
                    }).catch(() => {});
                }
            }
        });

        // ✅ EVENT: Mensagens
        waSocket.ev.on('messages.upsert', async (m) => {
            for (const msg of m.messages || []) {
                if (!msg?.key?.remoteJid || !msg.message || msg.key.fromMe) continue;

                const chatId = msg.key.remoteJid;
                if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast')) continue;

                if (sessionId !== PLATFORM_BOT_ID) {
                    updateConversationMetadata(sessionId, msg);

                    const cacheKey = `state:${chatId}`;
                    const { value: state } = await cacheManager.get('conversationState', cacheKey) || { value: {} };

                    if (!state.humanSupportUntil || new Date() >= new Date(state.humanSupportUntil)) {
                        await processMessage(msg, sessionId, waSocket, state);
                        await cacheManager.set('conversationState', cacheKey, state, INACTIVITY_PAUSE_MS / 1000);
                    }
                }

                forwardMessageToFastAPI(sessionId, msg, waSocket).catch(() => {});
            }
        });

        // ✅ PAIRING CODE
        if (method === 'pairing' && phoneNumber) {
            try {
                console.log(`[SESSION ${sessionId}] ⏳ Requesting pairing code...`);

                // ✅ CRÍTICO: Aguardar socket estar pronto
                await new Promise(resolve => setTimeout(resolve, 3000));

                const code = await waSocket.requestPairingCode(phoneNumber);
                const formatted = code.match(/.{1,4}/g).join('-');

                console.log(`[SESSION ${sessionId}] ✅ Pairing Code: ${formatted}`);

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'awaiting_pairing_code',
                        pairingCode: code
                    }).catch(() => {});
                }
            } catch (err) {
                console.error(`[SESSION ${sessionId}] Pairing error:`, err.message);
                sessionEntry.status = 'error';

                if (waSocket.end) {
                    waSocket.end(undefined);
                }

                await clearAuthState(sessionId);
                activeSessions.delete(String(sessionId));
            }
        }

    } catch (error) {
        console.error(`[SESSION ${sessionId}] CRITICAL ERROR:`, error.message);
        console.error(error.stack);

        const entry = activeSessions.get(String(sessionId));
        if (entry) {
            entry.status = 'error';
            entry.lastError = error.message;
        }

        if (attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
            const delay = Math.min(SESSION_RESTORE_DELAY * Math.pow(2, attempt - 1), 30000);
            setTimeout(() => startSession(sessionId, phoneNumber, method, attempt + 1), delay);
        }
    }
};

// ✅ DISCONNECT
const disconnectSession = async (sessionId) => {
    const session = activeSessions.get(String(sessionId));
    try {
        if (session?.sock) {
            session.sock.logout();
        }
        await clearAuthState(sessionId);
        activeSessions.delete(String(sessionId));

        if (sessionId !== PLATFORM_BOT_ID) {
            notifyFastAPI({ storeId: sessionId, status: 'disconnected' }).catch(() => {});
        }
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Disconnect error:`, err.message);
    }
};

// ✅ SEND MESSAGE
const sendMessage = async (sessionId, number, message, mediaUrl, mediaType, mediaFilename) => {
    const session = activeSessions.get(String(sessionId));
    if (!session?.sock || session.status !== 'open' || !session.sock.user) return false;

    try {
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

        if (result && sessionId !== PLATFORM_BOT_ID) {
            forwardMessageToFastAPI(sessionId, result, session.sock).catch(() => {});
        }

        return true;
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Send error:`, err.message);
        return false;
    }
};

// ✅ RESTORE SESSIONS
const restoreActiveSessions = async () => {
    if (isRestoringComplete) return;

    await ensureAuthDir();

    console.log('[RESTORE] 🔄 Starting...');

    try {
        const stores = await getStoresToReconnect();

        if (stores.length === 0) {
            console.log('[RESTORE] ℹ️ No stores to restore');
            isRestoringComplete = true;
            return;
        }

        console.log(`[RESTORE] Found ${stores.length} stores to restore`);

        for (const store of stores) {
            startSession(String(store.store_id), undefined, 'qr');
            await new Promise(resolve => setTimeout(resolve, SESSION_RESTORE_DELAY));
        }

        isRestoringComplete = true;
        console.log('[RESTORE] ✅ Complete');
    } catch (err) {
        console.error('[RESTORE] Error:', err.message);
        isRestoringComplete = true;
    }
};

// ✅ PAUSE CHAT
const pauseChatForHuman = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || session.status !== 'open') return false;

    const cacheKey = `state:${chatId}`;
    const { value: state } = await cacheManager.get('conversationState', cacheKey) || { value: {} };
    state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
    await cacheManager.set('conversationState', cacheKey, state, INACTIVITY_PAUSE_MS / 1000);

    return true;
};

// ✅ PROFILE PICTURE
const getProfilePictureUrl = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session?.sock || session.status !== 'open') return null;

    try {
        return await session.sock.profilePictureUrl(chatId, 'image');
    } catch {
        return null;
    }
};

// ✅ CONTACT NAME
const getContactName = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session?.sock || session.status !== 'open') return null;

    try {
        const [result] = await session.sock.onWhatsApp(chatId);
        return result?.exists ? result.jid.split('@')[0] : null;
    } catch {
        return null;
    }
};

// ✅ PLATFORM MESSAGE
const sendPlatformMessage = async (number, message) => {
    return await sendMessage(PLATFORM_BOT_ID, number, message, null, null, null);
};

// ✅ SHUTDOWN
const shutdown = async () => {
    console.log('[SHUTDOWN] 🛑 Starting...');

    const promises = [];
    for (const [storeId, session] of activeSessions.entries()) {
        if (session.sock && session.status === 'open') {
            promises.push(session.sock.end(undefined).catch(() => {}));
        }
    }

    await Promise.all(promises);
    activeSessions.clear();

    console.log('[SHUTDOWN] ✅ Complete');
};

// ✅ GET SOCKET
const getSocketForStore = (storeId) => {
    const session = activeSessions.get(String(storeId));
    return (session && session.sock && session.status === 'open') ? session.sock : null;
};

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
    getSocketForStore
};