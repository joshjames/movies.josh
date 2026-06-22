// src/services/ProfileService.js
// Central Data Access Layer (DAL) for user profile provisioning and state management.
// Inside src/services/ProfileService.js
// Go up 3 levels: services -> src -> root -> metadata/users

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const USER_BASE_DIR = path.join(__dirname, '../../../metadata/users');
const ROSTER_FILE = path.join(USER_BASE_DIR, 'roster.json');

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
            logger.log(`[PROFILE ERROR] Failed writing ${fileType} for ${username}: ${err.message}`, 'error');
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
    async registerUser(username, password, email) {
        const cleanName = username.toLowerCase().trim();
        const roster = await readRoster();

        if (roster[cleanName]) {
            return { success: false, error: "Username already taken." };
        }

        roster[cleanName] = { password: password, createdAt: Date.now() };
        await writeRoster(roster);

        const token = require('crypto').randomBytes(32).toString('hex');
        const expires = Date.now() + (24 * 60 * 60 * 1000); 

        const defaultConfigs = {
            username: username,
            email: email.trim(),
            isVerified: false,
            verificationToken: token,
            verificationExpires: expires,
            avatar: "default.png",
            preferences: { autoplay: true, UITheme: "dark" }
        };
        
        await this.writeData(cleanName, 'config', defaultConfigs);
        await this.writeData(cleanName, 'history', { logins: [], lastLogin: null });
        await this.writeData(cleanName, 'playback', {});

        logger.log(`👤 [USER PROVISIONING] Created new profile volume workspace for: ${cleanName}`);
        return { success: true, token: token }; 
    },

    async authenticateUser(username, password) {
        const cleanName = username.toLowerCase().trim();
        const roster = await readRoster();

        const account = roster[cleanName];
        if (!account || account.password !== password) {
            return { success: false, error: "Invalid username or password credentials." };
        }

        return { success: true };
    }
};

module.exports = ProfileService;