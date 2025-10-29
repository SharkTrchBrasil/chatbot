// services/chatbotService.js - VERSÃO CORRIGIDA E CENTRALIZADA

// ✅ CORREÇÃO: Importar as funções de query do módulo de database centralizado
import { executeQuery, executeQueryMany } from '../config/database.js';

// ❌ REMOVIDO: Importação do 'pg' e criação do 'new Pool()' local.

// --- Funções de Query (Permancem iguais) ---
// ❌ REMOVIDO: Funções locais 'executeQuery' e 'executeQueryMany'.
// Elas agora são importadas do 'database.js'.

// --- Lógica de Negócios (Agora exportadas) ---

const translateOrderStatus = (status) => {
    const statuses = {
        pending: 'Pendente de Confirmação',
        preparing: 'Em Preparação',
        ready: 'Pronto para Retirada/Entrega',
        on_route: 'Saiu para Entrega',
        delivered: 'Entregue',
        finalized: 'Finalizado',
        canceled: 'Cancelado'
    };
    return statuses[status.toLowerCase()] || 'Desconhecido';
};

// ✅ EXPORTADO
export const getTodaysOrderStatusByPhone = async (storeId, phoneJid) => {
    const cleanPhone = phoneJid.split('@')[0];
    const phoneQueryParam = `%${cleanPhone}`;
    // ... (query permanece a mesma) ...
    const query = `
        SELECT public_id, order_status
        FROM orders
        WHERE store_id = $1
        AND customer_phone LIKE $2
        AND created_at >= CURRENT_DATE
        ORDER BY created_at DESC
        LIMIT 1;
    `;

    // ✅ CORREÇÃO: Usando a função importada
    const result = await executeQuery(query, [storeId, phoneQueryParam]);

    if (result) {
        return {
            public_id: result.public_id,
            status: translateOrderStatus(result.order_status)
        };
    }
    return null;
};

// ✅ EXPORTADO
export const getCustomMessage = async (storeId, messageKey) => {
    const query = `
        SELECT sc.custom_content, sc.is_active, st.default_content
        FROM chatbot_message_templates st
        LEFT JOIN store_chatbot_messages sc ON st.message_key = sc.template_key AND sc.store_id = $1
        WHERE st.message_key = $2;
    `;
    // ✅ CORREÇÃO: Usando a função importada
    const result = await executeQuery(query, [storeId, messageKey]);

    if (!result) return null;
    if (result.is_active === false) return result.default_content || null;
    return result.custom_content || result.default_content;
};

// ✅ EXPORTADO
export const checkStoreStatus = async (storeId) => {
    // ✅ CORREÇÃO: Usando a função importada
    const config = await executeQuery('SELECT is_store_open FROM store_operation_config WHERE store_id = $1', [storeId]);
    if (config && config.is_store_open === false) return 'closed';

    const dayOfWeek = new Date().getDay();
    // ✅ CORREÇÃO: Usando a função importada
    const hours = await executeQuery('SELECT open_time, close_time, is_active FROM store_hours WHERE store_id = $1 AND day_of_week = $2', [storeId, dayOfWeek]);
    if (!hours || !hours.is_active) return 'closed';

    const { open_time, close_time } = hours;
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    const [openH, openM] = open_time.split(':').map(Number);
    const openTime = openH * 60 + openM;
    const [closeH, closeM] = close_time.split(':').map(Number);
    let closeTime = closeH * 60 + closeM;

    if (closeTime < openTime) {
        if (currentTime >= openTime || currentTime < closeTime) return 'open';
    } else {
        if (currentTime >= openTime && currentTime < closeTime) return 'open';
    }
    return 'outside_hours';
};

// ✅ EXPORTADO
export const getStoreName = async (storeId) => {
    // ✅ CORREÇÃO: Usando a função importada
    const result = await executeQuery('SELECT name FROM stores WHERE id = $1', [storeId]);
    return result?.name || 'Unknown Store';
};

// ✅ EXPORTADO
export const getBusinessHours = async (storeId) => {
    const dayOfWeek = new Date().getDay();
    // ✅ CORREÇÃO: Usando a função importada
    return await executeQuery('SELECT open_time, close_time FROM store_hours WHERE store_id = $1 AND day_of_week = $2', [storeId, dayOfWeek]);
};

// ✅ EXPORTADO
export const getStoreAddress = async (storeId) => {
    // ✅ CORREÇÃO: Usando a função importada
    const result = await executeQuery('SELECT street, number, neighborhood, city FROM stores WHERE id = $1', [storeId]);
    if (!result) return 'Endereço não configurado.';
    return `${result.street}, ${result.number} - ${result.neighborhood}, ${result.city}`;
};

// ✅ EXPORTADO
export const getMenuLinkSlug = async (storeId) => {
    // ✅ CORREÇÃO: Usando a função importada
    const result = await executeQuery('SELECT url_slug FROM stores WHERE id = $1', [storeId]);
    return result?.url_slug;
};

