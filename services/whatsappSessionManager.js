// services/whatsappSessionManager.js

import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { getStoresToReconnect, updateConversationMetadata } from './chatbotService.js';
import { notifyFastAPI } from '../utils/notifications.js';
import { processMessage } from '../controllers/chatbotController.js';
import { forwardMessageToFastAPI } from '../utils/forwarder.js';
import { cacheManager } from './cacheService.js';
import pool from '../config/database.js';

// Importa o módulo de gerenciamento de autenticação
import { getAuthState, clearAuthState, credsSaveTimers, ensureAuthDir } from './whatsappAuthManager.js';

// ============================================================
// 🔧 CONFIGURAÇÕES GLOBAIS E ESTADO
// ============================================================

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000; // 30 minutos
const MAX_RESTORE_ATTEMPTS = 3;
const SESSION_RESTORE_DELAY = 10000; // 10 segundos

let isRestoringComplete = false;

// ✅ ANTI-BAN: Delays e controles
const OPERATION_DELAY = 2000; // 2 segundos entre operações
const antiSpamDelay = () => new Promise(resolve => setTimeout(resolve, OPERATION_DELAY));

// ✅ DEDUPLICAÇÃO: Rastreamento de mensagens processadas
const processedMessages = new Map();
const MESSAGE_DEDUP_TTL = 60000; // 1 minuto

// ✅ Limpeza automática do Map de mensagens processadas
const cleanupProcessedMessages = () => {
    const now = Date.now();
    for (const [key, timestamp] of processedMessages.entries()) {
        if (now - timestamp > MESSAGE_DEDUP_TTL) {
            processedMessages.delete(key);
        }
    }
};
let processedCleanupRef = setInterval(cleanupProcessedMessages, 120000);

// ============================================================
// 🧹 FUNÇÕES DE LIMPEZA E UTILITÁRIAS
// ============================================================

/**
 * Cria logger personalizado com supressão de warnings desnecessários
 */
const createLogger = (sessionId) => ({
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (msg) => {
        const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
        if (msgStr.includes('myAppStateKeyId') || msgStr.includes('no name present')) {
            return;
        }
        console.warn(`[SESSION ${sessionId}][WARN]`, msgStr);
    },
    error: (msg) => {
        const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
        if (typeof msg === 'object' && msg?.node?.attrs?.code === '515') {
            return;
        }
        console.error(`[SESSION ${sessionId}][ERROR]`, msgStr);
    },
    child: () => createLogger(sessionId)
});

/**
 * Limpa todas as conversas e mensagens de uma loja
 */
const cleanupStoreConversations = async (storeId) => {
    const client = await pool.connect();
    try {
        console.log(`[CLEANUP] 🧹 Starting cleanup for store ${storeId}...`);

        // 1. Deletar mensagens
        await client.query('DELETE FROM chatbot_messages WHERE store_id = $1', [storeId]);
        // 2. Deletar metadados
        await client.query('DELETE FROM chatbot_conversation_metadata WHERE store_id = $1', [storeId]);
        // 3. Limpar cache
        await cacheManager.deletePattern('conversationState', `state:*`);

        // 4. Limpar mensagens processadas do Map
        for (const [key] of processedMessages.entries()) {
            if (key.startsWith(`${storeId}:`)) {
                processedMessages.delete(key);
            }
        }
        console.log(`[CLEANUP] ✅ Cleanup complete for store ${storeId}`);
        return true;

    } catch (err) {
        console.error(`[CLEANUP] ❌ Error cleaning store ${storeId}:`, err.message);
        return false;
    } finally {
        client.release();
    }
};


// ============================================================
// 🚀 FUNÇÃO PRINCIPAL: startSession
// ============================================================

/**
 * Inicia ou reconecta uma sessão do WhatsApp
 */
