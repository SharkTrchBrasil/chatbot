// services/whatsappService.js - VERSÃO FINAL COMPLETA E CORRIGIDA

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

// ============================================================
// 🔧 CONFIGURAÇÕES GLOBAIS
// ============================================================

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000; // 30 minutos
const MAX_RESTORE_ATTEMPTS = 3;
const SESSION_RESTORE_DELAY = 10000; // 10 segundos

let isRestoringComplete = false;

// ✅ Diretório para autenticação
const AUTH_DIR = path.join(__dirname, '..', 'auth_sessions');

// ✅ ANTI-BAN: Delays e controles
const OPERATION_DELAY = 2000; // 2 segundos entre operações
const antiSpamDelay = () => new Promise(resolve => setTimeout(resolve, OPERATION_DELAY));
const credsSaveTimers = new Map(); // Timer para throttle de salvamento

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

// Executar limpeza a cada 2 minutos
setInterval(cleanupProcessedMessages, 120000);

// ============================================================
// 📁 FUNÇÕES DE GERENCIAMENTO DE AUTENTICAÇÃO
// ============================================================

/**
 * Garante que o diretório de autenticação existe
 */
const ensureAuthDir = async () => {
    try {
        await fs.mkdir(AUTH_DIR, { recursive: true });
    } catch (err) {
        console.error('[AUTH] Failed to create dir:', err.message);
    }
};

/**
 * Salva credenciais no banco de dados
 */
const saveCredsToDatabase = async (sessionId, creds) => {
    const client = await pool.connect();
    try {
        // Limpar credenciais antigas
        await client.query(
            'DELETE FROM chatbot_auth_credentials WHERE session_id = $1',
            [`store_${sessionId}`]
        );

        // Salvar nova credencial
        await client.query(
            `INSERT INTO chatbot_auth_credentials (session_id, cred_id, cred_value, updated_at)
             VALUES ($1, $2, $3, NOW())`,
            [`store_${sessionId}`, 'creds', creds]
        );

        console.log(`[DB] ✅ Credentials saved for store ${sessionId}`);
    } catch (err) {
        console.error(`[DB] Failed to save creds for store ${sessionId}:`, err.message);
    } finally {
        client.release();
    }
};

/**
 * Carrega credenciais do banco de dados
 */
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

/**
 * Limpa credenciais do banco de dados
 */
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

/**
 * Limpa todas as conversas e mensagens de uma loja
 */
const cleanupStoreConversations = async (storeId) => {
    const client = await pool.connect();
    try {
        console.log(`[CLEANUP] 🧹 Starting cleanup for store ${storeId}...`);

        // 1. Deletar mensagens
        const messagesResult = await client.query(
            'DELETE FROM chatbot_messages WHERE store_id = $1',
            [storeId]
        );
        console.log(`[CLEANUP] ✅ Deleted ${messagesResult.rowCount} messages`);

        // 2. Deletar metadados
        const metadataResult = await client.query(
            'DELETE FROM chatbot_conversation_metadata WHERE store_id = $1',
            [storeId]
        );
        console.log(`[CLEANUP] ✅ Deleted ${metadataResult.rowCount} conversation metadata entries`);

        // 3. Limpar cache usando deletePattern
        try {
            const deletedCount = await cacheManager.deletePattern('conversationState', '*');
            console.log(`[CLEANUP] ✅ Cleared ${deletedCount} cache entries`);
        } catch (err) {
            console.warn(`[CLEANUP] ⚠️ Cache clear warning:`, err.message);
        }

        // 4. Limpar mensagens processadas do Map
        for (const [key] of processedMessages.entries()) {
            if (key.startsWith(`${storeId}:`)) {
                processedMessages.delete(key);
            }
        }
        console.log(`[CLEANUP] ✅ Cleared processed messages map for store ${storeId}`);

        console.log(`[CLEANUP] ✅ Cleanup complete for store ${storeId}`);
        return true;

    } catch (err) {
        console.error(`[CLEANUP] ❌ Error cleaning store ${storeId}:`, err.message);
        return false;
    } finally {
        client.release();
    }
};

