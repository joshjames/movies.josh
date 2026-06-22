const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');


// This resolves directly to /app/metadata/users inside the container!
const USER_BASE_DIR = path.join(__dirname, 'metadata', 'users');
const ROSTER_FILE = path.join(USER_BASE_DIR, 'roster.json');


//======HELPERS======

// Utility helper to ensure paths exist before writes
async function ensureUserDir(username) {
    const userDir = path.join(USER_BASE_DIR, username);
    await fs.mkdir(userDir, { recursive: true });
    return userDir;
}

// Helper to read the central user credentials list
async function readRoster() {
    try {
        const data = await fs.readFile(ROSTER_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        return {}; // Return empty registry if it doesn't exist yet
    }
}

// Helper to write back to the central list
async function writeRoster(roster) {
    await fs.mkdir(USER_BASE_DIR, { recursive: true });
    await fs.writeFile(ROSTER_FILE, JSON.stringify(roster, null, 4), 'utf-8');
}

/**
 * CORE DATA ACCESS LAYER (DAL) ABSTRACT INTERFACE
 */
const ProfileManager = {
    
    // --- GENERIC READ OPERATIONS ---
    async readData(username, fileType, defaultData = {}) {
        // 🔮 REDIS CACHE ENGINE PLACEHOLDER
        // if (redis.connected) { 
        //     const cached = await redis.get(`user:${username}:${fileType}`);
        //     if (cached) return JSON.parse(cached);
        // }

        try {
            const userDir = path.join(USER_BASE_DIR, username);
            const filePath = path.join(userDir, `${fileType}.json`);
            
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            // File doesn't exist yet, return fresh defaults
            return defaultData;
        }
    },

    // --- GENERIC WRITE OPERATIONS ---
    async writeData(username, fileType, data) {
        try {
            const userDir = await ensureUserDir(username);
            const filePath = path.join(userDir, `${fileType}.json`);
            
            // Asynchronously serialize and write back to disk safely
            await fs.writeFile(filePath, JSON.stringify(data, null, 4), 'utf-8');

            // 🔮 REDIS CACHE REFLUSH PLACEHOLDER
            // if (redis.connected) {
            //     await redis.set(`user:${username}:${fileType}`, JSON.stringify(data), 'EX', 86400);
            // }

            return true;
        } catch (err) {
            logger.log(`[PROFILE ERROR] Failed writing ${fileType} for ${username}: ${err.message}`, 'error');
            throw err;
        }
    },

    // --- CONVENIENCE abstraction methods ---
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

    async updateLoginHistory(username, ipAddress) {
        const history = await this.readData(username, 'history', { logins: [], lastLogin: null });
        const currentTimestamp = Date.now();
        
        history.lastLogin = currentTimestamp;
        history.logins.unshift({ ip: ipAddress, timestamp: currentTimestamp });
        
        // Keep login tracking array capped to the latest 50 entries
        if (history.logins.length > 50) history.logins.pop();
        
        return await this.writeData(username, 'history', history);
    },



    /**
     * REGISTRATION ENGINE (Updated to include validation parameters)
     */
    async registerUser(username, password, email) { // 👈 Added email parameter here
        const cleanName = username.toLowerCase().trim();
        const roster = await readRoster();

        if (roster[cleanName]) {
            return { success: false, error: "Username already taken." };
        }

        // Add user to master ledger list
        roster[cleanName] = { password: password, createdAt: Date.now() };
        await writeRoster(roster);

        // Generate temporary registration tokens cleanly
        const token = require('crypto').randomBytes(32).toString('hex');
        const expires = Date.now() + (24 * 60 * 60 * 1000); // 24 Hours

        // Provision initial configuration profiles & folder layout structures
        const defaultConfigs = {
            username: username,
            email: email.trim(),                       // 👈 Preserved your structure, added field
            isVerified: false,                         // 👈 Added validation state
            verificationToken: token,                  // 👈 Added temp parameters
            verificationExpires: expires,               // 👈 Added temp parameters
            avatar: "default.png",
            preferences: { autoplay: true, UITheme: "dark" }
        };
        
        await this.writeData(cleanName, 'config', defaultConfigs);
        await this.writeData(cleanName, 'history', { logins: [], lastLogin: null });
        await this.writeData(cleanName, 'playback', {});

        logger.log(`👤 [USER PROVISIONING] Created new profile volume workspace for: ${cleanName}`);
        
        // Return success along with the token so the email handler can send it out
        return { success: true, token: token }; 
    },


 // ... keep your existing readData, writeData, and playback sync methods ...

    /**
     * REGISTRATION ENGINE (Updated to include validation parameters)
     */
    async registerUser(username, password, email) { // 👈 Added email parameter here
        const cleanName = username.toLowerCase().trim();
        const roster = await readRoster();

        if (roster[cleanName]) {
            return { success: false, error: "Username already taken." };
        }

        // Add user to master ledger list
        roster[cleanName] = { password: password, createdAt: Date.now() };
        await writeRoster(roster);

        // 🪙 Generate temporary registration verification tokens cleanly
        const token = require('crypto').randomBytes(32).toString('hex');
        const expires = Date.now() + (24 * 60 * 60 * 1000); // 24-hour expiration matrix

        // Provision initial configuration profiles & folder layout structures
        const defaultConfigs = {
            username: username,
            email: email.trim(),                       // 👈 Saved email parameter
            isVerified: false,                         // 👈 Added verification safety state flag
            verificationToken: token,                  // 👈 Appended token reference
            verificationExpires: expires,              // 👈 Appended expiration date
            avatar: "default.png",
            preferences: { autoplay: true, UITheme: "dark" }
        };
        
        await this.writeData(cleanName, 'config', defaultConfigs);
        await this.writeData(cleanName, 'history', { logins: [], lastLogin: null });
        await this.writeData(cleanName, 'playback', {});

        logger.log(`👤 [USER PROVISIONING] Created new profile volume workspace for: ${cleanName}`);
        
        // 🔑 Return success along with the token so the email handler route can catch it
        return { success: true, token: token }; 
    },

    /**
     * AUTHENTICATION VERIFICATION
     */
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


module.exports = ProfileManager;