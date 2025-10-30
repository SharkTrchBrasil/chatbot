// services/whatsappService.js - VERSÃO HÍBRIDA (DB + Filesystem) COM ANTI-BAN

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
const SESSION_RESTORE_DELAY = 10000; // ⬆️ AUMENTADO: 10s entre tentativas

let isRestoringComplete = false;

// ✅ Diretório temporário (sincronizado com DB)
const AUTH_DIR = path.join(__dirname, '..', 'auth_sessions');

// ✅ ANTI-BAN: Delay entre operações
const OPERATION_DELAY = 2000;
const antiSpamDelay = () => new Promise(resolve => setTimeout(resolve, OPERATION_DELAY));
const credsSaveTimers = new Map(); // ⬅️ NOVO: Rastrear por sessão

// ✅ Garantir diretório
const ensureAuthDir = async () => {
    try {
        await fs.mkdir(AUTH_DIR, { recursive: true });
    } catch (err) {
        console.error('[AUTH] Failed to create dir:', err.message);
    }
};

// ✅ CORREÇÃO 1: Substitua a função createLogger (por volta da linha ~45)

const createLogger = (sessionId) => ({
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (msg) => {
        // ✅ CONVERTER PARA STRING PRIMEIRO
        const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);

        if (msgStr.includes('myAppStateKeyId') || msgStr.includes('no name present')) {
            return;
        }
        console.warn(`[SESSION ${sessionId}][WARN]`, msgStr);
    },
    error: (msg) => {
        // ✅ CONVERTER PARA STRING PRIMEIRO
        const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);

        if (typeof msg === 'object' && msg?.node?.attrs?.code === '515') {
            return;
        }
        console.error(`[SESSION ${sessionId}][ERROR]`, msgStr);
    },
    child: () => createLogger(sessionId)
});

// âœ… BANCO DE DADOS: Salvar credenciais
const saveCredsToDatabase = async (sessionId, creds) => {
    const client = await pool.connect();
    try {
        // Limpar credenciais antigas
        await client.query(
            'DELETE FROM chatbot_auth_credentials WHERE session_id = $1',
            [`store_${sessionId}`]
        );

        // âœ… ADICIONAR updated_at NA QUERY
        await client.query(
            `INSERT INTO chatbot_auth_credentials (session_id, cred_id, cred_value, updated_at)
             VALUES ($1, $2, $3, NOW())`,
            [`store_${sessionId}`, 'creds', creds]
        );

        console.log(`[DB] âœ… Credentials saved for store ${sessionId}`);
    } catch (err) {
        console.error(`[DB] Failed to save creds for store ${sessionId}:`, err.message);
    } finally {
        client.release();
    }
};


// ✅ BANCO DE DADOS: Carregar credenciais
const loadCredsFromDatabase = async (sessionId) => {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            'SELECT cred_value FROM chatbot_auth_credentials WHERE session_id = $1 AND cred_id = $2',
            [`store_${sessionId}`, 'creds']
        );

        if (rows.length > 0) {
            console.log(`[DB] ✅ Credentials loaded for store ${sessionId}`);
            return rows[0].cred_value;
        }

        return null;
    } catch (err) {
        console.error(`[DB] Failed to load creds for store ${sessionId}:`, err.message);
        return null;
    } finally {
        client.release();
    }
};

// ✅ BANCO DE DADOS: Limpar credenciais
const clearCredsFromDatabase = async (sessionId) => {
    const client = await pool.connect();
    try {
        await client.query(
            'DELETE FROM chatbot_auth_credentials WHERE session_id = $1',
            [`store_${sessionId}`]
        );
        console.log(`[DB] 🗑️ Credentials cleared for store ${sessionId}`);
    } catch (err) {
        console.error(`[DB] Failed to clear creds for store ${sessionId}:`, err.message);
    } finally {
        client.release();
    }
};