/**
 * Obtém ou cria o estado de autenticação
 */
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

/**
 * Limpa o estado de autenticação (filesystem + database)
 */
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

/**
 * Cria logger personalizado com supressão de warnings desnecessários
 */
const createLogger = (sessionId) => ({
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (msg) => {
        // Converter para string primeiro
        const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);

        if (msgStr.includes('myAppStateKeyId') || msgStr.includes('no name present')) {
            return;
        }
        console.warn(`[SESSION ${sessionId}][WARN]`, msgStr);
    },
    error: (msg) => {
        // Converter para string primeiro
        const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);

        if (typeof msg === 'object' && msg?.node?.attrs?.code === '515') {
            return;
        }
        console.error(`[SESSION ${sessionId}][ERROR]`, msgStr);
    },
    child: () => createLogger(sessionId)
});

// ============================================================
// 🚀 FUNÇÃO PRINCIPAL: startSession
// ============================================================

/**
 * Inicia ou reconecta uma sessão do WhatsApp
 * @param {string|number} sessionId - ID da loja
 * @param {string} phoneNumber - Número para pairing code
 * @param {string} method - 'qr' ou 'pairing'
 * @param {number} attempt - Tentativa atual (para retry)
 */
const startSession = async (sessionId, phoneNumber, method, attempt = 1) => {
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

            getMessage: async (key) => {
                return { conversation: '' };
            },

            // Timeouts aumentados
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 45000,
            qrTimeout: 60000,

            // Filtros
            shouldIgnoreJid: (jid) => {
                return jid.endsWith('@g.us') ||
                       jid.endsWith('@broadcast') ||
                       jid === 'status@broadcast';
            },

            // ANTI-BAN: Retry conservador
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 2,

            // Link preview
            linkPreviewImageThumbnailWidth: 192,
            transactionOpts: {
                maxCommitRetries: 2,
                delayBetweenTriesMs: 500
            }
        });

        sessionEntry.sock = waSocket;

        // ============================================================
        // EVENT: Salvar credenciais (COM THROTTLE)
        // ============================================================
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

        // ============================================================
        // EVENT: Connection Update
        // ============================================================
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (connection === 'connecting') {
                sessionEntry.status = 'connecting';
                console.log(`[SESSION ${sessionId}] 🔄 Connecting...`);
            }

            if (connection === 'open') {
                // Validação: Aguardar user ID
                if (!waSocket.user?.id) {
                    console.warn(`[SESSION ${sessionId}] ⚠️ Connection open, but no user ID yet`);
                    return;
                }

                // Evitar notificações duplicadas
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

                // Delay antes de notificar
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
                // Evitar notificar QR múltiplas vezes
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
                const shouldNotifyDisconnect = sessionEntry.lastNotifiedStatus === 'open';

                // MAPEAMENTO DE ERROS CLAROS
                const errorMessages = {
                    401: 'Device removed - User logged out from phone',
                    403: 'Access forbidden',
                    408: 'Request timeout',
                    440: 'Device logout',
                    428: 'Connection closed',
                    515: 'Rate limit exceeded',
                    503: 'Service unavailable'
                };

                const errorMsg = errorMessages[statusCode] || `Unknown error (${statusCode})`;
                console.log(`[SESSION ${sessionId}] ❌ Closed: ${errorMsg}`);

                // TRATAMENTO ESPECÍFICO POR CÓDIGO
                const criticalErrors = [401, 403, 440, DisconnectReason.loggedOut];

                if (criticalErrors.includes(statusCode)) {
                    console.log(`[SESSION ${sessionId}] 🗑️ Critical error - cleaning up...`);

                    // Limpar auth e conversas
                    await Promise.all([
                        clearAuthState(sessionId),
                        cleanupStoreConversations(sessionId)
                    ]);

                    // Não reconectar em erros críticos
                    activeSessions.delete(String(sessionId));

                    // Notificar desconexão definitiva
                    if (sessionId !== PLATFORM_BOT_ID && shouldNotifyDisconnect) {
                        notifyFastAPI({
                            storeId: sessionId,
                            status: 'disconnected',
                            reason: errorMsg,
                            requiresManualReconnection: true
                        }).catch(() => {});
                    }

                    return; // Parar aqui
                }

                // RATE LIMIT (515) - Aguardar mais tempo
                if (statusCode === 515) {
                    console.log(`[SESSION ${sessionId}] ⏳ Rate limit - waiting 60s before retry`);

                    if (attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
                        activeSessions.delete(String(sessionId));

                        setTimeout(() => {
                            startSession(sessionId, phoneNumber, method, attempt + 1);
                        }, 60000); // 60 segundos
                    }
                    return;
                }

                // RECONEXÃO AUTOMÁTICA PARA ERROS TEMPORÁRIOS
                if (shouldReconnect && attempt < MAX_RESTORE_ATTEMPTS && isRestoringComplete) {
                    // Backoff exponencial
                    let delay = SESSION_RESTORE_DELAY * Math.pow(2, attempt - 1);
                    delay = Math.min(delay, 120000); // Máximo 2 minutos

                    console.log(`[SESSION ${sessionId}] ⏳ Retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${MAX_RESTORE_ATTEMPTS})`);

                    activeSessions.delete(String(sessionId));

                    setTimeout(() => {
                        startSession(sessionId, phoneNumber, method, attempt + 1);
                    }, delay);
                } else {
                    console.log(`[SESSION ${sessionId}] ⛔ Max retries reached or not reconnectable`);
                    activeSessions.delete(String(sessionId));
                }

                // NOTIFICAR DESCONEXÃO (só se estava conectado)
                if (sessionId !== PLATFORM_BOT_ID && shouldNotifyDisconnect && !sessionEntry.isNotifying) {
                    sessionEntry.isNotifying = true;

                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'disconnected',
                        reason: errorMsg,
                        willRetry: shouldReconnect && attempt < MAX_RESTORE_ATTEMPTS
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
                        // Validações básicas
                        if (!msg?.key?.remoteJid || !msg.message || msg.key.fromMe) continue;

                        const chatId = msg.key.remoteJid;
                        const messageId = msg.key.id;

                        // Filtrar grupos e broadcasts
                        if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast') || chatId === 'status@broadcast') {
                            continue;
                        }

                        // CRÍTICO: Deduplicação de mensagens
                        const dedupKey = `${sessionId}:${chatId}:${messageId}`;
                        if (processedMessages.has(dedupKey)) {
                            console.log(`[SESSION ${sessionId}] ⏭️ Skipping duplicate message: ${messageId}`);
                            continue;
                        }

                        // CRÍTICO: Ignorar mensagens muito antigas (mais de 5 minutos)
                        const messageTimestamp = msg.messageTimestamp * 1000;
                        const messageAge = Date.now() - messageTimestamp;

                        if (messageAge > 5 * 60 * 1000) {
                            console.log(`[SESSION ${sessionId}] ⏭️ Skipping old message (${Math.floor(messageAge / 1000)}s old): ${messageId}`);
                            processedMessages.set(dedupKey, Date.now()); // Marcar como processada
                            continue;
                        }

                        // Validar conteúdo da mensagem
                        const hasContent = msg.message?.conversation ||
                                          msg.message?.extendedTextMessage?.text ||
                                          msg.message?.imageMessage ||
                                          msg.message?.audioMessage ||
                                          msg.message?.videoMessage ||
                                          msg.message?.documentMessage;

                        if (!hasContent) {
                            console.log(`[SESSION ${sessionId}] ⏭️ Skipping message without content: ${messageId}`);
                            continue;
                        }

                        // Marcar como processada
                        processedMessages.set(dedupKey, Date.now());

                        // Anti-spam
                        sessionEntry.messageCount++;
                        if (sessionEntry.messageCount > 50) {
                            await antiSpamDelay();
                            sessionEntry.messageCount = 0;
                        }

                        // Processar apenas mensagens de clientes (não da plataforma)
                        if (sessionId !== PLATFORM_BOT_ID) {
                            // Atualizar metadata (sem bloquear)
                            updateConversationMetadata(sessionId, msg).catch((err) => {
                                console.error(`[SESSION ${sessionId}] Metadata update failed:`, err.message);
                            });

                            // Obter estado da conversa
                            const cacheKey = `state:${chatId}`;
                            let stateResult = await cacheManager.get('conversationState', cacheKey);
                            let state = stateResult?.value || {};

                            // Verificar se está pausado para suporte humano
                            if (!state.humanSupportUntil || new Date() >= new Date(state.humanSupportUntil)) {
                                // Processar mensagem com o chatbot
                                await processMessage(msg, sessionId, waSocket, state).catch(err => {
                                    console.error(`[SESSION ${sessionId}] Message processing error:`, err.message);
                                });

                                // Salvar estado atualizado
                                await cacheManager.set('conversationState', cacheKey, state, INACTIVITY_PAUSE_MS / 1000);
                            } else {
                                console.log(`[SESSION ${sessionId}] Chat ${chatId} paused for human support`);
                            }
                        }

                        // Encaminhar para FastAPI (sem bloquear)
                        forwardMessageToFastAPI(sessionId, msg, waSocket).catch((err) => {
                            console.error(`[SESSION ${sessionId}] Forward failed for ${messageId}:`, err.message);
                        });
                    }
                });

                // ============================================================
                // PAIRING CODE (se método for 'pairing')
                // ============================================================
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

        // ============================================================
        // 🔧 FUNÇÕES AUXILIARES
        // ============================================================

        /**
         * Desconecta uma sessão e limpa todos os dados
         */
        const disconnectSession = async (sessionId) => {
            const session = activeSessions.get(String(sessionId));
            try {
                if (session?.sock) {
                    session.sock.logout();
                }

                // Limpar conversas ao desconectar
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
         * Envia mensagem (COM ANTI-BAN)
         */
        const sendMessage = async (sessionId, number, message, mediaUrl, mediaType, mediaFilename) => {
            const session = activeSessions.get(String(sessionId));
            if (!session?.sock || session.status !== 'open' || !session.sock.user) return false;

            try {
                // ANTI-BAN: Delay entre mensagens
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

        /**
         * Restaura todas as sessões ativas do banco
         */
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

                    // ANTI-BAN: Espaçar restaurações
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
         * Pausa chat para suporte humano
         */
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

        /**
         * Obtém URL da foto de perfil
         */
        const getProfilePictureUrl = async (storeId, chatId) => {
            const session = activeSessions.get(String(storeId));
            if (!session?.sock || session.status !== 'open') return null;

            try {
                return await session.sock.profilePictureUrl(chatId, 'image');
            } catch {
                return null;
            }
        };

        /**
         * Obtém nome do contato
         */
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

        /**
         * Envia mensagem pelo bot da plataforma
         */
        const sendPlatformMessage = async (number, message) => {
            return await sendMessage(PLATFORM_BOT_ID, number, message, null, null, null);
        };

        /**
         * Obtém socket de uma loja específica
         */
        const getSocketForStore = (storeId) => {
            const session = activeSessions.get(String(storeId));
            return (session && session.sock && session.status === 'open') ? session.sock : null;
        };

        /**
         * Shutdown graceful de todas as sessões
         */
        const shutdown = async () => {
            console.log('[SHUTDOWN] 🛑 Starting...');

            // Limpar timers de salvamento de credenciais
            for (const timer of credsSaveTimers.values()) {
                clearTimeout(timer);
            }
            credsSaveTimers.clear();

            // Limpar mapa de mensagens processadas
            processedMessages.clear();

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

        // ============================================================
        // 📤 EXPORTS
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
            getSocketForStore
        };