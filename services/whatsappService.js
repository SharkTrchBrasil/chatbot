import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState
} from '@whiskeysockets/baileys';

import { getStoresToReconnect, updateConversationMetadata } from './chatbotService.js';
import { notifyFastAPI } from '../utils/notifications.js';
import { processMessage } from '../controllers/chatbotController.js';
import { forwardMessageToFastAPI } from '../utils/forwarder.js';
import { conversationStateManager } from './cacheService.js';

import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;

const sessionMethods = new Map();
let isRestoringComplete = false; // ✅ NOVO: Flag de restauração

// ✅ CORREÇÃO: Auth State com validação
const createAuthStateFromDB = (sessionId) => {
    const authState = {
        state: {
            creds: undefined,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        const value = await authDB.read(sessionId, key);
                        if (value) data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(authDB.write(sessionId, key, value));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            if (authState.state.creds) {
                await authDB.write(sessionId, 'creds', authState.state.creds);
            }
        }
    };

    return authState;
};

// Operações de autenticação
const authDB = {
    read: async (sessionId, key) => {
        try {
            const query = 'SELECT cred_value FROM chatbot_auth_credentials WHERE session_id = $1 AND cred_id = $2';
            const { rows } = await pool.query(query, [sessionId, key]);
            if (rows.length > 0) {
                return JSON.parse(rows[0].cred_value);
            }
            return null;
        } catch (e) {
            console.error(`[AUTH DB] ❌ Failed to read key ${key} for session ${sessionId}`, e);
            return null;
        }
    },
    write: async (sessionId, key, value) => {
        try {
            const valueStr = JSON.stringify(value);
            const query = `
                INSERT INTO chatbot_auth_credentials (session_id, cred_id, cred_value)
                VALUES ($1, $2, $3)
                ON CONFLICT (session_id, cred_id)
                DO UPDATE SET cred_value = EXCLUDED.cred_value, updated_at = CURRENT_TIMESTAMP;
            `;
            await pool.query(query, [sessionId, key, valueStr]);
        } catch (e) {
            console.error(`[AUTH DB] ❌ Failed to write key ${key} for session ${sessionId}`, e);
        }
    },
    clearAll: async (sessionId) => {
        try {
            console.log(`[AUTH DB] 🗑️ Removing all credentials for session ${sessionId}`);
            const query = 'DELETE FROM chatbot_auth_credentials WHERE session_id = $1';
            await pool.query(query, [sessionId]);
        } catch (e) {
            console.error(`[AUTH DB] ❌ Failed to clear session ${sessionId}`, e);
        }
    }
};

// Logger customizado
const createLogger = (sessionId) => {
    const logger = {
        level: 'silent',
        trace: () => {},
        debug: () => {},
        info: (msg) => console.log(`[SESSION ${sessionId}][INFO]`, msg),
        warn: (msg) => console.warn(`[SESSION ${sessionId}][WARN]`, msg),
        error: (msg) => console.error(`[SESSION ${sessionId}][ERROR]`, msg),
    };
    logger.child = () => logger;
    return logger;
};

