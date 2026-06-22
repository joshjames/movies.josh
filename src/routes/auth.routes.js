// src/routes/auth.routes.js
// User management, registration matrices, and profile validation loops.

const express = require('express');
const router = express.Router();

// Mock imports - point these to your actual ProfileManager and mailer utilities
// const ProfileManager = require('../services/ProfileManager');
// const { sendVerificationEmail } = require('../utils/mailer');

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
        const result = await ProfileService.registerUser(username, password, email);
        
        if (result.success) {
            const verificationToken = result.token;

            if (!verificationToken) {
                console.error("❌ [BUG] Token was not generated or returned from ProfileManager.");
            }

            // Dispatch mailer tracking sequence
            sendVerificationEmail(email.trim(), username.trim(), verificationToken);

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
        const userConfig = await ProfileManager.readData(cleanName, 'config', null);
        
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
        
        await ProfileManager.writeData(cleanName, 'config', userConfig);
        
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
        const result = await ProfileManager.authenticateUser(username, password);
        if (result.success) {
            
            const userConfig = await ProfileManager.readData(cleanName, 'config', null);
            if (userConfig && userConfig.isVerified === false) {
                return res.status(403).json({ 
                    success: false, 
                    error: "Account verification pending. Please validate your registration via email link." 
                });
            }

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
        const config = await ProfileManager.readData(activeUser, 'config', {});
        res.json({ loggedIn: true, username: activeUser, config });
    } catch (err) {
        res.status(500).json({ loggedIn: false, error: err.message });
    }
});

// GET: /api/auth/logout
router.get('/logout', (req, res) => {
    res.clearCookie('user_profile', { path: '/' });
    res.redirect('/login.html');
});

module.exports = router;