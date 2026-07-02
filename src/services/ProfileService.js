// src/services/ProfileService.js
// Central Data Access Layer (DAL) for user profile provisioning and state management.
// Inside src/services/ProfileService.js
// Go up 3 levels: services -> src -> root -> metadata/users

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

function resolveUserBaseDir() {
    const configured = String(process.env.USER_BASE_DIR || '').trim();
    if (configured) return configured;

    const candidates = [
        '/app/metadata/users',
        path.join(__dirname, '../../metadata/users'),
        path.join(__dirname, '../../../metadata/users')
    ];

    return candidates[0];
}

const USER_BASE_DIR = resolveUserBaseDir();
const ROSTER_FILE = path.join(USER_BASE_DIR, 'roster.json');

function normalizeIdentity(value) {
    return String(value || '').toLowerCase().trim();
}

function defaultDisplayNameFromEmail(emailOrUser) {
    const raw = String(emailOrUser || '').trim();
    const localPart = raw.includes('@') ? raw.split('@')[0] : raw;
    const cleaned = localPart.replace(/[._-]+/g, ' ').trim();
    return cleaned || raw;
}

// ====== PRIVATE DATA UTILITIES ======
async function ensureUserDir(username) {
    const userDir = path.join(USER_BASE_DIR, username);
    await fs.mkdir(userDir, { recursive: true });
    return userDir;
}

