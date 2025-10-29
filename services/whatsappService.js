import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

import { getStoresToReconnect, updateConversationMetadata } from './chatbotService.js';
import { notifyFastAPI } from '../utils/notifications.js';
import { processMessage } from '../controllers/chatbotController.js';
import { forwardMessageToFastAPI } from '../utils/forwarder.js';
import { conversationStateManager } from './cacheService.js';

import pg from 'pg';
const { Pool } = pg;

// ✅ Pool centralizado
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;
const MAX_RESTORE_ATTEMPTS = 3;
const SESSION_RESTORE_DELAY = 3000;

let isRestoringComplete = false;

// ✅ VALIDAÇÃO: Estrutura mínima de credenciais
const isValidCredentials = (creds) => {
    if (!creds || typeof creds !== 'object') return false;

    // ✅ Verificar campos obrigatórios do Baileys
    return (
        creds.noiseKey &&
        creds.noiseKey.private &&
        creds.noiseKey.public &&
        creds.signedIdentityKey &&
        creds.signedIdentityKey.private &&
        creds.signedIdentityKey.public &&
        creds.signedPreKey &&
        creds.signedPreKey.keyPair &&
        creds.me &&
        creds.me.id
    );
};

// ✅ SEGURANÇA: Sanitizar dados de credenciais antes de salvar
const sanitizeCredentials = (creds) => {
    if (!creds) return null;

    return {
        noiseKey: creds.noiseKey,
        signedIdentityKey: creds.signedIdentityKey,
        signedPreKey: creds.signedPreKey,
        registrationId: creds.registrationId,
        advSecretKey: creds.advSecretKey,
        processedHistoryMessages: creds.processedHistoryMessages || [],
        nextPreKeyId: creds.nextPreKeyId,
        firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
        accountSettings: creds.accountSettings,
        accountSyncCounter: creds.accountSyncCounter,
        accountLocked: creds.accountLocked,
        deviceId: creds.deviceId,
        phoneId: creds.phoneId,
        identityId: creds.identityId,
        registered: creds.registered,
        lastDisconnectReason: creds.lastDisconnectReason,
        platform: creds.platform,
        me: creds.me,
        signalIdentities: creds.signalIdentities || [],
        myACV: creds.myACV || {},
        lastAccountSyncTimestamp: creds.lastAccountSyncTimestamp
    };
};

// ✅ ROBUSTEZ: Sistema de autenticação com validação rigorosa
const authDB = {
    read: async (sessionId, key) => {
        const client = await pool.connect();
        try {
            const query = 'SELECT cred_value FROM chatbot_auth_credentials WHERE session_id = $1 AND cred_id = $2';
            const { rows } = await client.query(query, [sessionId, key]);

            if (rows.length === 0) return null;

            try {
                const parsed = JSON.parse(rows[0].cred_value);

                // ✅ CRÍTICO: Validar estrutura se for creds completo
                if (key === 'creds' && !isValidCredentials(parsed)) {
                    console.warn(`[AUTH DB] Invalid credentials structure for session ${sessionId}. Clearing.`);
                    await this.clearAll(sessionId);
                    return null;
                }

                return parsed;
            } catch (parseErr) {
                console.error(`[AUTH DB] Failed to parse credentials for ${sessionId}:${key}`, parseErr.message);
                return null;
            }
        } catch (err) {
            console.error(`[AUTH DB] Read error for session ${sessionId}:`, err.message);
            return null;
        } finally {
            client.release();
        }
    },

    write: async (sessionId, key, value) => {
        const client = await pool.connect();
        try {
            // ✅ SEGURANÇA: Sanitizar credenciais antes de salvar
            const sanitized = key === 'creds' ? sanitizeCredentials(value) : value;

            if (!sanitized) {
                console.warn(`[AUTH DB] Refusing to save invalid data for ${sessionId}:${key}`);
                return false;
            }

            const valueStr = JSON.stringify(sanitized);

            // ✅ LIMITE: Não permitir valores gigantes
            if (valueStr.length > 5 * 1024 * 1024) {
                console.error(`[AUTH DB] Credential data too large for ${sessionId}`);
                return false;
            }

            const query = `
                INSERT INTO chatbot_auth_credentials (session_id, cred_id, cred_value)
                VALUES ($1, $2, $3)
                ON CONFLICT (session_id, cred_id)
                DO UPDATE SET cred_value = EXCLUDED.cred_value, updated_at = CURRENT_TIMESTAMP
                WHERE EXCLUDED.cred_value != chatbot_auth_credentials.cred_value;
            `;

            await client.query(query, [sessionId, key, valueStr]);
            return true;
        } catch (err) {
            console.error(`[AUTH DB] Write error for ${sessionId}:${key}`, err.message);
            return false;
        } finally {
            client.release();
        }
    },

    clearAll: async (sessionId) => {
        const client = await pool.connect();
        try {
            console.log(`[AUTH DB] 🗑️ Removing all credentials for session ${sessionId}`);
            const query = 'DELETE FROM chatbot_auth_credentials WHERE session_id = $1';
            await client.query(query, [sessionId]);
            return true;
        } catch (err) {
            console.error(`[AUTH DB] Clear error for session ${sessionId}:`, err.message);
            return false;
        } finally {
            client.release();
        }
    }
};