// ✅ CORREÇÃO: Iniciar sessão com validações robustas
const startSession = async (sessionId, phoneNumber, method) => {
    if (activeSessions.has(String(sessionId))) {
        console.log(`[SESSION ${sessionId}] ⚠️ Session already exists. Skipping.`);
        return;
    }

    if (!method) {
        method = sessionMethods.get(String(sessionId)) || 'qr';
    } else {
        sessionMethods.set(String(sessionId), method);
    }

    console.log(`[SESSION ${sessionId}] Starting connection (method: ${method})...`);

    try {
        const authState = createAuthStateFromDB(sessionId);
        const savedCreds = await authDB.read(sessionId, 'creds');

        // ✅ VALIDAÇÃO: Credenciais devem ter estrutura mínima
        if (savedCreds && savedCreds.noiseKey && savedCreds.signedIdentityKey) {
            authState.state.creds = savedCreds;
            console.log(`[SESSION ${sessionId}] ✅ Loaded credentials from DB`);
        } else if (savedCreds) {
            console.log(`[SESSION ${sessionId}] ⚠️ Incomplete credentials. Starting fresh.`);
            await authDB.clearAll(sessionId);
        }

        const waSocket = makeWASocket({
            auth: authState.state,
            printQRInTerminal: false, // ✅ CORREÇÃO: Desabilitar deprecated option
            browser: ['PDVix Platform', 'Chrome', '1.0.0'],
            logger: createLogger(sessionId),
            markOnlineOnConnect: true,
            syncFullHistory: false,
            defaultQueryTimeoutMs: undefined,
            keepAliveIntervalMs: 30000,
        });

        const clearCreds = () => authDB.clearAll(sessionId);

        activeSessions.set(String(sessionId), {
            sock: waSocket,
            method,
            status: 'connecting',
            clearCreds,
            isActive: true
        });

        const isPlatformBot = sessionId === PLATFORM_BOT_ID;

        // Salvar credenciais quando atualizadas
        waSocket.ev.on('creds.update', authState.saveCreds);

        // ✅ CORREÇÃO: Gerenciar conexão com mais estados
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;
            const session = activeSessions.get(String(sessionId));

            if (connection === 'connecting') {
                console.log(`[SESSION ${sessionId}] 🔄 Connecting...`);
                if (session) session.status = 'connecting';
            }

            if (connection === 'open') {
                console.log(`[SESSION ${sessionId}] ✅ Connected! User: ${waSocket.user?.name || 'Unknown'}`);
                if (session) session.status = 'open';

                if (!isPlatformBot) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'connected',
                        whatsappName: waSocket.user?.name || 'Unknown',
                        whatsappId: waSocket.user?.id,
                        isActive: true
                    });
                }
            }

            // ✅ CORREÇÃO: Enviar QR via evento
            if (qr && method === 'qr') {
                console.log(`[SESSION ${sessionId}] 📱 QR Code generated`);
                if (!isPlatformBot) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'awaiting_qr',
                        qrCode: qr
                    });
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`[SESSION ${sessionId}] ❌ Connection closed. Code: ${statusCode}`);
                activeSessions.delete(String(sessionId));

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[SESSION ${sessionId}] 🚪 User logged out. Clearing DB...`);
                    await clearCreds();
                    sessionMethods.delete(String(sessionId));
                    if (!isPlatformBot) notifyFastAPI({ storeId: sessionId, status: 'disconnected' });
                } else if ([401, 403, 405, 440].includes(statusCode)) {
                    console.log(`[SESSION ${sessionId}] 🔐 Auth error. Clearing credentials...`);
                    await clearCreds();
                    sessionMethods.delete(String(sessionId));
                    if (!isPlatformBot) {
                        notifyFastAPI({
                            storeId: sessionId,
                            status: 'disconnected',
                            error: 'Authentication failed'
                        });
                    }
                } else if (shouldReconnect) {
                    console.log(`[SESSION ${sessionId}] 🔄 Reconnecting in 5s...`);
                    setTimeout(() => {
                        const storedMethod = sessionMethods.get(String(sessionId)) || 'qr';
                        startSession(sessionId, phoneNumber, storedMethod);
                    }, 5000);
                }
            }
        });

        // Solicitar código de pareamento
        if (method === 'pairing' && phoneNumber) {
            try {
                console.log(`[SESSION ${sessionId}] Requesting pairing code for ${phoneNumber}...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                const code = await waSocket.requestPairingCode(phoneNumber);
                const formattedCode = code.match(/.{1,4}/g).join('-');
                console.log(`[SESSION ${sessionId}] ✅ Pairing Code: ${formattedCode}`);
                notifyFastAPI({
                    storeId: sessionId,
                    status: 'awaiting_pairing_code',
                    pairingCode: code
                });
            } catch (e) {
                console.error(`[SESSION ${sessionId}] ❌ Failed to request pairing code:`, e);
                waSocket.end();
                await clearCreds();
                notifyFastAPI({ storeId: sessionId, status: 'error' });
            }
        }

        // ✅ CORREÇÃO: Processar mensagens com validação
        waSocket.ev.on('messages.upsert', async (m) => {
            const receivedMessages = m.messages;

            for (const msg of receivedMessages) {
                // ✅ Validar estrutura da mensagem
                if (!msg || !msg.key || !msg.message) continue;
                if (msg.key.fromMe || !msg.message) continue;

                const chatId = msg.key.remoteJid;

                // ✅ Filtros de segurança
                if (!chatId ||
                    chatId === 'status@broadcast' ||
                    chatId.endsWith('@g.us') ||
                    chatId.endsWith('@broadcast')) {
                    continue;
                }

                // Atualizar metadata
                if (!isPlatformBot) {
                    updateConversationMetadata(sessionId, msg);
                }

                // ✅ CORREÇÃO: Verificar pausa usando state manager
                const state = conversationStateManager.get(chatId) || {};

                if (state.humanSupportUntil && new Date() < new Date(state.humanSupportUntil)) {
                    console.log(`[SESSION ${sessionId}] Chat ${chatId} paused for human support`);
                    continue;
                }

                if (!isPlatformBot) {
                    // ✅ SEGURANÇA: Validar socket está pronto antes de processar
                    if (!waSocket.user || !waSocket.user.id) {
                        console.warn(`[SESSION ${sessionId}] Socket not ready. Skipping message.`);
                        continue;
                    }

                    await processMessage(msg, sessionId, waSocket, state);
                    conversationStateManager.set(chatId, state);
                }
            }
        });

    } catch (error) {
        console.error(`[SESSION ${sessionId}] ❌ CRITICAL ERROR starting session:`, error);
        activeSessions.delete(String(sessionId));
        notifyFastAPI({ storeId: sessionId, status: 'error', error: error.message });
    }
};