export const startSession = async (sessionId, phoneNumber, method, attempt = 1) => {
    if (activeSessions.has(String(sessionId))) {
        const existing = activeSessions.get(String(sessionId));
        if (['connecting', 'open'].includes(existing.status)) {
            console.log(`[SESSION ${sessionId}] Already ${existing.status}`);
            return;
        }
    }

    console.log(`[SESSION ${sessionId}] Starting (${method}, attempt ${attempt})...`);

    // ANTI-BAN: Delay entre tentativas
    if (attempt > 1) {
        await antiSpamDelay();
    }

    try {
        const sessionEntry = {
            sock: null,
            method: method || 'qr',
            status: 'connecting',
            isActive: true,
            createdAt: Date.now(),
            lastError: null,
            messageCount: 0,
            lastNotifiedStatus: null,
            connectionStabilizedAt: null,
            isNotifying: false
        };

        activeSessions.set(String(sessionId), sessionEntry);

        // 🟢 Utilizando o manager para obter o estado
        const { state, saveCreds } = await getAuthState(sessionId);
        const hasValidCreds = state.creds?.me?.id;

        if (hasValidCreds) {
            console.log(`[SESSION ${sessionId}] ✅ Found existing credentials`);
        } else {
            console.log(`[SESSION ${sessionId}] 🆕 Starting fresh connection`);
        }

        const { version } = await fetchLatestBaileysVersion();

        // ANTI-BAN: Configurações conservadoras
        const waSocket = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            browser: ['PDVix', 'Chrome', '120.0.0'],
            logger: createLogger(sessionId),

            // ANTI-BAN CRÍTICO
            syncFullHistory: false,
            markOnlineOnConnect: false,
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,

            getMessage: async (key) => ({ conversation: '' }),
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 45000,
            qrTimeout: 60000,

            // Filtros
            shouldIgnoreJid: (jid) => jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid === 'status@broadcast',

            retryRequestDelayMs: 500,
            maxMsgRetryCount: 2,
            linkPreviewImageThumbnailWidth: 192,
            transactionOpts: { maxCommitRetries: 2, delayBetweenTriesMs: 500 }
        });

        sessionEntry.sock = waSocket;

        // ============================================================
        // EVENT: Salvar credenciais (COM THROTTLE)
        // ============================================================
        waSocket.ev.on('creds.update', async () => {
            const sessionIdStr = String(sessionId);

            if (credsSaveTimers.has(sessionIdStr)) {
                clearTimeout(credsSaveTimers.get(sessionIdStr));
            }

            const timer = setTimeout(async () => {
                try {
                    await saveCreds();
                    credsSaveTimers.delete(sessionIdStr);
                } catch (err) {
                    console.error(`[SESSION ${sessionId}] Creds save error:`, err.message);
                }
            }, 1000);

            credsSaveTimers.set(sessionIdStr, timer);
        });

        // ============================================================
        // EVENT: Connection Update (LÓGICA DE RECONEXÃO E QR)
        // ============================================================
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (connection === 'connecting') {
                sessionEntry.status = 'connecting';
                console.log(`[SESSION ${sessionId}] 🔄 Connecting...`);
            }

            if (connection === 'open') {
                // ... (Lógica de conexão aberta e notificação - Manter)
                if (!waSocket.user?.id) return;
                if (sessionEntry.lastNotifiedStatus === 'open') return;

                sessionEntry.status = 'open';
                sessionEntry.lastError = null;
                sessionEntry.lastNotifiedStatus = 'open';
                sessionEntry.connectionStabilizedAt = Date.now();

                const userName = waSocket.user?.name || 'Unknown';
                const userId = waSocket.user?.id || 'Unknown';

                console.log(`[SESSION ${sessionId}] ✅ Connected as ${userName}`);
                await antiSpamDelay();

                if (sessionId !== PLATFORM_BOT_ID && !sessionEntry.isNotifying) {
                    sessionEntry.isNotifying = true;
                    notifyFastAPI({
                        storeId: sessionId, status: 'connected', whatsappName: userName, whatsappId: userId, isActive: true
                    }).catch((err) => {
                        console.error(`[SESSION ${sessionId}] Notify error:`, err.message);
                    }).finally(() => {
                        sessionEntry.isNotifying = false;
                    });
                }
            }

            if (qr) {
                // ... (Lógica de QR code e notificação - Manter)
                if (sessionEntry.lastNotifiedStatus !== 'awaiting_qr') {
                    console.log(`[SESSION ${sessionId}] 📲 QR Code generated`);
                    sessionEntry.lastNotifiedStatus = 'awaiting_qr';

                    if (sessionId !== PLATFORM_BOT_ID && !sessionEntry.isNotifying) {
                        sessionEntry.isNotifying = true;
                        notifyFastAPI({
                            storeId: sessionId, status: 'awaiting_qr', qrCode: qr
                        }).catch(() => {}).finally(() => {
                            sessionEntry.isNotifying = false;
                        });
                    }
                }
            }

            if (connection === 'close') {
                // ... (Lógica de desconexão, tratamento de erros e reconexão - Manter)
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                sessionEntry.status = 'disconnected';
                const shouldNotifyDisconnect = sessionEntry.lastNotifiedStatus === 'open';

                const errorMessages = { 401: 'Device removed - User logged out from phone', 403: 'Access forbidden', 440: 'Device logout', 428: 'Connection closed', 515: 'Rate limit exceeded', 503: 'Service unavailable' };
                const errorMsg = errorMessages[statusCode] || `Unknown error (${statusCode})`;
                console.log(`[SESSION ${sessionId}] ❌ Closed: ${errorMsg}`);

                const criticalErrors = [401, 403, 440, DisconnectReason.loggedOut];

                if (criticalErrors.includes(statusCode)) {
                    console.log(`[SESSION ${sessionId}] 🗑️ Critical error - cleaning up...`);
                    await Promise.all([ clearAuthState(sessionId), cleanupStoreConversations(sessionId) ]);
                    activeSessions.delete(String(sessionId));
                    if (sessionId !== PLATFORM_BOT_ID && shouldNotifyDisconnect) {
                        notifyFastAPI({ storeId: sessionId, status: 'disconnected', reason: errorMsg, requiresManualReconnection: true }).catch(() => {});
                    }
                    return;
                }

                if (statusCode === 515) {
                    console.log(`[SESSION ${sessionId}] ⏳ Rate limit - waiting 60s before retry`);
                    if (attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
                        activeSessions.delete(String(sessionId));
                        setTimeout(() => startSession(sessionId, phoneNumber, method, attempt + 1), 60000);
                    }
                    return;
                }

                if (shouldReconnect && attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
                    let delay = SESSION_RESTORE_DELAY * Math.pow(2, attempt - 1);
                    delay = Math.min(delay, 120000);

                    console.log(`[SESSION ${sessionId}] ⏳ Retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${MAX_RESTORE_ATTEMPTS})`);
                    activeSessions.delete(String(sessionId));
                    setTimeout(() => startSession(sessionId, phoneNumber, method, attempt + 1), delay);
                } else {
                    console.log(`[SESSION ${sessionId}] ⛔ Max retries reached or not reconnectable`);
                    activeSessions.delete(String(sessionId));
                }

                if (sessionId !== PLATFORM_BOT_ID && shouldNotifyDisconnect && !sessionEntry.isNotifying) {
                    sessionEntry.isNotifying = true;
                    notifyFastAPI({
                        storeId: sessionId, status: 'disconnected', reason: errorMsg, willRetry: shouldReconnect && attempt < MAX_RESTORE_ATTEMPTS
                    }).catch(() => {}).finally(() => {
                        sessionEntry.isNotifying = false;
                    });
                }
            }
        });


        // ============================================================
        // EVENT: Mensagens Recebidas (COM DEDUPLICAÇÃO)
        // ============================================================
        waSocket.ev.on('messages.upsert', async (m) => {
            for (const msg of m.messages || []) {
                if (!msg?.key?.remoteJid || !msg.message || msg.key.fromMe) continue;

                const chatId = msg.key.remoteJid;
                const messageId = msg.key.id;

                if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast') || chatId === 'status@broadcast') continue;

                const dedupKey = `${sessionId}:${chatId}:${messageId}`;
                if (processedMessages.has(dedupKey)) {
                    console.log(`[SESSION ${sessionId}] ⏭️ Skipping duplicate message: ${messageId}`);
                    continue;
                }

                const messageTimestamp = msg.messageTimestamp * 1000;
                const messageAge = Date.now() - messageTimestamp;

                if (messageAge > 5 * 60 * 1000) {
                    processedMessages.set(dedupKey, Date.now());
                    continue;
                }

                const hasContent = msg.message?.conversation ||
                                  msg.message?.extendedTextMessage?.text ||
                                  msg.message?.imageMessage ||
                                  msg.message?.audioMessage ||
                                  msg.message?.videoMessage ||
                                  msg.message?.documentMessage;

                if (!hasContent) continue;

                processedMessages.set(dedupKey, Date.now());

                sessionEntry.messageCount++;
                if (sessionEntry.messageCount > 50) {
                    await antiSpamDelay();
                    sessionEntry.messageCount = 0;
                }

                if (sessionId !== PLATFORM_BOT_ID) {
                    updateConversationMetadata(sessionId, msg).catch((err) => {
                        console.error(`[SESSION ${sessionId}] Metadata update failed:`, err.message);
                    });

                    const cacheKey = `state:${chatId}`;
                    let stateResult = await cacheManager.get('conversationState', cacheKey);
                    let state = stateResult?.value || {};

                    if (!state.humanSupportUntil || new Date() >= new Date(state.humanSupportUntil)) {
                        await processMessage(msg, sessionId, waSocket, state).catch(err => {
                            console.error(`[SESSION ${sessionId}] Message processing error:`, err.message);
                        });
                        await cacheManager.set('conversationState', cacheKey, state, INACTIVITY_PAUSE_MS / 1000);
                    }
                }

                forwardMessageToFastAPI(sessionId, msg, waSocket).catch((err) => {
                    console.error(`[SESSION ${sessionId}] Forward failed for ${messageId}:`, err.message);
                });
            }
        });

        // ============================================================
        // PAIRING CODE (se método for 'pairing')
        // ============================================================
        if (method === 'pairing' && phoneNumber) {
            // ... (Lógica de pairing code - Manter)
            try {
                await antiSpamDelay();
                const code = await waSocket.requestPairingCode(phoneNumber);
                const formatted = code.match(/.{1,4}/g).join('-');

                console.log(`[SESSION ${sessionId}] ✅ Pairing Code: ${formatted}`);

                if (sessionId !== PLATFORM_BOT_ID && !sessionEntry.isNotifying) {
                    sessionEntry.isNotifying = true;
                    notifyFastAPI({
                        storeId: sessionId, status: 'awaiting_pairing_code', pairingCode: code
                    }).catch(() => {}).finally(() => {
                        sessionEntry.isNotifying = false;
                    });
                }
            } catch (err) {
                console.error(`[SESSION ${sessionId}] Pairing error:`, err.message);
                sessionEntry.status = 'error';
                if (waSocket.end) waSocket.end(undefined);
                await clearAuthState(sessionId);
                activeSessions.delete(String(sessionId));
            }
        }

    } catch (error) {
        console.error(`[SESSION ${sessionId}] CRITICAL ERROR:`, error.message);
        const entry = activeSessions.get(String(sessionId));
        if (entry) {
            entry.status = 'error';
            entry.lastError = error.message;
        }

        if (attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
            const delay = Math.min(SESSION_RESTORE_DELAY * Math.pow(2, attempt - 1), 120000);
            setTimeout(() => startSession(sessionId, phoneNumber, method, attempt + 1), delay);
        }
    }
};