// ✅ Logger com níveis apropriados
const createLogger = (sessionId) => {
    return {
        level: 'silent',
        trace: () => {},
        debug: () => {},
        info: (msg) => console.log(`[SESSION ${sessionId}][INFO]`, msg),
        warn: (msg) => console.warn(`[SESSION ${sessionId}][WARN]`, msg),
        error: (msg) => console.error(`[SESSION ${sessionId}][ERROR]`, msg),
        child: () => createLogger(sessionId)
    };
};

// ✅ CRÍTICO: Criar auth state com validação
const createAuthStateFromDB = (sessionId) => {
    const authState = {
        state: {
            creds: undefined,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        try {
                            const value = await authDB.read(sessionId, key);
                            if (value) data[id] = value;
                        } catch (err) {
                            console.error(`[AUTH] Failed to read key ${key}:`, err.message);
                        }
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
            try {
                if (authState.state.creds) {
                    await authDB.write(sessionId, 'creds', authState.state.creds);
                }
            } catch (err) {
                console.error(`[AUTH] Failed to save creds for ${sessionId}:`, err.message);
            }
        }
    };

    return authState;
};

// ✅ Iniciar sessão com validações rigorosas
const startSession = async (sessionId, phoneNumber, method, attempt = 1) => {
    if (activeSessions.has(String(sessionId))) {
        const existing = activeSessions.get(String(sessionId));
        if (['connecting', 'open'].includes(existing.status)) {
            console.log(`[SESSION ${sessionId}] ⚠️ Session already exists with status: ${existing.status}`);
            return;
        }
    }

    console.log(`[SESSION ${sessionId}] Starting connection (method: ${method}, attempt: ${attempt})...`);

    try {
        // ✅ Criar session entry imediatamente
        const sessionEntry = {
            sock: null,
            method: method || 'qr',
            status: 'connecting',
            isActive: true,
            createdAt: Date.now(),
            lastError: null
        };
        activeSessions.set(String(sessionId), sessionEntry);

        const authState = createAuthStateFromDB(sessionId);
        const savedCreds = await authDB.read(sessionId, 'creds');

        // ✅ CRÍTICO: Validar credenciais salvas
        if (savedCreds) {
            if (isValidCredentials(savedCreds)) {
                authState.state.creds = savedCreds;
                console.log(`[SESSION ${sessionId}] ✅ Loaded valid credentials from DB`);
            } else {
                console.warn(`[SESSION ${sessionId}] ⚠️ Credentials in DB are invalid. Starting fresh.`);
                await authDB.clearAll(sessionId);
                authState.state.creds = undefined;
            }
        }

        // ✅ TIMEOUT: Detectar travamento na criação do socket
        const socketTimeout = setTimeout(() => {
            console.error(`[SESSION ${sessionId}] ❌ Socket creation timeout (30s)`);
            sessionEntry.lastError = 'Socket creation timeout';
            sessionEntry.status = 'error';
        }, 30000);

        let waSocket;
        try {
            waSocket = makeWASocket({
                auth: authState.state,
                printQRInTerminal: false,
                browser: ['PDVix Platform', 'Chrome', '1.0.0'],
                logger: createLogger(sessionId),
                markOnlineOnConnect: true,
                syncFullHistory: false,
                defaultQueryTimeoutMs: 10000,
                keepAliveIntervalMs: 30000,
                maxMsgsInChatBefore: 100,
                connectTimeoutMs: 60000
            });

            clearTimeout(socketTimeout);
        } catch (createErr) {
            clearTimeout(socketTimeout);
            throw new Error(`Failed to create socket: ${createErr.message}`);
        }

        sessionEntry.sock = waSocket;

        // ✅ Event: Credenciais atualizadas
        waSocket.ev.on('creds.update', async (update) => {
            try {
                authState.state.creds = update;
                await authState.saveCreds();
            } catch (err) {
                console.error(`[SESSION ${sessionId}] Failed to save credential update:`, err.message);
            }
        });

        // ✅ Event: Atualização de conexão
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (connection === 'connecting') {
                sessionEntry.status = 'connecting';
                console.log(`[SESSION ${sessionId}] 📡 Connecting...`);
            }

            if (connection === 'open') {
                sessionEntry.status = 'open';
                sessionEntry.lastError = null;
                console.log(`[SESSION ${sessionId}] ✅ Connected! User: ${waSocket.user?.name || 'Unknown'}`);

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'connected',
                        whatsappName: waSocket.user?.name || 'Unknown',
                        whatsappId: waSocket.user?.id,
                        isActive: true
                    }).catch(err => console.error('Failed to notify API:', err.message));
                }
            }

            if (qr) {
                console.log(`[SESSION ${sessionId}] 🔲 QR Code generated`);
                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'awaiting_qr',
                        qrCode: qr
                    }).catch(err => console.error('Failed to notify API:', err.message));
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                sessionEntry.status = 'disconnected';
                sessionEntry.lastError = `Connection closed. Code: ${statusCode}`;

                console.log(`[SESSION ${sessionId}] ❌ Connection closed. Code: ${statusCode}`);
                activeSessions.delete(String(sessionId));

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut &&
                                       statusCode !== 401 &&
                                       statusCode !== 403;

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[SESSION ${sessionId}] 🚪 User logged out. Clearing.`);
                    await authDB.clearAll(sessionId);
                    if (sessionId !== PLATFORM_BOT_ID) {
                        notifyFastAPI({ storeId: sessionId, status: 'disconnected' })
                            .catch(e => console.error('Notify failed:', e.message));
                    }
                } else if ([401, 403, 405, 440].includes(statusCode)) {
                    console.log(`[SESSION ${sessionId}] 🔐 Auth error. Clearing credentials.`);
                    await authDB.clearAll(sessionId);
                    if (sessionId !== PLATFORM_BOT_ID) {
                        notifyFastAPI({
                            storeId: sessionId,
                            status: 'disconnected',
                            error: 'Authentication failed'
                        }).catch(e => console.error('Notify failed:', e.message));
                    }
                } else if (shouldReconnect && attempt < MAX_RESTORE_ATTEMPTS) {
                    console.log(`[SESSION ${sessionId}] ⏳ Reconnecting in 10s (attempt ${attempt + 1}/${MAX_RESTORE_ATTEMPTS})...`);
                    setTimeout(() => {
                        startSession(sessionId, phoneNumber, method, attempt + 1);
                    }, 10000);
                } else if (attempt >= MAX_RESTORE_ATTEMPTS) {
                    console.error(`[SESSION ${sessionId}] ❌ Max reconnection attempts reached`);
                    if (sessionId !== PLATFORM_BOT_ID) {
                        notifyFastAPI({
                            storeId: sessionId,
                            status: 'error',
                            error: 'Max reconnection attempts exceeded'
                        }).catch(e => console.error('Notify failed:', e.message));
                    }
                }
            }
        });

        // ✅ Event: Mensagens recebidas
        waSocket.ev.on('messages.upsert', async (m) => {
            try {
                const receivedMessages = m.messages || [];

                for (const msg of receivedMessages) {
                    if (!msg || !msg.key || !msg.message) continue;
                    if (msg.key.fromMe) continue;

                    const chatId = msg.key.remoteJid;

                    // ✅ Filtros de segurança
                    if (!chatId ||
                        chatId === 'status@broadcast' ||
                        chatId.endsWith('@g.us') ||
                        chatId.endsWith('@broadcast')) {
                        continue;
                    }

                    if (sessionId !== PLATFORM_BOT_ID) {
                        updateConversationMetadata(sessionId, msg);

                        const state = conversationStateManager.get(chatId) || {};

                        // ✅ Verificar pausa para suporte humano
                        if (state.humanSupportUntil && new Date() < new Date(state.humanSupportUntil)) {
                            console.log(`[SESSION ${sessionId}] 🤐 Chat paused for human support`);
                            continue;
                        }

                        // ✅ Verificar que socket está pronto
                        if (!waSocket.user || !waSocket.user.id) {
                            console.warn(`[SESSION ${sessionId}] ⚠️ Socket not ready. Skipping message.`);
                            continue;
                        }

                        await processMessage(msg, sessionId, waSocket, state);
                        conversationStateManager.set(chatId, state);
                    }
                }
            } catch (err) {
                console.error(`[SESSION ${sessionId}] Error processing messages:`, err.message);
            }
        });

        // ✅ Solicitar código de pareamento se necessário
        if (method === 'pairing' && phoneNumber) {
            try {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const code = await waSocket.requestPairingCode(phoneNumber);
                const formatted = code.match(/.{1,4}/g).join('-');
                console.log(`[SESSION ${sessionId}] ✅ Pairing Code: ${formatted}`);

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'awaiting_pairing_code',
                        pairingCode: code
                    }).catch(e => console.error('Notify failed:', e.message));
                }
            } catch (err) {
                console.error(`[SESSION ${sessionId}] Failed to request pairing code:`, err.message);
                sessionEntry.status = 'error';
                sessionEntry.lastError = err.message;
                waSocket.end();
                await authDB.clearAll(sessionId);
                activeSessions.delete(String(sessionId));

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({ storeId: sessionId, status: 'error', error: err.message })
                        .catch(e => console.error('Notify failed:', e.message));
                }
            }
        }

    } catch (error) {
        console.error(`[SESSION ${sessionId}] ❌ CRITICAL ERROR:`, error.message);

        const entry = activeSessions.get(String(sessionId));
        if (entry) {
            entry.status = 'error';
            entry.lastError = error.message;
        }

        if (sessionId !== PLATFORM_BOT_ID) {
            notifyFastAPI({
                storeId: sessionId,
                status: 'error',
                error: error.message
            }).catch(e => console.error('Notify failed:', e.message));
        }

        // ✅ Retry com backoff
        if (attempt < MAX_RESTORE_ATTEMPTS) {
            const delay = Math.min(SESSION_RESTORE_DELAY * Math.pow(2, attempt - 1), 30000);
            console.log(`[SESSION ${sessionId}] ⏳ Retrying in ${delay / 1000}s...`);
            setTimeout(() => {
                startSession(sessionId, phoneNumber, method, attempt + 1);
            }, delay);
        }
    }
};

// ✅ Desconectar sessão
const disconnectSession = async (sessionId) => {
    const session = activeSessions.get(String(sessionId));
    try {
        if (session?.sock) {
            await session.sock.logout();
        } else {
            await authDB.clearAll(sessionId);
        }

        if (sessionId !== PLATFORM_BOT_ID) {
            notifyFastAPI({ storeId: sessionId, status: 'disconnected' })
                .catch(e => console.error('Notify failed:', e.message));
        }
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Failed to disconnect:`, err.message);
    }
};

