// controllers/chatbotController.js - VERSÃO CORRIGIDA

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

// ✅ CORREÇÃO: Importar do cacheService, não do whatsappService
import { conversationStateManager } from '../services/cacheService.js';

// ✅ CORREÇÃO: Importar apenas a constante necessária
export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;
const ABSENCE_COOLDOWN_MS = 10 * 60 * 1000;

const DEFAULT_MESSAGES = {
    repeatedGreeting: 'Olá novamente, {client.name}! Como posso te ajudar?',
    noIntentFound: 'Olá, {client.name}! Para fazer um pedido ou ver nosso cardápio, por favor, acesse: {company.url_products}',
    internalError: 'Opa, ocorreu um erro interno. Nossa equipe já foi notificada.'
};

// ✅ Função auxiliar para obter resposta baseada na intenção
const getIntentResponse = async (foundIntent, storeId, variables, state) => {
    let replyMessage = null;

    if (foundIntent === 'status') {
        const order = await getTodaysOrderStatusByPhone(storeId, state.chatId);
        if (order) {
            replyMessage = await getCustomMessage(storeId, 'order_status_found');
            variables['order.public_id'] = order.public_id;
            variables['order.status'] = order.status;
        } else {
            replyMessage = await getCustomMessage(storeId, 'order_not_found');
        }
    } else if (foundIntent === 'greeting') {
        const now = new Date();
        const lastWelcome = state.lastWelcome;
        if (!lastWelcome || !isSameDay(new Date(lastWelcome), now)) {
            replyMessage = await getCustomMessage(storeId, 'welcome_message');
            state.lastWelcome = now.toISOString();
        } else {
            replyMessage = DEFAULT_MESSAGES.repeatedGreeting;
        }
    } else if (foundIntent === 'human_support') {
        replyMessage = await getCustomMessage(storeId, 'human_support_message') ||
                      'Em instantes um atendente irá te responder. Aguarde!';
    } else if (foundIntent) {
        const messageKey = state.intents[foundIntent]?.key || `${foundIntent}_message`;
        replyMessage = await getCustomMessage(storeId, messageKey);
    } else {
        replyMessage = DEFAULT_MESSAGES.noIntentFound;
    }

    return replyMessage || DEFAULT_MESSAGES.noIntentFound;
};

/**
 * ✅ FUNÇÃO PRINCIPAL: Processar mensagem recebida
 * @param {Object} msg - Mensagem do Baileys
 * @param {number} storeId - ID da loja
 * @param {Object} waSocket - Socket do WhatsApp
 * @param {Object} state - Estado da conversação (passado por referência)
 */
export const processMessage = async (msg, storeId, waSocket, state) => {
    try {
        const from = msg.key.remoteJid;

        // ✅ Filtros de segurança
        if (!from ||
            from === 'status@broadcast' ||
            from.endsWith('@g.us') ||
            from.endsWith('@broadcast') ||
            !from.endsWith('@s.whatsapp.net')) {
            console.log(`[STORE ${storeId}] 🚫 Mensagem de grupo, status ou broadcast ignorada`);
            return;
        }

        const chatId = from;
        const clientName = msg.pushName || 'Cliente';

        // ✅ CORREÇÃO: Garantir que state tem as propriedades necessárias
        if (!state.chatId) {
            state.chatId = chatId;
        }

        // ✅ Extrair texto da mensagem
        const messageText = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text || '';

        if (!messageText) {
            console.log(`[STORE ${storeId}] Empty message from ${chatId}, skipping.`);
            return;
        }

        // ✅ Buscar dados da loja em paralelo
        const [storeName, hours, menuSlug, coupons, address] = await Promise.all([
            getStoreName(storeId),
            getBusinessHours(storeId),
            getMenuLinkSlug(storeId),
            getActiveCoupons(storeId),
            getStoreAddress(storeId)
        ]);

        // ✅ Montar variáveis para substituição
        const domain = process.env.PLATFORM_DOMAIN || 'menuhub.com.br';
        const variables = {
            'greeting': getGreeting(),
            'client.name': clientName,
            'company.name': storeName,
            'company.address': address,
            'company.url_products': menuSlug ? `https://${menuSlug}.${domain}` : '',
            'company.url_promotions': menuSlug ? `https://${menuSlug}.${domain}/promocoes` : '',
            'company.business_hours': hours ? `das ${hours.open_time} às ${hours.close_time}` : 'Consulte nosso site.',
            'promotions.list': coupons.length > 0
                ? coupons.map(c => `\n- ${c.code}: ${c.description}`).join('')
                : 'Nenhuma promoção ativa no momento.'
        };

        // ✅ Verificar status da loja (aberta/fechada)
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

        // ✅ Definir intenções (intents)
        const intents = {
            status: {
                regex: /\b(status|meu\s+pedido|onde\s+está|cadê\s+o\s+pedido|acompanhar)\b/i
            },
            greeting: {
                regex: /\b(oi|ola|olá|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i,
                key: 'welcome_message'
            },
            order: {
                regex: /\b(pedido|pedir|cardapio|cardápio|menu)\b/i,
                key: 'order_message'
            },
            promotion: {
                regex: /\b(promoção|promocao|desconto|oferta|cupom)\b/i,
                key: 'promotions_message'
            },
            hours: {
                regex: /\b(horario|horário|abre|fecha|aberto|fechado)\b/i,
                key: 'business_hours_message'
            },
            info: {
                regex: /\b(info|informação|endereço|localização|contato)\b/i,
                key: 'info_message'
            },
            thanks_goodbye: {
                regex: /\b(obrigado|obrigada|obg|valeu|tchau|ok|certo|entendi)\b/i,
                key: 'farewell_message'
            }
        };

        state.intents = intents;

        // ✅ Detectar intenção (numérica ou por regex)
        let foundIntent = null;
        const menuOption = messageText.trim();

        if (menuOption === '1') {
            foundIntent = 'order';
        } else if (menuOption === '2') {
            foundIntent = 'hours';
        } else if (menuOption === '3') {
            foundIntent = 'info';
        } else if (menuOption === '4') {
            foundIntent = 'human_support';
            // ✅ CORREÇÃO: Pausar bot por 30 minutos
            state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
            conversationStateManager.set(chatId, state);
        }

        // ✅ Se não foi opção numérica, tentar regex
        if (!foundIntent) {
            for (const type in intents) {
                if (messageText.toLowerCase().match(intents[type].regex)) {
                    foundIntent = type;
                    break;
                }
            }
        }

        // ✅ Obter resposta apropriada
        const replyMessage = await getIntentResponse(foundIntent, storeId, variables, state);

        // ✅ Enviar resposta
        await replyWithTyping(waSocket, storeId, chatId, replaceVariables(replyMessage, variables));

        // ✅ Atualizar estado no cache
        conversationStateManager.set(chatId, state);

    } catch (error) {
        console.error(`[STORE ${storeId}] ❌ CRITICAL ERROR in processMessage:`, error.message);
        console.error(error.stack);

        if (msg && msg.key && msg.key.remoteJid) {
            try {
                await replyWithTyping(waSocket, storeId, msg.key.remoteJid, DEFAULT_MESSAGES.internalError);
            } catch (replyError) {
                console.error(`[STORE ${storeId}] ❌ Failed to send error message:`, replyError.message);
            }
        }
    }
};