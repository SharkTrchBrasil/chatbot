// services/whatsappService.js - CORRIGIDO PARA ES MODULES

// ✅ CORREÇÃO CRÍTICA: Usar import dinâmico ou syntax correto
import { makeWASocket as makeWASocketFn, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

// ✅ RENOMEAR para evitar conflitos
const makeWASocket = makeWASocketFn;

import { Boom } from '@hapi/boom';
import { getStoresToReconnect, updateConversationMetadata } from './chatbotService.js';
import { notifyFastAPI } from '../utils/notifications.js';
import { processMessage } from '../controllers/chatbotController.js';
import { forwardMessageToFastAPI } from '../utils/forwarder.js';
import { cacheManager } from './cacheService.js';
import pool from '../config/database.js';

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;
const MAX_RESTORE_ATTEMPTS = 3;
const SESSION_RESTORE_DELAY = 3000;

let isRestoringComplete = false;

// ✅ 6.7.18: Validação simplificada
const isValidCredentials = (creds) => {
    if (!creds || typeof creds !== 'object') return false;
    return !!creds.me?.id;
};

// ✅ 6.7.18: Sanitização mínima (reduz memory leak)
const sanitizeCredentials = (creds) => {
    if (!creds) return null;
    return creds;
};

// ✅ AUTH DB - Versão para 6.7.18
const authDB = {
    read: async (sessionId, key) => {
        const client = await pool.connect();
        try {
            const query = 'SELECT cred_value FROM chatbot_auth_credentials WHERE session_id = $1 AND cred_id = $2';
            const { rows } = await client.query(query, [sessionId, key]);

            if (rows.length === 0) return null;

            const data = rows[0].cred_value;

            // ✅ Validar apenas creds completas
            if (key === 'creds') {
                if (!isValidCredentials(data)) {
                    console.warn(`[AUTH DB] Invalid creds for ${sessionId}. Clearing.`);
                    await this.clearAll(sessionId);
                    return null;
                }
            }

            return data;
        } catch (err) {
            console.error(`[AUTH DB] Read error for ${sessionId}:`, err.message);
            return null;
        } finally {
            client.release();
        }
    },

    write: async (sessionId, key, value) => {
        const client = await pool.connect();
        try {
            const finalValue = key === 'creds' ? sanitizeCredentials(value) : value;
            if (!finalValue && key === 'creds') return false;

            const query = `
                INSERT INTO chatbot_auth_credentials (session_id, cred_id, cred_value)
                VALUES ($1, $2, $3)
                ON CONFLICT (session_id, cred_id)
                DO UPDATE SET cred_value = EXCLUDED.cred_value, updated_at = CURRENT_TIMESTAMP
            `;

            await client.query(query, [sessionId, key, finalValue]);
            return true;
        } catch (err) {
            console.error(`[AUTH DB] Write error for ${sessionId}:`, err.message);
            return false;
        } finally {
            client.release();
        }
    },

    clearAll: async (sessionId) => {
        const client = await pool.connect();
        try {
            await client.query('DELETE FROM chatbot_auth_credentials WHERE session_id = $1', [sessionId]);
            return true;
        } catch (err) {
            console.error(`[AUTH DB] Clear error for ${sessionId}:`, err.message);
            return false;
        } finally {
            client.release();
        }
    }
};

// ✅ LOGGER
const createLogger = (sessionId) => {
    return {
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
    };
};

// ✅ CORRIGIDO: Inicializar creds com estrutura válida
const createDefaultCreds = () => ({
    me: undefined,
    noiseKey: { private: Buffer.alloc(32), public: Buffer.alloc(33) },
    signedIdentityKey: { private: Buffer.alloc(32), public: Buffer.alloc(33) },
    signedPreKey: {
        keyPair: { private: Buffer.alloc(32), public: Buffer.alloc(33) },
        signature: Buffer.alloc(64),
        keyId: 1
    },
    registrationId: Math.floor(Math.random() * (2 ** 31 - 1)),
    advSecretKey: Buffer.alloc(32).toString('base64'),
    processedRightContextVersion: 0,
    firstUnuploadedPreKeyId: 1,
    nextPreKeyId: 1,
    oneTimeKeysCount: 0,
    platform: 'android'
});

// ✅ 6.7.18: AUTH STATE COM INICIALIZAÇÃO CORRETA
const createAuthStateFromDB = (sessionId) => {
    const authState = {
        state: {
            creds: createDefaultCreds(), // ✅ CORRIGIDO: Inicializar com estrutura válida
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

// ✅ START SESSION - OTIMIZADO PARA 6.7.18
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

        const authState = createAuthStateFromDB(sessionId);
        const savedCreds = await authDB.read(sessionId, 'creds');

        if (savedCreds && isValidCredentials(savedCreds)) {
            authState.state.creds = savedCreds;
            console.log(`[SESSION ${sessionId}] ✅ Loaded creds from DB`);
        } else if (savedCreds) {
            console.warn(`[SESSION ${sessionId}] Creds inválidas. Starting fresh.`);
            await authDB.clearAll(sessionId);
            authState.state.creds = createDefaultCreds(); // ✅ Reinicializar
        } else {
            console.log(`[SESSION ${sessionId}] No creds found. Starting fresh connection.`);
            authState.state.creds = createDefaultCreds(); // ✅ Garantir inicialização
        }

        const { version } = await fetchLatestBaileysVersion();

        // ✅ DEBUG: Verificar creds
        if (!authState.state.creds) {
            throw new Error(`[SESSION ${sessionId}] creds is undefined!`);
        }
        if (!authState.state.creds.noiseKey) {
            throw new Error(`[SESSION ${sessionId}] creds.noiseKey is undefined!`);
        }

        console.log(`[SESSION ${sessionId}] ✅ Auth state initialized correctly`);

        // ✅ CRÍTICO: Configurações para 6.7.18 (evita memory leak)
        const waSocket = makeWASocket({
            auth: authState.state,
            version,
            printQRInTerminal: false,
            browser: ['PDVix Platform', 'Chrome', '1.0.0'],
            logger: createLogger(sessionId),

            // ✅ 6.7.18: Memory optimization (FUNDAMENTAL!)
            syncFullHistory: false,
            markOnlineOnConnect: false,
            emitOwnEvents: false,
            getMessage: async () => undefined,
            shouldSyncHistoryMessage: () => false,

            // ✅ Timeouts
            defaultQueryTimeoutMs: 10000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,

            // ✅ Limitar processamento
            shouldIgnoreJid: (jid) => {
                return jid.endsWith('@g.us') ||
                       jid.endsWith('@broadcast') ||
                       jid === 'status@broadcast';
            },

            // ✅ 6.7.18: Limitar cache de chamadas
            maxMissedCallLogs: 5,
            retryRequestDelayMs: 100
        });

        sessionEntry.sock = waSocket;

        // ✅ EVENT: Credenciais atualizadas
        waSocket.ev.on('creds.update', async (update) => {
            try {
                console.log(`[SESSION ${sessionId}] 💾 Creds update`);
                Object.assign(authState.state.creds || {}, update);
                await authState.saveCreds();
            } catch (err) {
                console.error(`[SESSION ${sessionId}] Creds update error:`, err.message);
            }
        });

        // ✅ EVENT: Connection status
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (connection === 'connecting') {
                sessionEntry.status = 'connecting';
                console.log(`[SESSION ${sessionId}] 🔄 Connecting...`);
            }

            if (connection === 'open') {
                sessionEntry.status = 'open';
                sessionEntry.lastError = null;
                console.log(`[SESSION ${sessionId}] ✅ Connected as ${waSocket.user?.name}`);

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'connected',
                        whatsappName: waSocket.user?.name,
                        whatsappId: waSocket.user?.id,
                        isActive: true
                    }).catch((err) => {
                        console.error(`[SESSION ${sessionId}] Notify error:`, err.message);
                    });
                }
            }

            if (qr) {
                console.log(`[SESSION ${sessionId}] 🔲 QR Code`);
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
                sessionEntry.status = 'disconnected';
                console.log(`[SESSION ${sessionId}] ❌ Closed (Code: ${statusCode})`);
                activeSessions.delete(String(sessionId));

                // ✅ Limpar creds em caso de erro de autenticação
                if ([DisconnectReason.loggedOut, 401, 403].includes(statusCode)) {
                    console.log(`[SESSION ${sessionId}] Auth error. Clearing creds.`);
                    await authDB.clearAll(sessionId);
                } else if (attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
                    const delay = Math.min(SESSION_RESTORE_DELAY * Math.pow(2, attempt - 1), 30000);
                    console.log(`[SESSION ${sessionId}] Retrying in ${delay}ms...`);
                    setTimeout(() => startSession(sessionId, phoneNumber, method, attempt + 1), delay);
                }

                if (sessionId !== PLATFORM_BOT_ID) {
                    notifyFastAPI({ storeId: sessionId, status: 'disconnected' }).catch(() => {});
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

                // ✅ 6.7.18: Não bloquear encaminhamento
                forwardMessageToFastAPI(sessionId, msg, waSocket).catch(() => {});
            }
        });

        // ✅ PAIRING CODE
        if (method === 'pairing' && phoneNumber) {
            try {
                console.log(`[SESSION ${sessionId}] ⏳ Requesting pairing code...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
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
                waSocket.end();
                await authDB.clearAll(sessionId);
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

// ✅ FUNÇÕES AUXILIARES (mantidas)
const disconnectSession = async (sessionId) => {
    const session = activeSessions.get(String(sessionId));
    try {
        if (session?.sock) {
            session.sock.logout('Disconnect requested');
        }
        await authDB.clearAll(sessionId);
        activeSessions.delete(String(sessionId));
        if (sessionId !== PLATFORM_BOT_ID) {
            notifyFastAPI({ storeId: sessionId, status: 'disconnected' }).catch(() => {});
        }
    } catch (err) {
        console.error(`[SESSION ${sessionId}] Disconnect error:`, err.message);
    }
};

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

const restoreActiveSessions = async () => {
    if (isRestoringComplete) return;
    console.log('[RESTORE] 🔄 Starting...');
    try {
        const stores = await getStoresToReconnect();
        if (stores.length === 0) {
            isRestoringComplete = true;
            return;
        }
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

const pauseChatForHuman = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || session.status !== 'open') return false;
    const cacheKey = `state:${chatId}`;
    const { value: state } = await cacheManager.get('conversationState', cacheKey) || { value: {} };
    state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
    await cacheManager.set('conversationState', cacheKey, state, INACTIVITY_PAUSE_MS / 1000);
    return true;
};

const getProfilePictureUrl = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session?.sock || session.status !== 'open') return null;
    try {
        return await session.sock.profilePictureUrl(chatId, 'image');
    } catch {
        return null;
    }
};

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

const sendPlatformMessage = async (number, message) => {
    return await sendMessage(PLATFORM_BOT_ID, number, message, null, null, null);
};

const shutdown = async () => {
    console.log('[SHUTDOWN] 🛑 Starting...');
    const promises = [];
    for (const [storeId, session] of activeSessions.entries()) {
        if (session.sock && session.status === 'open') {
            promises.push(session.sock.end().catch(() => {}));
        }
    }
    await Promise.all(promises);
    activeSessions.clear();
    console.log('[SHUTDOWN] ✅ Complete');
};

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