// ✅ EXPORTADO
export const getActiveCoupons = async (storeId) => {
    const query = `
        SELECT code, description FROM coupons
        WHERE store_id = $1 AND is_active = TRUE AND start_date <= NOW() AND end_date >= NOW()
    `;
    // ✅ CORREÇÃO: Usando a função importada
    return await executeQueryMany(query, [storeId]);
};

// ✅ EXPORTADO
export const getStoresToReconnect = async () => {
    const query = `
        SELECT store_id FROM store_chatbot_configs
        WHERE connection_status = 'connected' AND is_active = TRUE;
    `;
    // ✅ CORREÇÃO: Usando a função importada
    const results = await executeQueryMany(query);
    return results;
};


// --- Funções de Gerenciamento (Movidas da Classe) ---
// Estas funções usavam o pool local, mas agora as funções de query que elas chamam
// são as globais de 'database.js', então elas estão indiretamente corrigidas.
// No entanto, elas parecem ser duplicatas do whatsappService.js (authDB)
// e não são chamadas por nenhum outro serviço.
// Para manter a estabilidade, apenas garantimos que elas usem o pool correto.

// ✅ EXPORTADO (Movido da classe)
export const saveAuthCredentials = async (storeId, credentials) => {
    try {
        // ✅ CORREÇÃO: Usando a função importada (embora 'executeQueryMany' fosse melhor)
        await executeQueryMany(
            'DELETE FROM chatbot_auth_credentials WHERE session_id = $1',
            [`store_${storeId}`]
        );

        for (const [credId, credValue] of Object.entries(credentials)) {
            // ✅ CORREÇÃO: Usando a função importada
            await executeQueryMany(
                `INSERT INTO chatbot_auth_credentials (session_id, cred_id, cred_value)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (session_id, cred_id)
                 DO UPDATE SET cred_value = $3, updated_at = CURRENT_TIMESTAMP`,
                [`store_${storeId}`, credId, JSON.stringify(credValue)]
            );
        }
        console.log(`[DB] ✅ Credenciais salvas para loja ${storeId}`);
    } catch (error) {
        console.error(`[DB] ❌ Erro ao salvar credenciais para loja ${storeId}:`, error);
    }
};

// ✅ EXPORTADO (Movido da classe)
export const loadAuthCredentials = async (storeId) => {
    try {
        // ✅ CORREÇÃO: Usando a função importada
        const result = await executeQueryMany(
            'SELECT cred_id, cred_value FROM chatbot_auth_credentials WHERE session_id = $1',
            [`store_${storeId}`]
        );

        if (result.rows.length === 0) {
            console.log(`[DB] ℹ️ Nenhuma credencial encontrada para loja ${storeId}`);
            return null;
        }

        const credentials = {};
        result.rows.forEach(row => {
            credentials[row.cred_id] = JSON.parse(row.cred_value);
        });

        console.log(`[DB] ✅ Credenciais carregadas para loja ${storeId}`);
        return credentials;
    } catch (error) {
        console.error(`[DB] ❌ Erro ao carregar credenciais para loja ${storeId}:`, error);
        return null;
    }
};

// ✅ EXPORTADO (Movido da classe)
export const updateConnectionStatus = async (storeId, status, qrCode = null, connectionCode = null) => {
    try {
        const updates = {
            connection_status: status,
            last_qr_code: qrCode,
            last_connection_code: connectionCode,
            updated_at: new Date(),
            last_connected_at: null
        };

        if (status === 'connected') {
            updates.last_connected_at = new Date();
        }

        const query = `
            UPDATE store_chatbot_configs
            SET
                connection_status = $1,
                last_qr_code = $2,
                last_connection_code = $3,
                last_connected_at = COALESCE($4, last_connected_at),
                updated_at = $5
            WHERE store_id = $6
        `;

        // ✅ CORREÇÃO: Usando a função importada
        await executeQueryMany(query, [
            updates.connection_status,
            updates.last_qr_code,
            updates.last_connection_code,
            updates.last_connected_at,
            updates.updated_at,
            storeId
        ]);

        console.log(`[DB] ✅ Status atualizado para '${status}' na loja ${storeId}`);
    } catch (error) {
        console.error(`[DB] ❌ Erro ao atualizar status da conexão para loja ${storeId}:`, error);
    }
};

// ✅ EXPORTADO (Movido da classe)
export const updateConversationMetadata = async (storeId, message) => {
    try {
        const chatId = message.key.remoteJid;
        const messagePreview = (message.message?.conversation || '...').substring(0, 100);

        // ✅ CORREÇÃO: Usando a função importada
        await executeQueryMany(
            `INSERT INTO chatbot_conversation_metadata
             (chat_id, store_id, last_message_preview, last_message_timestamp, unread_count)
             VALUES ($1, $2, $3, $4, 1)
             ON CONFLICT (chat_id, store_id)
             DO UPDATE SET
                 last_message_preview = $3,
                 last_message_timestamp = $4,
                 unread_count = chatbot_conversation_metadata.unread_count + 1`,
            [chatId, storeId, messagePreview, new Date()]
        );
    } catch (error) {
        console.error('[DB] ❌ Erro ao atualizar metadata da conversação:', error);
    }
};