// ✅ HÍBRIDO: Auth state (filesystem + sync para DB)
const getAuthState = async (sessionId) => {
    const authPath = path.join(AUTH_DIR, `session_${sessionId}`);

    try {
        await fs.mkdir(authPath, { recursive: true });

        // Tentar restaurar do banco para o filesystem (se não existir localmente)
        try {
            await fs.access(path.join(authPath, 'creds.json'));
        } catch {
            // Arquivo não existe, tentar restaurar do banco
            const dbCreds = await loadCredsFromDatabase(sessionId);
            if (dbCreds) {
                await fs.writeFile(
                    path.join(authPath, 'creds.json'),
                    JSON.stringify(dbCreds, null, 2)
                );
                console.log(`[AUTH] ✅ Restored creds from DB for store ${sessionId}`);
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        // Wrapper para salvar no DB também
        const saveCredsHybrid = async () => {
            await saveCreds(); // Salva no filesystem
            await saveCredsToDatabase(sessionId, state.creds); // Salva no DB
        };

        return { state, saveCreds: saveCredsHybrid };
    } catch (err) {
        console.error(`[AUTH] Error for store ${sessionId}:`, err.message);
        throw err;
    }
};

// ✅ Limpar auth completo (filesystem + DB)
const clearAuthState = async (sessionId) => {
    const authPath = path.join(AUTH_DIR, `session_${sessionId}`);

    try {
        await fs.rm(authPath, { recursive: true, force: true });
        await clearCredsFromDatabase(sessionId);
        console.log(`[AUTH] 🗑️ Cleared auth for store ${sessionId}`);
    } catch (err) {
        console.error(`[AUTH] Clear error for store ${sessionId}:`, err.message);
    }
};

// ✅ SUBSTITUA A FUNÇÃO startSession COMPLETAMENTE
const startSession = async (sessionId, phoneNumber, method, attempt = 1) => {
    if (activeSessions.has(String(sessionId))) {
        const existing = activeSessions.get(String(sessionId));
        if (['connecting', 'open'].includes(existing.status)) {
            console.log(`[SESSION ${sessionId}] Already ${existing.status}`);
            return;
        }
    }

    console.log(`[SESSION ${sessionId}] Starting (${method}, attempt ${attempt})...`);

    // ✅ ANTI-BAN: Delay entre tentativas
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
            isNotifying: false // ⬅️ NOVO: Flag para evitar notificações simultâneas
        };

        activeSessions.set(String(sessionId), sessionEntry);

        const { state, saveCreds } = await getAuthState(sessionId);

        const hasValidCreds = state.creds?.me?.id;

        if (hasValidCreds) {
            console.log(`[SESSION ${sessionId}] ✅ Found existing credentials`);
        } else {
            console.log(`[SESSION ${sessionId}] 🆕 Starting fresh connection`);
        }

        const { version } = await fetchLatestBaileysVersion();

        // ✅ ANTI-BAN: Configurações conservadoras
        const waSocket = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            browser: ['PDVix', 'Chrome', '120.0.0'],
            logger: createLogger(sessionId),

            // ✅ ANTI-BAN CRÍTICO
            syncFullHistory: false,
            markOnlineOnConnect: false,
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,

            getMessage: async (key) => {
                return { conversation: '' };
            },

            // ✅ Timeouts aumentados
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 45000,
            qrTimeout: 60000,

            // ✅ Filtros
            shouldIgnoreJid: (jid) => {
                return jid.endsWith('@g.us') ||
                       jid.endsWith('@broadcast') ||
                       jid === 'status@broadcast';
            },

            // ✅ ANTI-BAN: Retry conservador
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 2,

            // ✅ Link preview
            linkPreviewImageThumbnailWidth: 192,
            transactionOpts: {
                maxCommitRetries: 2,
                delayBetweenTriesMs: 500
            }
        });

        sessionEntry.sock = waSocket;

        // ✅ EVENT: Salvar credenciais (COM THROTTLE CORRETO)
        waSocket.ev.on('creds.update', async () => {
            const sessionIdStr = String(sessionId);

            // Limpar timer anterior se existir
            if (credsSaveTimers.has(sessionIdStr)) {
                clearTimeout(credsSaveTimers.get(sessionIdStr));
            }

            // Agendar save para 1 segundo depois
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

        // ✅ EVENT: Connection (CORRIGIDO)
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (connection === 'connecting') {
                sessionEntry.status = 'connecting';
                console.log(`[SESSION ${sessionId}] 🔄 Connecting...`);
            }

            if (connection === 'open') {
                // ✅ VALIDAÇÃO: Aguardar user ID
                if (!waSocket.user?.id) {
                    console.warn(`[SESSION ${sessionId}] ⚠️ Connection open, but no user ID yet`);
                    return;
                }

                // ✅ Evitar notificações duplicadas
                if (sessionEntry.lastNotifiedStatus === 'open') {
                    console.log(`[SESSION ${sessionId}] ℹ️ Already notified as connected`);
                    return;
                }

                sessionEntry.status = 'open';
                sessionEntry.lastError = null;
                sessionEntry.lastNotifiedStatus = 'open';
                sessionEntry.connectionStabilizedAt = Date.now();

                const userName = waSocket.user?.name || 'Unknown';
                const userId = waSocket.user?.id || 'Unknown';

                console.log(`[SESSION ${sessionId}] ✅ Connected as ${userName}`);

                // ✅ ANTI-BAN: Delay antes de notificar
                await antiSpamDelay();

                if (sessionId !== PLATFORM_BOT_ID && !sessionEntry.isNotifying) {
                    sessionEntry.isNotifying = true;

                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'connected',
                        whatsappName: userName,
                        whatsappId: userId,
                        isActive: true
                    }).catch((err) => {
                        console.error(`[SESSION ${sessionId}] Notify error:`, err.message);
                    }).finally(() => {
                        sessionEntry.isNotifying = false;
                    });
                }
            }

            if (qr) {
                // ✅ Evitar notificar QR múltiplas vezes
                if (sessionEntry.lastNotifiedStatus !== 'awaiting_qr') {
                    console.log(`[SESSION ${sessionId}] 📲 QR Code generated`);
                    sessionEntry.lastNotifiedStatus = 'awaiting_qr';

                    if (sessionId !== PLATFORM_BOT_ID && !sessionEntry.isNotifying) {
                        sessionEntry.isNotifying = true;

                        notifyFastAPI({
                            storeId: sessionId,
                            status: 'awaiting_qr',
                            qrCode: qr
                        }).catch(() => {}).finally(() => {
                            sessionEntry.isNotifying = false;
                        });
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                sessionEntry.status = 'disconnected';

                // ✅ Evitar notificar desconexão se nunca notificou conexão
                const shouldNotifyDisconnect = sessionEntry.lastNotifiedStatus === 'open';

                // ✅ Logs informativos
                if (statusCode === 515) {
                    console.log(`[SESSION ${sessionId}] ⚠️ Rate limit (515) - waiting before retry`);
                } else if (statusCode === 401) {
                    console.log(`[SESSION ${sessionId}] ❌ Unauthorized (401) - clearing auth`);
                } else {
                    console.log(`[SESSION ${sessionId}] ❌ Closed (Code: ${statusCode || 'unknown'})`);
                }

                // ✅ NÃO deletar a sessão imediatamente - apenas marcar como disconnected
                // activeSessions.delete(String(sessionId)); // ⬅️ REMOVIDO

                // ✅ Limpar auth em casos críticos
                if ([DisconnectReason.loggedOut, 401, 403, 440].includes(statusCode)) {
                    await clearAuthState(sessionId);
                }

                // ✅ ANTI-BAN: Retry com backoff exponencial
                if (shouldReconnect && attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
                    let delay = SESSION_RESTORE_DELAY * Math.pow(2, attempt - 1);

                    if (statusCode === 515) {
                        delay = Math.max(delay, 30000);
                    }

                    delay = Math.min(delay, 120000);

                    console.log(`[SESSION ${sessionId}] ⏳ Retrying in ${delay / 1000}s...`);

                    // ✅ Limpar a sessão antes de tentar nova conexão
                    activeSessions.delete(String(sessionId));

                    setTimeout(() => {
                        startSession(sessionId, phoneNumber, method, attempt + 1);
                    }, delay);
                } else {
                    // ✅ Se não vai reconectar, limpar agora
                    activeSessions.delete(String(sessionId));
                }

                // ✅ Apenas notificar se realmente estava conectado
                if (sessionId !== PLATFORM_BOT_ID && shouldNotifyDisconnect && !sessionEntry.isNotifying) {
                    sessionEntry.isNotifying = true;

                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'disconnected',
                        reason: statusCode ? `Error ${statusCode}` : 'Unknown'
                    }).catch(() => {}).finally(() => {
                        sessionEntry.isNotifying = false;
                    });
                }
            }
        });

        // ✅ EVENT: Mensagens
        waSocket.ev.on('messages.upsert', async (m) => {
            for (const msg of m.messages || []) {
                if (!msg?.key?.remoteJid || !msg.message || msg.key.fromMe) continue;

                const chatId = msg.key.remoteJid;
                if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast')) continue;

                sessionEntry.messageCount++;
                if (sessionEntry.messageCount > 50) {
                    await antiSpamDelay();
                    sessionEntry.messageCount = 0;
                }

                if (sessionId !== PLATFORM_BOT_ID) {
                    updateConversationMetadata(sessionId, msg).catch(() => {});

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

                forwardMessageToFastAPI(sessionId, msg, waSocket).catch(() => {});
            }
        });

        // ✅ PAIRING CODE
        if (method === 'pairing' && phoneNumber) {
            try {
                console.log(`[SESSION ${sessionId}] ⏳ Requesting pairing code...`);
                await antiSpamDelay();

                const code = await waSocket.requestPairingCode(phoneNumber);
                const formatted = code.match(/.{1,4}/g).join('-');

                console.log(`[SESSION ${sessionId}] ✅ Pairing Code: ${formatted}`);

                if (sessionId !== PLATFORM_BOT_ID && !sessionEntry.isNotifying) {
                    sessionEntry.isNotifying = true;

                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'awaiting_pairing_code',
                        pairingCode: code
                    }).catch(() => {}).finally(() => {
                        sessionEntry.isNotifying = false;
                    });
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

// ✅ SEND MESSAGE (COM ANTI-BAN)
const sendMessage = async (sessionId, number, message, mediaUrl, mediaType, mediaFilename) => {
    const session = activeSessions.get(String(sessionId));
    if (!session?.sock || session.status !== 'open' || !session.sock.user) return false;

    try {
        // ✅ ANTI-BAN: Delay entre mensagens
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

            // ✅ ANTI-BAN: Espaçar restaurações
            await new Promise(resolve => setTimeout(resolve, SESSION_RESTORE_DELAY));
        }

        isRestoringComplete = true;
        console.log('[RESTORE] ✅ Complete');
    } catch (err) {
        console.error('[RESTORE] Error:', err.message);
        isRestoringComplete = true;
    }
};

// ✅ Funções auxiliares (mantidas)
const pauseChatForHuman = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || session.status !== 'open') return false;

    const cacheKey = `state:${chatId}`;
    let stateResult = await cacheManager.get('conversationState', cacheKey);
    let state = stateResult?.value || {};

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
            promises.push(session.sock.end(undefined).catch(() => {}));
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