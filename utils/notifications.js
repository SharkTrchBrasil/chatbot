// utils/notifications.js
import axios from 'axios';

const { FASTAPI_URL, CHATBOT_WEBHOOK_SECRET } = process.env;

/**
 * Envia uma notificação de atualização de status para o backend FastAPI.
 * @param {object} payload Os dados a serem enviados (ex: { storeId, status, qrCode }).
 */
export const notifyFastAPI = async (payload) => {
    if (!FASTAPI_URL) {
        console.warn('FASTAPI_URL is not defined. Skipping notification.');
        return;
    }

    try {
        // ALTERADO: A URL foi corrigida para o endpoint correto do webhook.
        const webhookUrl = `${FASTAPI_URL}/webhooks/chatbot/update`;

        console.log(`Notifying FastAPI at ${webhookUrl} with payload:`, payload);
        await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Secret': CHATBOT_WEBHOOK_SECRET
            }
        });
    } catch (error) {
        // Melhorando o log de erro para mostrar a resposta completa
        const errorResponse = error.response ? error.response.data : error.message;
        console.error('Failed to notify FastAPI:', errorResponse);
    }
};