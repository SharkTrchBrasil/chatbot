// utils/forwarder.js - VERSÃO CORRIGIDA E SEGURA

import axios from 'axios';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { Blob } from 'buffer';
import FormData from 'form-data';
import pool from '../config/database.js'; // ✅ CORREÇÃO: Usar pool centralizado

// ✅ Whitelist de mimetypes permitidos
const ALLOWED_MIMETYPES = [
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
    'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/wav',
    'video/mp4', 'video/3gpp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'text/plain'
];

// ✅ Constantes de configuração
const MAX_MEDIA_SIZE = 16 * 1024 * 1024; // 16MB
const MAX_RETRIES = 3;
const BASE_DELAY = 2000;
const MEDIA_DOWNLOAD_TIMEOUT = 30000;
const REQUEST_TIMEOUT = 30000;

// ✅ NOVA: Função para salvar em Dead Letter Queue
const saveToDLQ = async (storeId, msg, error) => {
    try {
        const query = `
            INSERT INTO message_dlq
            (store_id, message_uid, chat_id, payload, error_message, retry_count, next_retry_at)
            VALUES ($1, $2, $3, $4, $5, 0, NOW() + INTERVAL '5 minutes')
            ON CONFLICT (store_id, message_uid)
            DO UPDATE SET
                error_message = EXCLUDED.error_message,
                retry_count = message_dlq.retry_count + 1,
                next_retry_at = NOW() + INTERVAL '5 minutes' * (message_dlq.retry_count + 1),
                updated_at = NOW()
        `;

        await pool.query(query, [
            storeId,
            msg.key.id,
            msg.key.remoteJid,
            JSON.stringify(msg),
            error.message || 'Unknown error'
        ]);

        console.log(`[DLQ] ✅ Message ${msg.key.id} saved for retry`);
        return true;
    } catch (dlqErr) {
        console.error(`[DLQ] ❌ CRITICAL: Failed to save to DLQ:`, dlqErr.message);
        return false;
    }
};

