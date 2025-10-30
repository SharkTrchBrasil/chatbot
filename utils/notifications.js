// utils/notifications.js
import { postJsonSigned } from './httpClient.js';

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
        const webhookUrl = `${FASTAPI_URL}/webhooks/chatbot/update`;
        const correlationId = payload?.correlationId || `notif-${Date.now()}`;
        console.log(`Notifying FastAPI at ${webhookUrl}`);
        await postJsonSigned(webhookUrl, payload, CHATBOT_WEBHOOK_SECRET, correlationId);
    } catch (error) {
        // Melhorando o log de erro para mostrar a resposta completa
        const errorResponse = error.response ? error.response.data : error.message;
        console.error('Failed to notify FastAPI:', errorResponse);
    }
};