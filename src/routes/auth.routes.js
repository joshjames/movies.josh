// src/routes/auth.routes.js
// User management, registration matrices, and profile validation loops.

const express = require('express');
const router = express.Router();

// 📂 REAL SERVICE IMPORTS (Fixed depth from src/routes to src/services)
const ProfileService = require('../services/ProfileService');
const MailerService = require('../services/MailerService');

// POST: /api/auth/register
router.post('/register', async (req, res) => {
    const { username, password, email } = req.body;
    if (!username || !password || !email) {
        return res.status(400).json({ success: false, error: "Fields cannot be blank." });
    }

    try {
        // Wired to ProfileService instead of ProfileManager
        const result = await ProfileService.registerUser(username, password, email);
        
        if (result.success) {
            const verificationToken = result.token;

            if (!verificationToken) {
                console.error("❌ [BUG] Token was not generated or returned from ProfileService.");
            }

            // Dispatch your real mailer tracking sequence if it exposes sendVerificationEmail
            if (typeof MailerService.sendVerificationEmail === 'function') {
                MailerService.sendVerificationEmail(email.trim(), username.trim(), verificationToken);
            } else {
                console.log(`ℹ️ MailerService loaded. Verification Token for ${username}: ${verificationToken}`);
            }

            return res.json({ 
                success: true, 
                message: "Registration successful! Check your inbox to verify your profile." 
            });
        }
        res.status(400).json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/auth/verify
router.get('/verify', async (req, res) => {
    const { token, user } = req.query;
    if (!token || !user) {
        return res.status(400).send('<h3>Missing verification parameters.</h3>');
    }
    
    const cleanName = user.toLowerCase().trim();
    
    try {
        const userConfig = await ProfileService.readData(cleanName, 'config', null);
        
        if (!userConfig || userConfig.verificationToken !== token) {
            return res.send('<h3>Invalid verification token layout.</h3>');
        }
        if (Date.now() > userConfig.verificationExpires) {
            return res.send('<h3>Verification token has expired. Please register again.</h3>');
        }

        // Flip authorization status flags
        userConfig.isVerified = true;
        delete userConfig.verificationToken;
        delete userConfig.verificationExpires;
        
        await ProfileService.writeData(cleanName, 'config', userConfig);
        
        res.redirect('/login.html?verified=true');
    } catch (err) {
        res.status(500).send('Verification error occurred.');
    }
});

// POST: /api/auth/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: "Credentials cannot be blank." });
    }

    const cleanName = username.toLowerCase().trim();

    try {
        const result = await ProfileService.authenticateUser(username, password);
        if (result.success) {
            
            const userConfig = await ProfileService.readData(cleanName, 'config', null);
            if (userConfig && userConfig.isVerified === false) {
                return res.status(403).json({ 
                    success: false, 
                    error: "Account verification pending. Please validate your registration via email link." 
                });
            }

            // Capture remote user IP safely for telemetry logs
            const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            await ProfileService.updateLoginHistory(cleanName, ipAddress);

            // Assign structural root-path access cookie
            res.cookie('user_profile', cleanName, { maxAge: 31536000000, path: '/' });
            return res.json({ success: true });
        }
        res.status(400).json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/auth/me
router.get('/me', async (req, res) => {
    const activeUser = req.cookies.user_profile;
    if (!activeUser) return res.status(401).json({ loggedIn: false });

    try {
        const config = await ProfileService.readData(activeUser, 'config', {});
        res.json({ loggedIn: true, username: activeUser, config });
    } catch (err) {
        res.status(500).json({ loggedIn: false, error: err.message });
    }
});

// POST: /api/auth/account
router.post('/account', async (req, res) => {
    const activeUser = req.cookies?.user_profile;
    if (!activeUser) {
        return res.status(401).json({ success: false, error: 'Unauthorized.' });
    }

    try {
        const { displayName, email } = req.body || {};
        const config = await ProfileService.readData(activeUser, 'config', {});

        const nextDisplay = String(displayName || '').trim() || activeUser;
        const nextEmail = String(email || '').trim();
        if (!nextEmail || !nextEmail.includes('@')) {
            return res.status(400).json({ success: false, error: 'A valid email is required.' });
        }

        const updated = {
            ...config,
            username: nextDisplay,
            email: nextEmail,
            updatedAt: Date.now()
        };

        await ProfileService.writeData(activeUser, 'config', updated);
        return res.json({ success: true, config: updated });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/auth/change-password
router.post('/change-password', async (req, res) => {
    const activeUser = req.cookies?.user_profile;
    if (!activeUser) {
        return res.status(401).json({ success: false, error: 'Unauthorized.' });
    }

    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Current and new passwords are required.' });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
        }

        const authResult = await ProfileService.authenticateUser(activeUser, currentPassword);
        if (!authResult.success) {
            return res.status(403).json({ success: false, error: 'Current password is incorrect.' });
        }

        const fs = require('fs').promises;
        const rosterPath = '/app/metadata/users/roster.json';
        const rosterRaw = await fs.readFile(rosterPath, 'utf-8');
        const rosterJson = JSON.parse(rosterRaw);
        if (!rosterJson[activeUser]) {
            return res.status(404).json({ success: false, error: 'User account not found in roster.' });
        }

        rosterJson[activeUser].password = String(newPassword);
        rosterJson[activeUser].updatedAt = Date.now();
        await fs.writeFile(rosterPath, JSON.stringify(rosterJson, null, 4), 'utf-8');

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/auth/logout
router.get('/logout', (req, res) => {
    res.clearCookie('user_profile', { path: '/' });
    res.redirect('/login.html');
});

module.exports = router;