// ✅ Função auxiliar para retry com backoff exponencial
const retryWithBackoff = async (fn, maxRetries = MAX_RETRIES, baseDelay = BASE_DELAY) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const isLastAttempt = attempt === maxRetries;
            const isServerError = error.response?.status >= 500;
            const isNetworkError = error.code === 'ECONNREFUSED' ||
                                  error.code === 'ETIMEDOUT' ||
                                  error.code === 'ENOTFOUND';

            // ✅ Não fazer retry em erros de cliente (4xx)
            if (error.response?.status >= 400 && error.response?.status < 500) {
                throw error;
            }

            if (isLastAttempt) {
                throw error;
            }

            // ✅ Só fazer retry em erros de servidor ou rede
            if (isServerError || isNetworkError) {
                const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 10000);
                console.log(`[FORWARDER] ⏳ Retry attempt ${attempt}/${maxRetries} in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
};

// ✅ Validar e sanitizar filename
const sanitizeFilename = (filename) => {
    if (!filename) return 'file';

    return filename
        .replace(/[^a-zA-Z0-9._-]/g, '_') // Remove caracteres especiais
        .replace(/\.{2,}/g, '.') // Remove múltiplos pontos
        .replace(/^\.+/, '') // Remove pontos no início
        .substring(0, 255); // Limitar tamanho
};

// ✅ Validar mimetype
const isAllowedMimetype = (mimetype) => {
    if (!mimetype) return false;
    const normalizedMime = mimetype.toLowerCase().split(';')[0].trim();
    return ALLOWED_MIMETYPES.some(allowed => normalizedMime === allowed.toLowerCase());
};

/**
 * ✅ VERSÃO CORRIGIDA E ROBUSTA
 * Encaminha mensagem para o backend FastAPI com retry e DLQ
 */
export const forwardMessageToFastAPI = async (storeId, msg, waSocket) => {
    console.log(`[FORWARDER] Starting forwarding for message UID: ${msg.key.id}`);

    const { FASTAPI_URL, CHATBOT_WEBHOOK_SECRET } = process.env;

    if (!FASTAPI_URL || !CHATBOT_WEBHOOK_SECRET) {
        console.warn('[FORWARDER] ⚠️ FASTAPI_URL or SECRET not set. Skipping.');
        return;
    }

    // ✅ VALIDAÇÃO: waSocket deve ter user
    if (!waSocket || !waSocket.user || !waSocket.user.id) {
        console.warn('[FORWARDER] ⚠️ waSocket.user not ready. Skipping forward.');
        return;
    }

    const webhookUrl = `${FASTAPI_URL}/webhooks/chatbot/new-message`;

    try {
        const form = new FormData();
        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

        let mediaMessage = null;
        let contentType = 'text';

        if (msg.message?.imageMessage) {
            mediaMessage = msg.message.imageMessage;
            contentType = 'image';
        } else if (msg.message?.audioMessage) {
            mediaMessage = msg.message.audioMessage;
            contentType = 'audio';
        } else if (msg.message?.videoMessage) {
            mediaMessage = msg.message.videoMessage;
            contentType = 'video';
        } else if (msg.message?.documentMessage) {
            mediaMessage = msg.message.documentMessage;
            contentType = 'document';
        }

        // ✅ CORREÇÃO: sender_id com fallback seguro
        const senderId = msg.key.fromMe
            ? waSocket.user.id.split(':')[0] // Usar apenas número
            : (msg.key.participant || msg.key.remoteJid).split('@')[0];

        form.append('store_id', String(storeId));
        form.append('chat_id', msg.key.remoteJid);
        form.append('sender_id', senderId);
        form.append('message_uid', msg.key.id);
        form.append('content_type', contentType);
        form.append('is_from_me', String(msg.key.fromMe));
        form.append('timestamp', String(msg.messageTimestamp));
        form.append('customer_name', msg.pushName || 'Cliente');

        if (messageContent) {
            form.append('text_content', messageContent);
        }

        // ✅ CORREÇÃO: Validação e sanitização de mídia
        if (mediaMessage) {
            const mimetype = mediaMessage.mimetype;

            // ✅ SEGURANÇA: Validar mimetype
            if (!isAllowedMimetype(mimetype)) {
                console.warn(`[FORWARDER] ⚠️ Blocked unsafe mimetype: ${mimetype} for message ${msg.key.id}`);
                form.append('media_blocked', 'true');
                form.append('blocked_mimetype', mimetype);
            } else {
                try {
                    // ✅ Download com timeout
                    const mediaBuffer = await Promise.race([
                        downloadMediaMessage(msg, 'buffer', {}),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Media download timeout')), MEDIA_DOWNLOAD_TIMEOUT)
                        )
                    ]);

                    // ✅ SEGURANÇA: Validar tamanho
                    if (mediaBuffer.length > MAX_MEDIA_SIZE) {
                        console.warn(`[FORWARDER] ⚠️ Media too large: ${mediaBuffer.length} bytes`);
                        form.append('media_too_large', 'true');
                        form.append('media_size', String(mediaBuffer.length));
                    } else {
                        let finalFilename = 'file';

                        if (contentType === 'document' && mediaMessage.fileName) {
                            finalFilename = sanitizeFilename(mediaMessage.fileName);
                        } else {
                            const extension = mimetype.split('/')[1]?.split(';')[0] || 'bin';
                            finalFilename = sanitizeFilename(`${contentType}-${Date.now()}.${extension}`);
                        }

                        form.append('media_filename_override', finalFilename);
                        form.append('media_mimetype_override', mimetype);

                        const mediaBlob = new Blob([mediaBuffer]);
                        form.append('media_file', mediaBlob, finalFilename);
                    }
                } catch (downloadErr) {
                    console.error(`[FORWARDER] ❌ Failed to download media:`, downloadErr.message);
                    form.append('media_download_failed', 'true');
                    form.append('media_error', downloadErr.message);
                }
            }
        }

        // ✅ CORREÇÃO: Enviar com retry automático
        await retryWithBackoff(async () => {
            const response = await axios.post(webhookUrl, form, {
                headers: {
                    'x-webhook-secret': CHATBOT_WEBHOOK_SECRET,
                    ...form.getHeaders()
                },
                timeout: REQUEST_TIMEOUT,
                maxContentLength: 20 * 1024 * 1024,
                maxBodyLength: 20 * 1024 * 1024
            });

            if (response.status >= 500) {
                throw new Error(`Server error: ${response.status}`);
            }

            return response;
        });

        console.log(`[FORWARDER] ✅ Message ${msg.key.id} forwarded successfully`);

    } catch (error) {
        console.error(`[FORWARDER] ❌ ERROR forwarding message ${msg.key.id}:`, error.message);

        if (error.response) {
            console.error('[FORWARDER] Server response:', {
                status: error.response.status,
                data: JSON.stringify(error.response.data).substring(0, 200)
            });
        }

        // ✅ CORREÇÃO: Salvar em DLQ para retry posterior
        const dlqSaved = await saveToDLQ(storeId, msg, error);

        if (!dlqSaved) {
            console.error('[FORWARDER] 🚨 CRITICAL: Message lost! UID:', msg.key.id);
        }
    }
};

// ✅ NOVA: Função para processar mensagens da DLQ
export const processMessageDLQ = async (getSocketForStore) => {
    try {
        const query = `
            SELECT id, store_id, message_uid, payload, retry_count
            FROM message_dlq
            WHERE retry_count < 5
            AND next_retry_at <= NOW()
            ORDER BY created_at ASC
            LIMIT 10
        `;

        const { rows } = await pool.query(query);

        if (rows.length === 0) {
            return;
        }

        console.log(`[DLQ] Processing ${rows.length} failed messages...`);

        for (const row of rows) {
            try {
                const msg = JSON.parse(row.payload);
                const storeId = row.store_id;

                // ✅ Obter socket da sessão ativa
                const waSocket = getSocketForStore(storeId);

                if (!waSocket) {
                    console.warn(`[DLQ] Session not active for store ${storeId}. Skipping.`);
                    continue;
                }

                // ✅ Tentar reenviar
                await forwardMessageToFastAPI(storeId, msg, waSocket);

                // ✅ Remover da DLQ se sucesso
                await pool.query('DELETE FROM message_dlq WHERE id = $1', [row.id]);
                console.log(`[DLQ] ✅ Message ${row.message_uid} reprocessed successfully`);

            } catch (retryError) {
                // ✅ Incrementar contador de retry
                await pool.query(`
                    UPDATE message_dlq
                    SET retry_count = retry_count + 1,
                        next_retry_at = NOW() + INTERVAL '5 minutes' * (retry_count + 2),
                        error_message = $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [retryError.message, row.id]);

                console.error(`[DLQ] ❌ Retry failed for ${row.message_uid}:`, retryError.message);
            }
        }
    } catch (error) {
        console.error('[DLQ] ❌ Error processing DLQ:', error.message);
    }
};

