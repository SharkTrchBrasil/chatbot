// services/whatsappService.js - VERSÃO CORRIGIDA E UNIFICADA (Baileys v7)

import makeWASocket, {
    DisconnectReason,
    // ✅ NOVO: Importar a função de autenticação NATIVA do Baileys
    useMultiFileAuthState,
    makeCacheableSignalKeyStore, // ✅ CORREÇÃO: Importado
    Browsers                  // ✅ CORREÇÃO: Importado
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { notifyFastAPI } from '../utils/notifications.js';
import { processMessage } from '../controllers/chatbotController.js';
// ✅ CORREÇÃO: Importar funções de DB do chatbotService, não o manager
import {
    getStoresToReconnect,
    loadAuthCredentials,
    saveAuthCredentials,
    updateConnectionStatus,
    updateConversationMetadata
} from './chatbotService.js';
import { forwardMessageToFastAPI } from '../utils/forwarder.js'; // ✅ CORREÇÃO: Importa o forwarder
import fs from 'fs-extra';
import path from 'path';
import pino from 'pino';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const activeSessions = new Map();
const PLATFORM_BOT_ID = 'platform';

// ✅ CORREÇÃO: Estado centralizado e EXPORTADO
export const conversationState = {};
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000; // 30 minutos

const sessionMethods = new Map();
const SESSIONS_DIR = path.join(__dirname, '../sessions');
fs.ensureDirSync(SESSIONS_DIR);

const createLogger = (sessionId) => {
    return pino({
        level: 'silent', // Mude para 'debug' para ver mais logs
        timestamp: () => `,"time":"${new Date().toISOString()}"`
    }).child({ session: sessionId });
};

const startSession = async (sessionId, phoneNumber, method) => {
    console.log(`[SESSION ${sessionId}] 🚀 START SESSION - Method: ${method}, Phone: ${phoneNumber}`);
    
    if (activeSessions.has(String(sessionId))) {
        console.log(`[SESSION ${sessionId}] ⚠️ Session already in progress. Ignoring duplicate start.`);
        return;
    }

    if (!method) {
        method = sessionMethods.get(String(sessionId)) || 'qr';
    } else {
        sessionMethods.set(String(sessionId), method);
    }

    const isPlatformBot = sessionId === PLATFORM_BOT_ID;

    try {
        const sessionFolder = path.join(SESSIONS_DIR, String(sessionId));
        
        // ✅ CORREÇÃO: Carrega credenciais do DB primeiro (para ambientes não persistentes)
        let initialCreds = null;
        if (!isPlatformBot) {
            initialCreds = await loadAuthCredentials(sessionId);
            if (initialCreds) {
                console.log(`[SESSION ${sessionId}] 🔐 Credenciais carregadas do DB.`);
                // Garante que o diretório exista e escreve os arquivos de credenciais
                fs.ensureDirSync(sessionFolder);
                Object.keys(initialCreds).forEach(key => {
                    const filePath = path.join(sessionFolder, `${key}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(initialCreds[key]));
                });
            }
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        
        const waSocket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, createLogger(sessionId)),
            },
            browser: Browsers.ubuntu('Chrome'),
            logger: createLogger(sessionId),
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: (jid) => jid?.endsWith('@g.us') || jid?.endsWith('@broadcast'),
            connectTimeoutMs: 20000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            maxRetries: 3, // Aumentado para 3
            // ... (outras configurações do Baileys v7)
            appStateMacVerification: { patch: false, snapshot: false }
        });

        activeSessions.set(String(sessionId), { 
            sock: waSocket, 
            method, 
            status: 'connecting', 
            saveCreds,
            sessionFolder 
        });

        // ✅ MANIPULADOR DE ATUALIZAÇÃO DE CREDENCIAIS
        waSocket.ev.on('creds.update', async () => {
            await saveCreds(); // Salva nos arquivos
            
            // Salva também no banco de dados
            if (!isPlatformBot) {
                try {
                    // Recarrega os arquivos para garantir que está salvando o mais recente
                    const credsFromFiles = {};
                    const files = fs.readdirSync(sessionFolder);
                    for (const file of files) {
                        if (file.endsWith('.json')) {
                            const key = file.replace('.json', '');
                            credsFromFiles[key] = JSON.parse(fs.readFileSync(path.join(sessionFolder, file), 'utf-8'));
                        }
                    }
                    await saveAuthCredentials(sessionId, credsFromFiles);
                } catch (error) {
                    console.error(`[SESSION ${sessionId}] ❌ Erro ao salvar credenciais no banco:`, error);
                }
            }
        });

        // ✅ MANIPULADOR DE ATUALIZAÇÃO DE CONEXÃO
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;
            console.log(`[SESSION ${sessionId}] 🔌 Connection update: ${connection}`);

            if (connection === 'open') {
                console.log(`[SESSION ${sessionId}] ✅ WhatsApp client is ready!`);
                const session = activeSessions.get(String(sessionId));
                if (session) session.status = 'open';

                if (!isPlatformBot) {
                    notifyFastAPI({
                        storeId: sessionId,
                        status: 'connected',
                        whatsappName: waSocket.user?.name || 'Unknown',
                        isActive: true
                    });
                    await updateConnectionStatus(sessionId, 'connected'); // ✅ CORREÇÃO: Chamada de DB correta
                }
            }

            if (qr) {
                console.log(`[SESSION ${sessionId}] 📱 QR Code gerado.`);
                qrcode.generate(qr, { small: true });
                notifyFastAPI({ storeId: sessionId, status: 'awaiting_qr', qrCode: qr });
                if (!isPlatformBot) {
                    await updateConnectionStatus(sessionId, 'awaiting_qr', qr); // ✅ CORREÇÃO
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[SESSION ${sessionId}] ❌ Connection closed. Status: ${statusCode}`);
                
                const session = activeSessions.get(String(sessionId));
                
                if (session && (statusCode === 401 || statusCode === 403 || statusCode === 405)) {
                    console.log(`[SESSION ${sessionId}] 🚨 CRITICAL Auth Error (${statusCode}) - Limpando sessão...`);
                    try {
                        await fs.remove(session.sessionFolder); // Limpa arquivos
                        if (!isPlatformBot) {
                            await saveAuthCredentials(sessionId, {}); // Limpa DB
                        }
                    } catch (e) {
                        console.error(`[SESSION ${sessionId}] ❌ Error clearing session files:`, e);
                    }
                }
                
                activeSessions.delete(String(sessionId));
                sessionMethods.delete(String(sessionId));

                if (shouldReconnect) {
                    console.log(`[SESSION ${sessionId}] 🔄 Reconnecting in 10 seconds...`);
                    if (!isPlatformBot) {
                        await updateConnectionStatus(sessionId, 'error'); // ✅ CORREÇÃO
                    }
                    setTimeout(() => startSession(sessionId, phoneNumber, 'qr'), 10000);
                } else {
                    console.log(`[SESSION ${sessionId}] 🔌 Connection closed permanently.`);
                    if (!isPlatformBot) {
                        await updateConnectionStatus(sessionId, 'disconnected'); // ✅ CORREÇÃO
                    }
                }
            }
        });

        // ✅ MANIPULADOR DE MENSAGENS
        waSocket.ev.on('messages.upsert', async (m) => {
            for (const msg of m.messages) {
                if (msg.key.fromMe || !msg.message) continue;
                
                const chatId = msg.key.remoteJid;
                
                // ✅ CORREÇÃO: Lógica de estado centralizada
                if (!conversationState[chatId]) {
                    conversationState[chatId] = {};
                }
                const state = conversationState[chatId];
                
                if (state.humanSupportUntil && new Date() < new Date(state.humanSupportUntil)) {
                    console.log(`[SESSION ${sessionId}] ⏸️ Chat paused. Skipping.`);
                    // Reseta o timer de pausa
                    state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
                    continue;
                } else if (state.humanSupportUntil) {
                    state.humanSupportUntil = null; // Limpa se o tempo expirou
                }
                
                if (!isPlatformBot) {
                    // ✅ CORREÇÃO: Passa o 'state' para o controller
                    await processMessage(msg, sessionId, waSocket, state); 
                    await updateConversationMetadata(sessionId, msg); // ✅ CORREÇÃO
                }
            }
        });

        // ✅ CÓDIGO DE PAIRING
        if (method === 'pairing' && phoneNumber) {
            try {
                console.log(`[SESSION ${sessionId}] 🔐 Requesting pairing code for ${phoneNumber}...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                const code = await waSocket.requestPairingCode(phoneNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                console.log(`[SESSION ${sessionId}] ✅ Pairing Code: ${formattedCode}`);
                
                notifyFastAPI({ storeId: sessionId, status: 'awaiting_pairing_code', pairingCode: code });
                if (!isPlatformBot) {
                    await updateConnectionStatus(sessionId, 'awaiting_pairing_code', null, code); // ✅ CORREÇÃO
                }
            } catch (e) {
                console.error(`[SESSION ${sessionId}] ❌ Failed to request pairing code:`, e);
                notifyFastAPI({ storeId: sessionId, status: 'error', error: e.message });
                if (!isPlatformBot) {
                    await updateConnectionStatus(sessionId, 'error'); // ✅ CORREÇÃO
                }
            }
        }
    } catch (error) {
        console.error(`[SESSION ${sessionId}] 💥 FAILED to start session:`, error);
        notifyFastAPI({ storeId: sessionId, status: 'error', error: error.message });
        if (!isPlatformBot) {
            await updateConnectionStatus(sessionId, 'error'); // ✅ CORREÇÃO
        }
    }
};

const disconnectSession = async (sessionId) => {
    console.log(`[SESSION ${sessionId}] 🛑 Disconnect session requested`);
    const session = activeSessions.get(String(sessionId));
    
    if (session?.sock) {
        await session.sock.logout();
    } else {
        console.log(`[SESSION ${sessionId}] ⚠️ No active session, cleaning files...`);
    }
    
    try {
        const sessionFolder = path.join(SESSIONS_DIR, String(sessionId));
        await fs.remove(sessionFolder);
    } catch (e) {
        console.error(`[SESSION ${sessionId}] ❌ Error clearing session files:`, e);
    }
    
    const isPlatformBot = sessionId === PLATFORM_BOT_ID;
    if (!isPlatformBot) {
        await saveAuthCredentials(sessionId, {}); // Limpa credenciais do DB
        await updateConnectionStatus(sessionId, 'disconnected'); // Atualiza status no DB
        notifyFastAPI({ storeId: sessionId, status: 'disconnected' });
    }
};

const sendMessage = async (sessionId, number, message, mediaUrl, mediaType, mediaFilename, isPlatform = false) => {
    const logPrefix = isPlatform ? '[PLATFORM BOT]' : `[SESSION ${sessionId}]`;
    const session = activeSessions.get(String(sessionId));

    if (!session || !session.sock || !session.sock.user?.id) {
        console.warn(`${logPrefix} SEND BLOCKED! Session not ready.`);
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

        console.log(`${logPrefix} 📤 Sending message to ${chatId}`);
        const result = await session.sock.sendMessage(chatId, messagePayload);

        // ✅ CORREÇÃO: Encaminha usando o 'forwarder'
        if (result && !isPlatform) {
            // Não usamos await para não bloquear a resposta
            forwardMessageToFastAPI(sessionId, result, session.sock);
        }
        
        console.log(`${logPrefix} ✅ Message sent successfully`);
        return true;
    } catch (e) {
        console.error(`${logPrefix} ❌ CRITICAL ERROR sending message:`, e);
        throw e; // Lança o erro para ser tratado pela apiRoute
    }
};

const restoreActiveSessions = async () => {
    console.log('--- Restoring active sessions ---');
    try {
        const storesToReconnect = await getStoresToReconnect(); // ✅ CORREÇÃO
        console.log(`📋 Found ${storesToReconnect.length} stores to reconnect`);
        
        for (const store of storesToReconnect) {
            console.log(`[RESTORING] Store ${store.store_id} - Attempting...`);
            startSession(String(store.store_id), undefined, undefined);
        }
    } catch (e) {
        console.error('❌ Error while restoring sessions:', e);
    }
};

const pauseChatForHuman = (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session || !session.sock || !session.sock.user?.id) {
        console.warn(`[STORE ${storeId}] Cannot pause chat. Session not connected.`);
        return false;
    }

    // ✅ CORREÇÃO: Usa o 'conversationState' centralizado e exportado
    if (!conversationState[chatId]) {
        conversationState[chatId] = {};
    }
    
    conversationState[chatId].humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
    console.log(`[STORE ${storeId}] Chat with ${chatId} paused for 30 minutes.`);
    return true;
};

// ... (getProfilePictureUrl e getContactName permanecem os mesmos) ...
const getProfilePictureUrl = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session?.sock?.user?.id) return null;
    try {
        return await session.sock.profilePictureUrl(chatId, 'image');
    } catch (e) {
        return null;
    }
};

const getContactName = async (storeId, chatId) => {
    const session = activeSessions.get(String(storeId));
    if (!session?.sock?.user?.id) return null;
    try {
        const contact = await session.sock.getContactById(chatId);
        return contact?.name || contact?.notify || contact?.pushName;
    } catch (e) {
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
    console.log('[SHUTTING DOWN] All clients terminated. Exiting.');
    process.exit(0);
};

// ✅ NOVO: Exporta 'getSessionStatus'
const getSessionStatus = (storeId) => {
    const session = activeSessions.get(String(storeId));
    if (session) {
        return {
            status: session.status,
            method: session.method,
            isConnected: session.status === 'open'
        };
    }
    return { status: 'disconnected', method: null, isConnected: false };
};


export default {
    activeSessions,
    startSession,
    disconnectSession,
    sendMessage,
    getSessionStatus, // ✅ Exportado
    restoreActiveSessions,
    shutdown,
    pauseChatForHuman,
    sendPlatformMessage,
    getProfilePictureUrl,
    getContactName
};
