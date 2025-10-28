// controllers/chatbotController.js

// ✅ CORREÇÃO: Importa as funções de DB que agora são exportadas
import {
    checkStoreStatus,
    getCustomMessage,
    getStoreName,
    getBusinessHours,
    getMenuLinkSlug,
    getActiveCoupons,
    getStoreAddress,
    getTodaysOrderStatusByPhone
} from '../services/chatbotService.js';
import {
    replaceVariables,
    isSameDay,
    replyWithTyping,
    getGreeting
} from '../utils/helpers.js';

// ✅ CORREÇÃO: Importa o estado centralizado do whatsappService
import { conversationState, INACTIVITY_PAUSE_MS } from '../services/whatsappService.js';

// ❌ REMOVIDO: const conversationState = {};
// ❌ REMOVIDO: const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;

const ABSENCE_COOLDOWN_MS = 10 * 60 * 1000; 

// ... (DEFAULT_MESSAGES permanece o mesmo) ...
const DEFAULT_MESSAGES = {
    repeatedGreeting: 'Olá novamente, {client.name}! Como posso te ajudar?',
    noIntentFound: 'Olá, {client.name}! Para fazer um pedido ou ver nosso cardápio, por favor, acesse: {company.url_products}',
    internalError: 'Opa, ocorreu um erro interno. Nossa equipe já foi notificada.'
};


// ✅ CORREÇÃO: 'getIntentResponse' agora usa 'getTodaysOrderStatusByPhone'
const getIntentResponse = async (foundIntent, storeId, variables, state) => {
    let replyMessage = null;

    if (foundIntent === 'status') {
        // ✅ CORREÇÃO: Chamando a função importada
        const order = await getTodaysOrderStatusByPhone(storeId, state.chatId);
        if (order) {
            replyMessage = await getCustomMessage(storeId, 'order_status_found');
            variables['order.public_id'] = order.public_id;
            variables['order.status'] = order.status;
        } else {
            replyMessage = await getCustomMessage(storeId, 'order_not_found');
        }
    } else if (foundIntent === 'greeting') {
        // ... (lógica de greeting permanece a mesma) ...
        const now = new Date();
        const lastWelcome = state.lastWelcome;
        if (!lastWelcome || !isSameDay(new Date(lastWelcome), now)) {
            replyMessage = await getCustomMessage(storeId, 'welcome_message');
            state.lastWelcome = now.toISOString();
        } else {
            replyMessage = DEFAULT_MESSAGES.repeatedGreeting;
        }
    } else if (foundIntent) {
        const messageKey = state.intents[foundIntent]?.key || `${foundIntent}_message`;
        replyMessage = await getCustomMessage(storeId, messageKey);
    } else {
        replyMessage = DEFAULT_MESSAGES.noIntentFound;
    }

    return replyMessage;
};