// Desconectar sessão
const disconnectSession = async (sessionId) => {
    const session = activeSessions.get(String(sessionId));
    if (session?.sock) {
        await session.sock.logout();
    } else {
        await authDB.clearAll(sessionId);
        const isPlatformBot = sessionId === PLATFORM_BOT_ID;
        if (!isPlatformBot) {
            notifyFastAPI({ storeId: sessionId, status: 'disconnected' });
        }
    }
};

// ✅ CORREÇÃO: Enviar mensagem com validações
const sendMessage = async (sessionId, number, message, mediaUrl, mediaType, mediaFilename, isPlatform = false) => {
    const logPrefix = isPlatform ? '[PLATFORM BOT]' : `[SESSION ${sessionId}]`;
    const session = activeSessions.get(String(sessionId));

    // ✅ VALIDAÇÃO: Socket deve estar pronto E ter user
    if (!session || !session.sock || session.status !== 'open') {
        console.warn(`${logPrefix} ⚠️ Session not connected. Status: ${session?.status || 'not found'}`);
        return false;
    }

    // ✅ VALIDAÇÃO CRÍTICA: Aguardar user estar disponível
    if (!session.sock.user || !session.sock.user.id) {
        console.warn(`${logPrefix} ⚠️ Socket user not initialized yet. Waiting...`);
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!session.sock.user || !session.sock.user.id) {
            console.error(`${logPrefix} ❌ Socket user still not ready. Aborting send.`);
            return false;
        }
    }

    try {
        const chatId = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        let messagePayload;

        if (mediaType === 'image' && mediaUrl) {
            messagePayload = { image: { url: mediaUrl }, caption: message };
        } else if (mediaType === 'audio' && mediaUrl) {
            messagePayload = { audio: { url: mediaUrl }, ptt: true };
        } else if (mediaType === 'document' && mediaUrl) {
            messagePayload = {
                document: { url: mediaUrl },
                fileName: mediaFilename || 'documento.pdf',
                caption: message
            };
        } else {
            messagePayload = { text: message };
        }

        const result = await session.sock.sendMessage(chatId, messagePayload);

        // ✅ CORREÇÃO: Só encaminhar se não for plataforma E result existir
        if (result && !isPlatform) {
            // ✅ Não aguardar para não bloquear
            forwardMessageToFastAPI(sessionId, result, session.sock).catch(err => {
                console.error(`${logPrefix} Failed to forward message:`, err.message);
            });
        }

        return true;
    } catch (e) {
        console.error(`${logPrefix} ❌ ERROR sending message to ${number}:`, e);
        return false;
    }
};

