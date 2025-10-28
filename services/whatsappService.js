// services/whatsappService.js
// VERSÃO CORRIGIDA: Funções duplicadas removidas e importações corrigidas.

import makeWASocket, {
    DisconnectReason,
    // ✅ NOVO: Importar a função de autenticação nativa do Baileys
    AuthenticationFromDB
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { notifyFastAPI } from '../utils/notifications.js';
import { processMessage } from '../controllers/chatbotController.js';
import { getStoresToReconnect } from './chatbotService.js';
import { Blob } from 'buffer';

// ✅ CORREÇÃO: Importa o forwarder real para quebrar a dependência
import { forwardMessageToFastAPI } from '../utils/forwarder.js';

// ✅ NOVO: Conectar ao banco de dados diretamente aqui.
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';

// ✅ ESTADO CENTRALIZADO (Ver Auditoria de Escalabilidade)
export const conversationState = {};
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;

const sessionMethods = new Map();

// ✅ NOVO: Lógica de autenticação para o Baileys v7
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
                DO UPDATE SET cred_value = EXCLUDED.cred_value;
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

    const { state, saveCreds, clearCreds } = AuthenticationFromDB(sessionId, authDB, createLogger(sessionId));

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

    activeSessions.set(String(sessionId), { sock: waSocket, method, status: 'connecting', clearCreds });
    const isPlatformBot = sessionId === PLATFORM_BOT_ID;

    waSocket.ev.on('creds.update', saveCreds);

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
                    whatsappName: waSocket.user.name,
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
            if(clearCreds) await clearCreds();
            notifyFastAPI({ storeId: sessionId, status: 'error' });
        }
    }

    waSocket.ev.on('messages.upsert', async (m) => {
        const receivedMessages = m.messages;
        for (const msg of receivedMessages) {
            if (msg.key.fromMe || !msg.message) continue;

            const chatId = msg.key.remoteJid;

            // ✅ CORREÇÃO: Pega o estado do 'conversationState' exportado
            const state = conversationState[chatId];

            if (state && state.humanSupportUntil && new Date() < new Date(state.humanSupportUntil)) {
                console.log(`[SESSION ${sessionId}] Chat ${chatId} is paused for human support. Skipping AI response.`);
                continue;
            }
            if (!isPlatformBot) {
                // ✅ CORREÇÃO: Passa o 'waSocket' e o 'sessionId' corretos
                // A função 'processMessage' agora espera 'state' como parâmetro

                // Garante que o estado exista
                if (!conversationState[chatId]) {
                    conversationState[chatId] = {};
                }

                await processMessage(msg, sessionId, waSocket, conversationState[chatId]);
            }
        }
    });
};

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

        // ✅ CORREÇÃO: Chama o 'forwardMessageToFastAPI' importado
        if (result && !isPlatform) {
            forwardMessageToFastAPI(sessionId, result, session.sock);
        }
        return true;
    } catch (e) {
        console.error(`${logPrefix} ❌ CRITICAL ERROR sending message to ${number}:`, e);
        throw e;
    }
};

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

// ❌ FUNÇÃO DUPLICADA 'forwardMessageToFastAPI' REMOVIDA DAQUI
// ❌ FUNÇÃO DUPLICADA 'shutdown' REMOVIDA DAQUI

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

const getContactName = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || !session.sock || !session.sock.user?.id) {
        return null;
    }
    try {
        // Esta função foi depreciada na v7, mas pode funcionar.
        // O ideal é buscar no 'state' ou usar 'waSocket.contactFetch(chatId)'
        // Vamos manter por enquanto, mas é um ponto de atenção.
        const contact = await session.sock.getContactById(chatId);
        return contact?.name || contact?.notify || contact?.pushName;
    } catch (e) {
        console.log(`[STORE ${storeId}] Could not fetch contact name for ${chatId}.`);
        return null;
    }
};

const sendPlatformMessage = async (number, message) => {
    console.log(`[PLATFORM BOT] Sending transactional message to ${number}`);
    return await sendMessage(PLATFORM_BOT_ID, number, message, null, null, null, true);
};

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