// ✅ CORREÇÃO: Assinatura da função agora inclui 'state'
export const processMessage = async (msg, storeId, waSocket, state) => {
    try {
        const from = msg.key.remoteJid;

        // ✅ Filtros de segurança (permanecem)
        if (!from || from === 'status@broadcast' || from.endsWith('@g.us') || from.endsWith('@broadcast') || !from.endsWith('@s.whatsapp.net')) {
            console.log(`[STORE ${storeId}] 🚫 Mensagem de grupo, status ou broadcast ignorada: ${from}`);
            return;
        }

        const chatId = from;
        const clientName = msg.pushName || 'Cliente';

        // ❌ REMOVIDO: Bloco de 'if (!conversationState[chatId])'
        // O 'state' agora é passado por parâmetro
        state.chatId = chatId; // Apenas garante que o chatId está no estado

        // ✅ CORREÇÃO: Lógica de pausa movida para 'whatsappService.js'
        // Esta função só é chamada se o bot NÃO estiver pausado.

        const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!messageText) return;

        // Data fetching (agora funciona pois as funções são exportadas)
        const [storeName, hours, menuSlug, coupons, address] = await Promise.all([
            getStoreName(storeId), getBusinessHours(storeId), getMenuLinkSlug(storeId),
            getActiveCoupons(storeId), getStoreAddress(storeId)
        ]);
        // ... (lógica de 'variables' permanece a mesma) ...
        const domain = process.env.PLATFORM_DOMAIN || 'menuhub.com.br';
        const variables = {
            'greeting': getGreeting(), 'client.name': clientName, 'company.name': storeName,
            'company.address': address, 'company.url_products': menuSlug ? `https://${menuSlug}.${domain}` : '',
            'company.url_promotions': menuSlug ? `https://${menuSlug}.${domain}/promocoes` : '',
            'company.business_hours': hours ? `das ${hours.open_time} às ${hours.close_time}` : 'Consulte nosso site.',
            'promotions.list': coupons.length > 0 ? coupons.map(c => `\n- ${c.code}: ${c.description}`).join('') : 'Nenhuma promoção ativa no momento.'
        };

        // Lógica de 'absence message' (permanece a mesma)
        const storeStatus = await checkStoreStatus(storeId);
        if (storeStatus === 'closed' || storeStatus === 'outside_hours') {
            const now = new Date();
            const lastClosedStoreWarning = state.lastClosedStoreWarning;
            if (!lastClosedStoreWarning || (now - new Date(lastClosedStoreWarning)) > ABSENCE_COOLDOWN_MS) {
                const message = await getCustomMessage(storeId, 'absence_message');
                await replyWithTyping(waSocket, storeId, chatId, replaceVariables(message, variables));
                state.lastClosedStoreWarning = now.toISOString();
            }
            return;
        }

        // ... (lógica de 'intents' permanece a mesma) ...
        const intents = {
            status: { regex: /\b(status|meu\s+pedido|onde\s+está|cadê\s+o\s+pedido|acompanhar)\b/i },
            greeting: { regex: /\b(oi|ola|olá|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i, key: 'welcome_message' },
            order: { regex: /\b(pedido|pedir|cardapio|cardápio|menu)\b/i, key: 'order_message' },
            promotion: { regex: /\b(promoção|promocao|desconto|oferta|cupom)\b/i, key: 'promotions_message' },
            hours: { regex: /\b(horario|horário|abre|fecha|aberto|fechado)\b/i, key: 'business_hours_message' },
            info: { regex: /\b(info|informação|endereço|localização|contato)\b/i, key: 'info_message' },
            thanks_goodbye: { regex: /\b(obrigado|obrigada|obg|valeu|tchau|ok|certo|entendi)\b/i, key: 'farewell_message' }
        };
        state.intents = intents;

        // ... (lógica de 'foundIntent' permanece a mesma) ...
        let foundIntent = null;
        const menuOption = messageText.trim();
        if (menuOption === '1') foundIntent = 'order';
        else if (menuOption === '2') foundIntent = 'hours';
        else if (menuOption === '3') foundIntent = 'info';
        else if (menuOption === '4') {
                foundIntent = 'human_support';
                // ✅ CORREÇÃO: Atualiza o estado centralizado
                state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
            }

        if (!foundIntent) {
            for (const type in intents) {
                if (messageText.toLowerCase().match(intents[type].regex)) {
                    foundIntent = type;
                    break;
                }
            }
        }

        const replyMessage = await getIntentResponse(foundIntent, storeId, variables, state);
        await replyWithTyping(waSocket, storeId, chatId, replaceVariables(replyMessage, variables));

    } catch (error) {
         console.error(`[STORE ${storeId}] CRITICAL ERROR in processMessage:`, error);
         if (msg && msg.key && msg.key.remoteJid) {
             await replyWithTyping(waSocket, storeId, msg.key.remoteJid, DEFAULT_MESSAGES.internalError);
         }
     }
 };

// ❌ REMOVIDO: export { conversationState, INACTIVITY_PAUSE_MS };