// ✅ NOVA: Cleanup de mensagens antigas da DLQ
export const cleanupOldDLQMessages = async () => {
    try {
        const result = await pool.query(`
            DELETE FROM message_dlq
            WHERE (retry_count >= 5 AND created_at < NOW() - INTERVAL '7 days')
               OR created_at < NOW() - INTERVAL '30 days'
        `);

        if (result.rowCount > 0) {
            console.log(`[DLQ] 🗑️ Cleaned up ${result.rowCount} old messages`);
        }
    } catch (error) {
        console.error('[DLQ] ❌ Cleanup failed:', error.message);
    }
};

// ✅ NOVA: Iniciar processamento periódico da DLQ
export const startDLQProcessor = (getSocketForStore) => {
    const PROCESS_INTERVAL = 5 * 60 * 1000; // 5 minutos
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 horas

    // Processar DLQ a cada 5 minutos
    setInterval(() => {
        processMessageDLQ(getSocketForStore).catch(err => {
            console.error('[DLQ] Processor error:', err.message);
        });
    }, PROCESS_INTERVAL);

    // Cleanup a cada 24 horas
    setInterval(() => {
        cleanupOldDLQMessages().catch(err => {
            console.error('[DLQ] Cleanup error:', err.message);
        });
    }, CLEANUP_INTERVAL);

    console.log('[DLQ] ✅ Processor started (process: 5min, cleanup: 24h)');
};