// ✅ Enviar mensagem com validações
const sendMessage = async (sessionId, number, message, mediaUrl, mediaType, mediaFilename) => {
    const session = activeSessions.get(String(sessionId));

    if (!session || !session.sock || session.status !== 'open') {
        console.warn(`[SESSION ${sessionId}] ⚠️ Session not ready`);
        return false;
    }

    if (!session.sock.user || !session.sock.user.id) {
        console.warn(`[SESSION ${sessionId}] ⚠️ Socket user not initialized`);
        return false;
    }

    try {
        const chatId = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        let payload;

        if (mediaType === 'image' && mediaUrl) {
            payload = { image: { url: mediaUrl }, caption: message };
        } else if (mediaType === 'audio' && mediaUrl) {
            payload = { audio: { url: mediaUrl }, ptt: true };
        } else if (mediaType === 'document' && mediaUrl) {
            payload = {
                document: { url: mediaUrl },
                fileName: mediaFilename || 'documento.pdf',
                caption: message
            };
        } else {
            payload = { text: message };
        }

        const result = await session.sock.sendMessage(chatId, payload);

        if (result && sessionId !== PLATFORM_BOT_ID) {
            forwardMessageToFastAPI(sessionId, result, session.sock)
                .catch(err => console.error(`Failed to forward:`, err.message));
        }

        return true;
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Error sending message:`, err.message);
        return false;
    }
};

// ✅ Restaurar sessões com validações
const restoreActiveSessions = async () => {
    if (isRestoringComplete) {
        console.log('[RESTORE] ⚠️ Already restored.');
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

        for (const store of storesToReconnect) {
            console.log(`[RESTORE] Restoring store ${store.store_id}...`);
            startSession(String(store.store_id), undefined, 'qr');
            await new Promise(resolve => setTimeout(resolve, SESSION_RESTORE_DELAY));
        }

        isRestoringComplete = true;
        console.log('[RESTORE] ✅ Session restoration completed');
    } catch (err) {
        console.error('[RESTORE] Error:', err.message);
        isRestoringComplete = true;
    }
};

// ✅ Pausar chat
const pauseChatForHuman = (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));

    if (!session || session.status !== 'open') {
        console.warn(`[SESSION ${storeId}] Cannot pause. Not connected.`);
        return false;
    }

    const state = conversationStateManager.get(chatId) || {};
    state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
    conversationStateManager.set(chatId, state);

    console.log(`[SESSION ${storeId}] ✅ Chat paused for 30 minutes`);
    return true;
};

// ✅ Obter foto de perfil
const getProfilePictureUrl = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));

    if (!session || !session.sock || session.status !== 'open') {
        return null;
    }

    try {
        return await session.sock.profilePictureUrl(chatId, 'image');
    } catch (err) {
        console.log(`[SESSION ${storeId}] Profile picture not found`);
        return null;
    }
};

// ✅ Obter nome do contato
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
    } catch (err) {
        return null;
    }
};

// ✅ Enviar mensagem da plataforma
const sendPlatformMessage = async (number, message) => {
    return await sendMessage(PLATFORM_BOT_ID, number, message, null, null, null);
};

// ✅ Shutdown gracioso
const shutdown = async () => {
    console.log('\n[SHUTDOWN] 🛑 Initiating graceful shutdown...');

    if (!isRestoringComplete) {
        console.log('[SHUTDOWN] ⏳ Waiting for restoration...');
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const promises = [];
    for (const [storeId, session] of activeSessions.entries()) {
        if (session.sock && session.status === 'open') {
            promises.push(
                session.sock.end(new Error('Server Shutdown'))
                    .catch(err => console.error(`Error closing ${storeId}:`, err.message))
            );
        }
    }

    await Promise.all(promises);
    activeSessions.clear();
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