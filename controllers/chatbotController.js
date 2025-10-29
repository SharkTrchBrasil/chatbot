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

// ✅ CORREÇÃO: Importar o cacheManager global
import { cacheManager } from '../services/cacheService.js';

export const INACTIVITY_PAUSE_MS = 30 * 60 * 1000;
const ABSENCE_COOLDOWN_MS = 10 * 60 * 1000;

const DEFAULT_MESSAGES = {
    repeatedGreeting: 'Olá novamente, {client.name}! Como posso te ajudar?',
    noIntentFound: 'Olá, {client.name}! Para fazer um pedido ou ver nosso cardápio, por favor, acesse: {company.url_products}',
    internalError: 'Opa, ocorreu um erro interno. Nossa equipe já foi notificada.'
};

// ✅ Função auxiliar para obter resposta baseada na intenção (sem alteração)
const getIntentResponse = async (foundIntent, storeId, variables, state) => {
    // ... (lógica do getIntentResponse) ...
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

        // ✅ Filtros de segurança (sem alteração)
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

        if (!state.chatId) {
            state.chatId = chatId;
        }

        const messageText = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text || '';

        if (!messageText) {
            console.log(`[STORE ${storeId}] Empty message from ${chatId}, skipping.`);
            return;
        }

        // ... (lógica de buscar dados da loja e montar variáveis) ...
        const [storeName, hours, menuSlug, coupons, address] = await Promise.all([
            getStoreName(storeId),
            getBusinessHours(storeId),
            getMenuLinkSlug(storeId),
            getActiveCoupons(storeId),
            getStoreAddress(storeId)
        ]);

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

        // ... (lógica de verificar status da loja) ...
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

        // ... (lógica de definir intenções) ...
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
            },
            // ✅ INTENÇÃO DE SUPORTE HUMANO (PAUSA O BOT)
            human_support: {
                 regex: /\b(atendente|humano|suporte|falar\s+com\s+alguém|ajuda)\b/i,
                 key: 'human_support_message'
            }
        };

        state.intents = intents;

        // ... (lógica de detectar intenção) ...
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
        }

        if (!foundIntent) {
            for (const type in intents) {
                if (messageText.toLowerCase().match(intents[type].regex)) {
                    foundIntent = type;
                    break;
                }
            }
        }

        // ✅ CORREÇÃO: Pausar o bot se a intenção for suporte humano
        if (foundIntent === 'human_support') {
            state.humanSupportUntil = new Date(Date.now() + INACTIVITY_PAUSE_MS);
            // O cacheManager.set será chamado no final
        }

        // ... (lógica de obter e enviar resposta) ...
        const replyMessage = await getIntentResponse(foundIntent, storeId, variables, state);
        await replyWithTyping(waSocket, storeId, chatId, replaceVariables(replyMessage, variables));

        // ✅ CORREÇÃO: Atualizar estado no cache (agora feito no whatsappService.js)
        // O estado (state) é passado por referência, então as alterações
        // (como state.lastWelcome) serão salvas pelo whatsappService.js

    } catch (error) {
        console.error(`[STORE ${storeId}] ❌ CRITICAL ERROR in processMessage:`, error.message);
        console.error(error.stack);
        // ... (lógica de enviar msg de erro) ...
        if (msg && msg.key && msg.key.remoteJid) {
            try {
                await replyWithTyping(waSocket, storeId, msg.key.remoteJid, DEFAULT_MESSAGES.internalError);
            } catch (replyError) {
                console.error(`[STORE ${storeId}] ❌ Failed to send error message:`, replyError.message);
            }
        }
    }
};