// ============================================================
// 📦 FUNÇÕES DE EXPORTAÇÃO E CONTROLE
// ============================================================

/**
 * Desconecta uma sessão e limpa todos os dados
 */
export const disconnectSession = async (sessionId) => {
    const session = activeSessions.get(String(sessionId));
    try {
        if (session?.sock) {
            session.sock.logout();
        }
        await cleanupStoreConversations(sessionId);
        await clearAuthState(sessionId);
        activeSessions.delete(String(sessionId));

        if (sessionId !== PLATFORM_BOT_ID) {
            notifyFastAPI({ storeId: sessionId, status: 'disconnected' }).catch(() => {});
        }
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Disconnect error:`, err.message);
    }
};

/**
 * Restaura todas as sessões ativas do banco
 */
export const restoreActiveSessions = async () => {
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
            // ✅ CORREÇÃO: Usar 'qr' como método padrão para restauração
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

/**
 * Shutdown graceful de todas as sessões
 */
export const shutdown = async () => {
    console.log('[SHUTDOWN] 🛑 Starting...');

    for (const timer of credsSaveTimers.values()) {
        clearTimeout(timer);
    }
    credsSaveTimers.clear();

    if (processedCleanupRef) {
        clearInterval(processedCleanupRef);
        processedCleanupRef = null;
    }
    processedMessages.clear();

    const promises = [];
    for (const [storeId, session] of activeSessions.entries()) {
        if (session.sock && session.status === 'open') {
            promises.push(session.sock.end(undefined).catch(() => {}));
        }
        if (session.sock?.ev?.removeAllListeners) {
            session.sock.ev.removeAllListeners('creds.update');
            session.sock.ev.removeAllListeners('connection.update');
            session.sock.ev.removeAllListeners('messages.upsert');
        }
    }

    await Promise.all(promises);
    activeSessions.clear();

    console.log('[SHUTDOWN] ✅ Complete');
};

/**
 * Obtém socket de uma loja específica
 */
export const getSocketForStore = (storeId) => {
    const session = activeSessions.get(String(storeId));
    return (session && session.sock && session.status === 'open') ? session.sock : null;
};

// ============================================================
// 📤 EXPORTS
// ============================================================

export default {
    activeSessions,
    startSession,
    disconnectSession,
    restoreActiveSessions,
    shutdown,
    getSocketForStore,
    PLATFORM_BOT_ID,
    INACTIVITY_PAUSE_MS
};