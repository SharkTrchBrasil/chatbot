import makeWASocket, {
    DisconnectReason,
    downloadMediaMessage,
    useMultiFileAuthState
} from '@whiskeysockets/baileys';

import { getStoresToReconnect, updateConversationMetadata } from './chatbotService.js';
import qrcode from 'qrcode-terminal';
import { notifyFastAPI } from '../utils/notifications.js';
import { processMessage } from '../controllers/chatbotController.js';
import { forwardMessageToFastAPI } from '../utils/forwarder.js';

// Conectar ao banco de dados
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';

// Estado centralizado de conversação
export const conversationState = {};
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;

const sessionMethods = new Map();

// ✅ Implementação de Auth State customizado para o banco de dados
const createAuthStateFromDB = (sessionId) => {
    return {
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
            if (authStateFromDB.state.creds) {
                await authDB.write(sessionId, 'creds', authStateFromDB.state.creds);
            }
        }
    };
};

// Operações de autenticação no banco de dados
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
    remove: async (sessionId, key) => {
        try {
            const query = 'DELETE FROM chatbot_auth_credentials WHERE session_id = $1 AND cred_id = $2';
            await pool.query(query, [sessionId, key]);
        } catch (e) {
            console.error(`[AUTH DB] ❌ Failed to remove key ${key} for session ${sessionId}`, e);
        }
    },
    clearAll: async (sessionId) => {
        try {
            console.log(`[AUTH DB] 🗑️ Removing all credentials for session ${sessionId} from database.`);
            const query = 'DELETE FROM chatbot_auth_credentials WHERE session_id = $1';
            await pool.query(query, [sessionId]);
        } catch (e) {
            console.error(`[AUTH DB] ❌ Failed to remove session ${sessionId} from database.`, e);
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

// Iniciar sessão do WhatsApp
const startSession = async (sessionId, phoneNumber, method) => {
    if (activeSessions.has(String(sessionId))) {
        console.log(`[SESSION ${sessionId}] Session already in progress. Ignoring duplicate start.`);
        return;
    }

    if (!method) {
        method = sessionMethods.get(String(sessionId)) || 'qr';
    } else {
        sessionMethods.set(String(sessionId), method);
    }

    console.log(`[SESSION ${sessionId}] Starting connection process using method: "${method}"...`);

    // ✅ CORREÇÃO: Criar auth state customizado
    const { state, saveCreds } = createAuthStateFromDB(sessionId);

    // Carregar credenciais do banco
    const savedCreds = await authDB.read(sessionId, 'creds');
    if (savedCreds) {
        state.creds = savedCreds;
    }

    const waSocket = makeWASocket({
        auth: state,
        printQRInTerminal: method === 'qr',
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
    waSocket.ev.on('creds.update', saveCreds);

    // Gerenciar conexão
    waSocket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = activeSessions.get(String(sessionId));

        if (connection === 'open') {
            console.log(`[SESSION ${sessionId}] ✅ WhatsApp client is ready and logged in!`);
            if (session) session.status = 'open';

            if (!isPlatformBot) {
                notifyFastAPI({
                    storeId: sessionId,
                    status: 'connected',
                    whatsappName: waSocket.user?.name || 'Unknown',
                    isActive: true
                });
            }
        }

        if (qr && method === 'qr') {
            console.log(`[SESSION ${sessionId}] 📱 QR Code generated. Scan it to connect.`);
            qrcode.generate(qr, { small: true });
            if (!isPlatformBot) {
                notifyFastAPI({ storeId: sessionId, status: 'awaiting_qr', qrCode: qr });
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[SESSION ${sessionId}] ❌ Connection closed. Reason: ${DisconnectReason[statusCode] || 'Unknown'}, Status Code: ${statusCode}`);
            activeSessions.delete(String(sessionId));

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[SESSION ${sessionId}] ⚠️ User logged out. Clearing session from DB...`);
                await clearCreds();
                sessionMethods.delete(String(sessionId));
                if (!isPlatformBot) notifyFastAPI({ storeId: sessionId, status: 'disconnected' });
            } else if ([401, 403, 405, 440].includes(statusCode)) {
                console.log(`[SESSION ${sessionId}] ⚠️ Authentication error. Clearing credentials from DB...`);
                await clearCreds();
                sessionMethods.delete(String(sessionId));
                if (!isPlatformBot) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'disconnected',
                        error: 'Authentication failed. Please reconnect.'
                    });
                }
            } else if (shouldReconnect) {
                console.log(`[SESSION ${sessionId}] 🔄 Attempting to reconnect in 5 seconds...`);
                setTimeout(() => {
                    const storedMethod = sessionMethods.get(String(sessionId)) || 'qr';
                    startSession(sessionId, phoneNumber, storedMethod);
                }, 5000);
            } else {
                console.log(`[SESSION ${sessionId}] 🔌 Connection closed permanently. No reconnect needed.`);
            }
        }
    });

    // Solicitar código de pareamento se necessário
    if (method === 'pairing' && phoneNumber) {
        try {
            console.log(`[SESSION ${sessionId}] Requesting pairing code for ${phoneNumber}...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            const code = await waSocket.requestPairingCode(phoneNumber);
            const formattedCode = code.match(/.{1,4}/g).join('-');
            console.log(`[SESSION ${sessionId}] ✅ Pairing Code Generated: ${formattedCode}`);
            notifyFastAPI({ storeId: sessionId, status: 'awaiting_pairing_code', pairingCode: code });
        } catch (e) {
            console.error(`[SESSION ${sessionId}] CRITICAL: Failed to request pairing code.`, e);
            waSocket.end();
            await clearCreds();
            notifyFastAPI({ storeId: sessionId, status: 'error' });
        }
    }

    // Processar mensagens recebidas
    waSocket.ev.on('messages.upsert', async (m) => {
        const receivedMessages = m.messages;
        for (const msg of receivedMessages) {
            if (!isPlatformBot && msg.message) {
                updateConversationMetadata(sessionId, msg);
            }

            if (msg.key.fromMe || !msg.message) continue;

            const chatId = msg.key.remoteJid;

            // Verificar se o chat está pausado para suporte humano
            const state = conversationState[chatId];

            if (state && state.humanSupportUntil && new Date() < new Date(state.humanSupportUntil)) {
                console.log(`[SESSION ${sessionId}] Chat ${chatId} is paused for human support. Skipping AI response.`);
                continue;
            }

            if (!isPlatformBot) {
                // Garantir que o estado exista
                if (!conversationState[chatId]) {
                    conversationState[chatId] = {};
                }

                await processMessage(msg, sessionId, waSocket, conversationState[chatId]);
            }
        }
    });
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

// Enviar mensagem
const sendMessage = async (sessionId, number, message, mediaUrl, mediaType, mediaFilename, isPlatform = false) => {
    const logPrefix = isPlatform ? '[PLATFORM BOT]' : `[SESSION ${sessionId}]`;
    const session = activeSessions.get(String(sessionId));

    if (!session || !session.sock || !session.sock.user?.id) {
        console.warn(`${logPrefix} SEND BLOCKED! Session not ready or user not identified.`);
        return false;
    }

    try {
        const chatId = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        let messagePayload;

        if (mediaType === 'image' && mediaUrl) {
            messagePayload = { image: { url: mediaUrl }, caption: message };
        } else if (mediaType === 'audio' && mediaUrl) {
            messagePayload = { audio: { url: mediaUrl }, ptt: true };
        } else if (mediaType === 'document' && mediaUrl) {
            messagePayload = { document: { url: mediaUrl }, fileName: mediaFilename || 'documento.pdf', caption: message };
        } else {
            messagePayload = { text: message };
        }

        const result = await session.sock.sendMessage(chatId, messagePayload);

        if (result && !isPlatform) {
            forwardMessageToFastAPI(sessionId, result, session.sock);
        }
        return true;
    } catch (e) {
        console.error(`${logPrefix} ❌ CRITICAL ERROR sending message to ${number}:`, e);
        throw e;
    }
};

// Restaurar sessões ativas
const restoreActiveSessions = async () => {
    console.log('--- Checking for saved sessions to restore ---');
    try {
        const storesToReconnect = await getStoresToReconnect();
        for (const store of storesToReconnect) {
            console.log(`[RESTORING] Found active session config for store ${store.store_id}. Attempting to reactivate...`);
            startSession(String(store.store_id), undefined, undefined);
        }
    } catch (e) {
        console.error('Error while restoring sessions:', e);
    }
};

// Pausar chat para suporte humano
const pauseChatForHuman = (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || !session.sock || !session.sock.user?.id) {
        console.warn(`[STORE ${storeId}] Cannot pause chat. Session not connected.`);
        return false;
    }

    const state = conversationState[chatId];

    if (state) {
        state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
        console.log(`[STORE ${storeId}] Chat with ${chatId} has been paused. Timer set for 30 minutes.`);
        return true;
    } else {
        conversationState[chatId] = {
            humanSupportUntil: new Date(Date.now() + INACTIVITY_PAUSE_MS),
        };
        console.log(`[STORE ${storeId}] New conversation state created and paused for ${chatId}.`);
        return true;
    }
};

// Obter URL da foto de perfil
const getProfilePictureUrl = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || !session.sock || !session.sock.user?.id) {
        console.warn(`[STORE ${storeId}] Cannot get profile picture. Session not connected.`);
        return null;
    }
    try {
        const url = await session.sock.profilePictureUrl(chatId, 'image');
        console.log(`[STORE ${storeId}] Profile picture URL fetched for ${chatId}`);
        return url;
    } catch (e) {
        console.log(`[STORE ${storeId}] Could not fetch profile picture for ${chatId}. It might not exist.`);
        return null;
    }
};

// ✅ CORREÇÃO: Obter nome do contato usando método compatível com Baileys v7
const getContactName = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || !session.sock || !session.sock.user?.id) {
        return null;
    }
    try {
        // Usar onWhatsApp para verificar se o número existe
        const [result] = await session.sock.onWhatsApp(chatId);
        if (result && result.exists) {
            // Retornar o JID como fallback, já que v7 não tem getContactById
            return result.jid.split('@')[0];
        }
        return null;
    } catch (e) {
        console.log(`[STORE ${storeId}] Could not fetch contact info for ${chatId}.`);
        return null;
    }
};

// Enviar mensagem da plataforma
const sendPlatformMessage = async (number, message) => {
    console.log(`[PLATFORM BOT] Sending transactional message to ${number}`);
    return await sendMessage(PLATFORM_BOT_ID, number, message, null, null, null, true);
};

// Desligar servidor gracefully
const shutdown = async () => {
    console.log('[SHUTTING DOWN] Server received shutdown signal...');
    const promises = [];
    for (const [storeId, session] of activeSessions.entries()) {
        if (session.sock) {
            console.log(`[SHUTTING DOWN] Closing client for store ${storeId}...`);
            promises.push(session.sock.end(new Error('Server Shutdown')));
        }
    }
    await Promise.all(promises);
    console.log('[SHUTTING DOWN] All clients have been terminated. Exiting process.');
    process.exit(0);
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