// services/whatsappAuthManager.js

import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import pool from '../config/database.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Configurações de diretório
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR = path.join(__dirname, '..', 'auth_sessions');

// ============================================================
// 📁 FUNÇÕES DE GERENCIAMENTO DE AUTENTICAÇÃO E PERSISTÊNCIA
// ============================================================

/**
 * Garante que o diretório de autenticação existe
 */
const ensureAuthDir = async () => {
    try {
        await fs.mkdir(AUTH_DIR, { recursive: true });
        console.log('[AUTH] Authentication directory ensured.');
    } catch (err) {
        console.error('[AUTH] Failed to create dir:', err.message);
    }
};

/**
 * Salva credenciais no banco de dados
 */
const saveCredsToDatabase = async (sessionId, creds) => {
    const client = await pool.connect();
    try {
        // Limpar credenciais antigas
        await client.query(
            'DELETE FROM chatbot_auth_credentials WHERE session_id = $1',
            [`store_${sessionId}`]
        );

        // Salvar nova credencial
        await client.query(
            `INSERT INTO chatbot_auth_credentials (session_id, cred_id, cred_value, updated_at)
             VALUES ($1, $2, $3, NOW())`,
            [`store_${sessionId}`, 'creds', creds]
        );

        console.log(`[DB] ✅ Credentials saved for store ${sessionId}`);
    } catch (err) {
        console.error(`[DB] Failed to save creds for store ${sessionId}:`, err.message);
    } finally {
        client.release();
    }
};

/**
 * Carrega credenciais do banco de dados
 */
const loadCredsFromDatabase = async (sessionId) => {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            'SELECT cred_value FROM chatbot_auth_credentials WHERE session_id = $1 AND cred_id = $2',
            [`store_${sessionId}`, 'creds']
        );

        if (rows.length > 0) {
            console.log(`[DB] ✅ Credentials loaded for store ${sessionId}`);
            return rows[0].cred_value;
        }

        return null;
    } catch (err) {
        console.error(`[DB] Failed to load creds for store ${sessionId}:`, err.message);
        return null;
    } finally {
        client.release();
    }
};

/**
 * Limpa credenciais do banco de dados
 */
const clearCredsFromDatabase = async (sessionId) => {
    const client = await pool.connect();
    try {
        await client.query(
            'DELETE FROM chatbot_auth_credentials WHERE session_id = $1',
            [`store_${sessionId}`]
        );
        console.log(`[DB] 🗑️ Credentials cleared for store ${sessionId}`);
    } catch (err) {
        console.error(`[DB] Failed to clear creds for store ${sessionId}:`, err.message);
    } finally {
        client.release();
    }
};

/**
 * Obtém ou cria o estado de autenticação, restaurando do DB se necessário, e
 * retorna uma função de save híbrida (filesystem + DB).
 */
export const getAuthState = async (sessionId) => {
    const authPath = path.join(AUTH_DIR, `session_${sessionId}`);

    try {
        await fs.mkdir(authPath, { recursive: true });

        // Tentar restaurar do banco para o filesystem (se não existir localmente)
        try {
            await fs.access(path.join(authPath, 'creds.json'));
        } catch {
            // Arquivo não existe, tentar restaurar do banco
            const dbCreds = await loadCredsFromDatabase(sessionId);
            if (dbCreds) {
                await fs.writeFile(
                    path.join(authPath, 'creds.json'),
                    JSON.stringify(dbCreds, null, 2)
                );
                console.log(`[AUTH] ✅ Restored creds from DB for store ${sessionId}`);
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        // Wrapper para salvar no DB também
        const saveCredsHybrid = async () => {
            await saveCreds(); // Salva no filesystem
            await saveCredsToDatabase(sessionId, state.creds); // Salva no DB
        };

        return { state, saveCreds: saveCredsHybrid };
    } catch (err) {
        console.error(`[AUTH] Error for store ${sessionId}:`, err.message);
        throw err;
    }
};

/**
 * Limpa o estado de autenticação (filesystem + database)
 */
export const clearAuthState = async (sessionId) => {
    const authPath = path.join(AUTH_DIR, `session_${sessionId}`);

    try {
        await fs.rm(authPath, { recursive: true, force: true });
        await clearCredsFromDatabase(sessionId);
        console.log(`[AUTH] 🗑️ Cleared auth for store ${sessionId}`);
    } catch (err) {
        console.error(`[AUTH] Clear error for store ${sessionId}:`, err.message);
    }
};

export const credsSaveTimers = new Map();

export default {
    ensureAuthDir,
    getAuthState,
    clearAuthState,
    credsSaveTimers
};