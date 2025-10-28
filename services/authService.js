// services/authService.js - VERSÃO CORRIGIDA FINAL

import pg from 'pg';
const { Pool } = pg;
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

export const useDatabaseAuthState = async (sessionId) => {
    const readData = async (key) => {
        try {
            const query = 'SELECT cred_value FROM chatbot_auth_credentials WHERE session_id = $1 AND cred_id = $2';
            const { rows } = await pool.query(query, [sessionId, key]);

            if (rows.length > 0) {
                try {
                    // ✅ CORREÇÃO: Converte para string primeiro se for objeto
                    const rawValue = rows[0].cred_value;
                    const valueStr = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);

                    // ✅ Usar BufferJSON.reviver para desserializar
                    const parsed = JSON.parse(valueStr, BufferJSON.reviver);
                    console.log(`[AUTH] ✅ Successfully loaded ${key} for session ${sessionId}`);
                    return parsed;
                } catch (parseError) {
                    console.error(`[AUTH] ❌ Failed to parse JSON for key ${key}: ${parseError.message}`);
                    const rawValue = rows[0].cred_value;
                    const preview = typeof rawValue === 'string' ? rawValue.substring(0, 100) : JSON.stringify(rawValue).substring(0, 100);
                    console.error(`[AUTH] Raw value preview:`, preview);
                    return null;
                }
            }
            return null;
        } catch (e) {
            console.error(`[AUTH] ❌ Failed to read key ${key} for session ${sessionId}`, e);
            return null;
        }
    };

    const writeData = async (key, value) => {
        try {
            // ✅ CORREÇÃO CRÍTICA: Usar BufferJSON.replacer para serializar corretamente
            const valueStr = JSON.stringify(value, BufferJSON.replacer);

            const query = `
                INSERT INTO chatbot_auth_credentials (session_id, cred_id, cred_value)
                VALUES ($1, $2, $3)
                ON CONFLICT (session_id, cred_id)
                DO UPDATE SET cred_value = EXCLUDED.cred_value;
            `;
            await pool.query(query, [sessionId, key, valueStr]);
            console.log(`[AUTH] ✅ Successfully wrote ${key} for session ${sessionId}`);
        } catch (e) {
            console.error(`[AUTH] ❌ Failed to write key ${key} for session ${sessionId}`, e);
            throw e;
        }
    };

    const removeData = async (key) => {
        try {
            const query = 'DELETE FROM chatbot_auth_credentials WHERE session_id = $1 AND cred_id = $2';
            await pool.query(query, [sessionId, key]);
            console.log(`[AUTH] ✅ Successfully removed ${key} for session ${sessionId}`);
        } catch (e) {
            console.error(`[AUTH] ❌ Failed to remove key ${key} for session ${sessionId}`, e);
        }
    };

    // ✅ Inicializa credenciais vazias se não existirem
    let creds = await readData('creds');
    if (!creds || Object.keys(creds).length === 0) {
        console.log(`[AUTH] 🔄 No existing credentials found for session ${sessionId}. Initializing new credentials...`);
        creds = initAuthCreds();
        await writeData('creds', creds);
    }

    console.log(`[AUTH] Loaded creds for session ${sessionId}:`, Object.keys(creds).length > 0 ? 'valid' : 'empty');

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            const value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                data[id] = proto.Message.AppStateSyncKeyData.fromObject(value);
                            } else {
                                data[id] = value;
                            }
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(key, value) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            return await writeData('creds', creds);
        }
    };
};

export const removeSessionFromDB = async (sessionId) => {
    try {
        console.log(`[AUTH] 🗑️ Removing all credentials for session ${sessionId} from database.`);
        const query = 'DELETE FROM chatbot_auth_credentials WHERE session_id = $1';
        await pool.query(query, [sessionId]);
        console.log(`[AUTH] ✅ Successfully removed session ${sessionId} from database.`);
    } catch (e) {
        console.error(`[AUTH] ❌ Failed to remove session ${sessionId} from database.`, e);
    }
};