async function readRoster() {
    try {
        const data = await fs.readFile(ROSTER_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        return {}; 
    }
}

async function writeRoster(roster) {
    await fs.mkdir(USER_BASE_DIR, { recursive: true });
    await fs.writeFile(ROSTER_FILE, JSON.stringify(roster, null, 4), 'utf-8');
}

// ====== CORE SERVICE CORE ======
const ProfileService = {
    normalizeIdentity,

    async listUsers() {
        const roster = await readRoster();
        return Object.keys(roster);
    },

    async resolveUserKey(identifier) {
        const cleanIdentifier = normalizeIdentity(identifier);
        if (!cleanIdentifier) return null;

        const roster = await readRoster();
        if (roster[cleanIdentifier]) {
            return cleanIdentifier;
        }

        const byEmail = Object.keys(roster).find(key => normalizeIdentity(roster[key]?.email) === cleanIdentifier);
        if (byEmail) {
            return byEmail;
        }

        return null;
    },
    
    // --- GENERIC READ OPERATIONS ---
    async readData(username, fileType, defaultData = {}) {
        try {
            const userDir = path.join(USER_BASE_DIR, username);
            const filePath = path.join(userDir, `${fileType}.json`);
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            return defaultData;
        }
    },

    // --- GENERIC WRITE OPERATIONS ---
    async writeData(username, fileType, data) {
        try {
            const userDir = await ensureUserDir(username);
            const filePath = path.join(userDir, `${fileType}.json`);
            await fs.writeFile(filePath, JSON.stringify(data, null, 4), 'utf-8');
            return true;
        } catch (err) {
            logger.error(`[PROFILE ERROR] Failed writing ${fileType} for ${username}: ${err.message}`);
            throw err;
        }
    },

    // --- PLAYBACK PROGRESS COORDINATE TRACKS ---
    async getPlaybackState(username) {
        return await this.readData(username, 'playback', {});
    },

    async savePlaybackPosition(username, mediaId, position) {
        const playback = await this.getPlaybackState(username);
        playback[mediaId] = {
            position: parseFloat(position),
            updatedAt: Date.now()
        };
        return await this.writeData(username, 'playback', playback);
    },

    // --- TELEMETRY SECURITY HISTORY TRACKS ---
    async updateLoginHistory(username, ipAddress) {
        const history = await this.readData(username, 'history', { logins: [], lastLogin: null });
        const currentTimestamp = Date.now();
        
        history.lastLogin = currentTimestamp;
        history.logins.unshift({ ip: ipAddress, timestamp: currentTimestamp });
        
        if (history.logins.length > 50) history.logins.pop();
        
        return await this.writeData(username, 'history', history);
    },

    // --- SECURE PROVISIONING & LEADER MATRIX ---
    async registerUser(username, password, email, displayName = '') {
        const cleanName = normalizeIdentity(username);
        const cleanEmail = normalizeIdentity(email);
        const cleanDisplayName = String(displayName || '').trim() || defaultDisplayNameFromEmail(cleanEmail || cleanName);
        const roster = await readRoster();

        if (roster[cleanName]) {
            return { success: false, error: "Account already exists for this email." };
        }

        const duplicateEmail = Object.keys(roster).find(key => normalizeIdentity(roster[key]?.email) === cleanEmail);
        if (duplicateEmail) {
            return { success: false, error: "Account already exists for this email." };
        }

        roster[cleanName] = {
            password: password,
            email: cleanEmail,
            displayName: cleanDisplayName,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await writeRoster(roster);

        const token = require('crypto').randomBytes(32).toString('hex');
        const expires = Date.now() + (24 * 60 * 60 * 1000); 

        const defaultConfigs = {
            username: cleanDisplayName,
            displayName: cleanDisplayName,
            name: cleanDisplayName,
            email: cleanEmail,
            loginKey: cleanName,
            isVerified: false,
            verificationToken: token,
            verificationExpires: expires,
            avatar: "default.png",
            preferences: { autoplay: true, UITheme: "dark" }
        };
        
        await this.writeData(cleanName, 'config', defaultConfigs);
        await this.writeData(cleanName, 'history', { logins: [], lastLogin: null });
        await this.writeData(cleanName, 'playback', {});

        logger.info(`👤 [USER PROVISIONING] Created new profile volume workspace for: ${cleanName}`);
        return { success: true, token: token }; 
    },

    async authenticateUser(username, password) {
        const cleanName = await this.resolveUserKey(username);
        if (!cleanName) {
            return { success: false, error: "Invalid email or password credentials." };
        }

        const roster = await readRoster();

        const account = roster[cleanName];
        if (!account || account.password !== password) {
            return { success: false, error: "Invalid email or password credentials." };
        }

        return { success: true, userKey: cleanName };
    },

    async updateAccountProfile(userKey, payload = {}) {
        const cleanKey = normalizeIdentity(userKey);
        const roster = await readRoster();
        if (!roster[cleanKey]) {
            throw new Error('Account roster entry not found.');
        }

        const currentConfig = await this.readData(cleanKey, 'config', {});
        const nextDisplayName = String(payload.displayName || payload.name || '').trim() || currentConfig.displayName || currentConfig.username || defaultDisplayNameFromEmail(cleanKey);
        const nextEmail = normalizeIdentity(payload.email || currentConfig.email || cleanKey);

        let finalUserKey = cleanKey;
        if (nextEmail && nextEmail !== cleanKey) {
            const collision = Object.keys(roster).find(key => key !== cleanKey && normalizeIdentity(roster[key]?.email) === nextEmail);
            if (collision) {
                throw new Error('Another account already uses this email.');
            }

            const collisionByKey = roster[nextEmail];
            if (collisionByKey) {
                throw new Error('Another account already uses this email.');
            }

            finalUserKey = await this.renameUserKey(cleanKey, nextEmail);
        }

        const refreshedRoster = await readRoster();
        refreshedRoster[finalUserKey] = {
            ...(refreshedRoster[finalUserKey] || {}),
            email: nextEmail,
            displayName: nextDisplayName,
            updatedAt: Date.now()
        };
        await writeRoster(refreshedRoster);

        const nextConfig = {
            ...currentConfig,
            username: nextDisplayName,
            displayName: nextDisplayName,
            name: nextDisplayName,
            email: nextEmail,
            loginKey: finalUserKey,
            updatedAt: Date.now()
        };

        await this.writeData(finalUserKey, 'config', nextConfig);
        return { userKey: finalUserKey, config: nextConfig };
    },

    async renameUserKey(oldKey, newKey) {
        const fromKey = normalizeIdentity(oldKey);
        const toKey = normalizeIdentity(newKey);

        if (!fromKey || !toKey) throw new Error('Invalid account identity key.');
        if (fromKey === toKey) return fromKey;

        const roster = await readRoster();
        if (!roster[fromKey]) {
            throw new Error('Current account identity not found.');
        }
        if (roster[toKey]) {
            throw new Error('Target account identity already exists.');
        }

        const fromDir = path.join(USER_BASE_DIR, fromKey);
        const toDir = path.join(USER_BASE_DIR, toKey);

        try {
            await fs.access(fromDir);
            await fs.rename(fromDir, toDir);
        } catch (_err) {
            await fs.mkdir(toDir, { recursive: true });
        }

        roster[toKey] = {
            ...roster[fromKey],
            email: toKey,
            updatedAt: Date.now()
        };
        delete roster[fromKey];
        await writeRoster(roster);

        return toKey;
    }
};

module.exports = ProfileService;