// ✅ CORREÇÃO: Restaurar sessões com flag de controle
const restoreActiveSessions = async () => {
    if (isRestoringComplete) {
        console.log('[RESTORE] ⚠️ Already restored. Skipping.');
        return;
    }

    console.log('[RESTORE] 🔄 Starting session restoration...');

    try {
        const storesToReconnect = await getStoresToReconnect();

        if (storesToReconnect.length === 0) {
            console.log('[RESTORE] ℹ️ No sessions to restore.');
            isRestoringComplete = true;
            return;
        }

        console.log(`[RESTORE] Found ${storesToReconnect.length} session(s) to restore`);

        // ✅ Restaurar com delay entre sessões
        for (const store of storesToReconnect) {
            console.log(`[RESTORE] Restoring session for store ${store.store_id}...`);
            startSession(String(store.store_id), undefined, undefined);

            // ✅ Delay de 2s entre cada sessão
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        isRestoringComplete = true;
        console.log('[RESTORE] ✅ Session restoration completed');
    } catch (e) {
        console.error('[RESTORE] ❌ Error during restoration:', e);
        isRestoringComplete = true; // Marcar como completo mesmo com erro
    }
};

// Pausar chat para suporte humano
const pauseChatForHuman = (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));

    if (!session || session.status !== 'open') {
        console.warn(`[STORE ${storeId}] Cannot pause chat. Session not connected.`);
        return false;
    }

    // ✅ CORREÇÃO: Usar state manager
    const state = conversationStateManager.get(chatId) || {};
    state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
    conversationStateManager.set(chatId, state);

    console.log(`[STORE ${storeId}] ✅ Chat ${chatId} paused for 30 minutes`);
    return true;
};

// Obter URL da foto de perfil
const getProfilePictureUrl = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));

    if (!session || !session.sock || session.status !== 'open') {
        console.warn(`[STORE ${storeId}] Cannot get profile picture. Session not connected.`);
        return null;
    }

    try {
        const url = await session.sock.profilePictureUrl(chatId, 'image');
        return url;
    } catch (e) {
        console.log(`[STORE ${storeId}] Profile picture not found for ${chatId}`);
        return null;
    }
};

// ✅ CORREÇÃO: getContactName com fallback seguro
const getContactName = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));

    if (!session || !session.sock || session.status !== 'open') {
        return null;
    }

    try {
        const [result] = await session.sock.onWhatsApp(chatId);
        if (result && result.exists) {
            return result.jid.split('@')[0];
        }
        return null;
    } catch (e) {
        console.log(`[STORE ${storeId}] Could not fetch contact for ${chatId}`);
        return null;
    }
};

// Enviar mensagem da plataforma
const sendPlatformMessage = async (number, message) => {
    console.log(`[PLATFORM BOT] Sending message to ${number}`);
    return await sendMessage(PLATFORM_BOT_ID, number, message, null, null, null, true);
};

// ✅ CORREÇÃO: Shutdown com graceful period
const shutdown = async () => {
    console.log('\n[SHUTDOWN] 🛑 Initiating graceful shutdown...');

    // ✅ Aguardar sessões em inicialização
    if (!isRestoringComplete) {
        console.log('[SHUTDOWN] ⏳ Waiting for session restoration to complete...');
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const promises = [];
    for (const [storeId, session] of activeSessions.entries()) {
        if (session.sock && session.status === 'open') {
            console.log(`[SHUTDOWN] Closing session ${storeId}...`);
            promises.push(
                session.sock.end(new Error('Server Shutdown'))
                    .catch(err => console.error(`[SHUTDOWN] Error closing ${storeId}:`, err))
            );
        }
    }

    await Promise.all(promises);
    console.log('[SHUTDOWN] ✅ All sessions closed');
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
    getContactName
};