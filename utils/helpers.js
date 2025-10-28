// utils/helpers.js
// ❌ REMOVIDO: import whatsappService from '../services/whatsappService.js';
import { forwardMessageToFastAPI } from './forwarder.js'; // ✅ ADICIONADO: Importa o forwarder

// ... (getGreeting, replaceVariables, isSameDay permanecem iguais) ...
export const getGreeting = () => {
    // ...
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Bom dia';
    if (hour >= 12 && hour < 18) return 'Boa tarde';
    return 'Boa noite';
};

export const replaceVariables = (template, variables) => {
    // ...
    if (!template) return '';
    let message = template;
    for (const key in variables) {
        const regex = new RegExp(`\\{${key}\\}`, 'g');
        message = message.replace(regex, variables[key]);
    }
    return message;
};

export const isSameDay = (date1, date2) => {
    // ...
    return date1.getFullYear() === date2.getFullYear() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getDate() === date2.getDate();
};


/**
 * Envia uma mensagem com um indicador de "digitando".
 * AGORA USA O SOCKET DIRETAMENTE E CHAMA O FORWARDER.
 */
export const replyWithTyping = async (waSocket, storeId, chatId, message) => {
    if (!message) return;

    try {
        await waSocket.sendPresenceUpdate('composing', chatId);
        await new Promise(resolve => setTimeout(resolve, 1500));
        await waSocket.sendPresenceUpdate('paused', chatId);

        // ✅ CORREÇÃO: Envia diretamente pelo socket
        const result = await waSocket.sendMessage(chatId, { text: message });

        // ✅ CORREÇÃO: Chama o forwarder manualmente
        if (result) {
            // Não usamos await para não bloquear
            forwardMessageToFastAPI(storeId, result, waSocket);
        }

    } catch (e) {
        console.error(`[replyWithTyping] Failed to send message to ${chatId}:`, e);
    }
};
