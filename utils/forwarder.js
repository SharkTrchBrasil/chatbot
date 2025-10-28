// utils/forwarder.js
// ✅ NOVO ARQUIVO: Criado para quebrar a dependência circular.

import axios from 'axios';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { Blob } from 'buffer';
import FormData from 'form-data';

/**
 * Encaminha a mensagem (com ou sem mídia) para o backend FastAPI.
 */
export const forwardMessageToFastAPI = async (storeId, msg, waSocket) => {
    console.log(`[FORWARDER] Starting forwarding for message UID: ${msg.key.id}`);

    const { FASTAPI_URL, CHATBOT_WEBHOOK_SECRET } = process.env;
    if (!FASTAPI_URL || !CHATBOT_WEBHOOK_SECRET) {
        console.warn('[FORWARDER] FASTAPI_URL or CHATBOT_WEBHOOK_SECRET not set. Skipping.');
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
        } else if (msg.message?.documentMessage) {
            mediaMessage = msg.message.documentMessage;
            contentType = 'document';
        }

        form.append('store_id', String(storeId));
        form.append('chat_id', msg.key.remoteJid);
        form.append('sender_id', msg.key.fromMe ? (waSocket.user.id) : (msg.key.participant || msg.key.remoteJid));
        form.append('message_uid', msg.key.id);
        form.append('content_type', contentType);
        form.append('is_from_me', String(msg.key.fromMe));
        form.append('timestamp', String(msg.messageTimestamp));
        form.append('customer_name', msg.pushName || 'Cliente');

        if (messageContent) {
            form.append('text_content', messageContent);
        }

        if (mediaMessage) {
            const mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
            const finalMimeType = mediaMessage.mimetype;
            let finalFilename = 'file';

            if (contentType === 'document' && mediaMessage.fileName) {
                finalFilename = mediaMessage.fileName;
            } else {
                const extension = finalMimeType.split('/')[1]?.split(';')[0] || 'bin';
                finalFilename = `${contentType}-${msg.key.id}.${extension}`;
            }

            form.append('media_filename_override', finalFilename);
            form.append('media_mimetype_override', finalMimeType);

            const mediaBlob = new Blob([mediaBuffer]);
            form.append('media_file', mediaBlob, finalFilename);
        }

        await axios.post(webhookUrl, form, {
            headers: { 'x-webhook-secret': CHATBOT_WEBHOOK_SECRET }
        });

        console.log(`[FORWARDER] ✅ Success! Message ${msg.key.id} forwarded to backend.`);

    } catch (e) {
        console.error(`[FORWARDER] ❌ ERROR forwarding message ${msg.key.id}:`, e.message);
        if (e.response) {
            console.error('[FORWARDER] Server response:', e.response.data);
        }
    }
};
