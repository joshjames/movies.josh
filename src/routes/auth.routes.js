// src/routes/auth.routes.js
// User management, registration matrices, and profile validation loops.

const express = require('express');
const router = express.Router();

// 📂 REAL SERVICE IMPORTS (Fixed depth from src/routes to src/services)
const ProfileService = require('../services/ProfileService');
const MailerService = require('../services/MailerService');

// POST: /api/auth/register
router.post('/register', async (req, res) => {
    const { email, password, name, username } = req.body || {};
    const cleanEmail = String(email || '').toLowerCase().trim();
    const displayName = String(name || username || '').trim();

    if (!cleanEmail || !password) {
        return res.status(400).json({ success: false, error: "Fields cannot be blank." });
    }
    if (!cleanEmail.includes('@')) {
        return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
    }

    try {
        const result = await ProfileService.registerUser(cleanEmail, password, cleanEmail, displayName);
        
        if (result.success) {
            const verificationToken = result.token;

            if (!verificationToken) {
                console.error("❌ [BUG] Token was not generated or returned from ProfileService.");
            }

            // Dispatch your real mailer tracking sequence if it exposes sendVerificationEmail
            if (typeof MailerService.sendVerificationEmail === 'function') {
                MailerService.sendVerificationEmail(cleanEmail, cleanEmail, verificationToken, {
                    displayName: displayName || cleanEmail
                });
            } else {
                console.log(`ℹ️ MailerService loaded. Verification Token for ${cleanEmail}: ${verificationToken}`);
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
    
    const cleanName = await ProfileService.resolveUserKey(String(user || '').toLowerCase().trim());
    if (!cleanName) {
        return res.send('<h3>Invalid verification identity.</h3>');
    }
    
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
    const { username, email, password } = req.body || {};
    const identifier = String(email || username || '').trim();
    if (!identifier || !password) {
        return res.status(400).json({ success: false, error: "Credentials cannot be blank." });
    }

    try {
        const result = await ProfileService.authenticateUser(identifier, password);
        if (result.success) {
            const cleanName = result.userKey || await ProfileService.resolveUserKey(identifier);
            if (!cleanName) {
                return res.status(400).json({ success: false, error: 'Unable to resolve account.' });
            }
            
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
            return res.json({
                success: true,
                profile: {
                    userKey: cleanName,
                    email: userConfig?.email || cleanName,
                    displayName: userConfig?.displayName || userConfig?.name || userConfig?.username || cleanName
                }
            });
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
        res.json({
            loggedIn: true,
            username: activeUser,
            userKey: activeUser,
            email: config.email || activeUser,
            displayName: config.displayName || config.name || config.username || activeUser,
            config
        });
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
        const { displayName, name, email } = req.body || {};
        const nextEmail = String(email || '').toLowerCase().trim();
        if (!nextEmail || !nextEmail.includes('@')) {
            return res.status(400).json({ success: false, error: 'A valid email is required.' });
        }

        const updated = await ProfileService.updateAccountProfile(activeUser, {
            displayName: displayName || name,
            name: name || displayName,
            email: nextEmail
        });

        if (updated.userKey && updated.userKey !== activeUser) {
            res.cookie('user_profile', updated.userKey, { maxAge: 31536000000, path: '/' });
        }

        return res.json({ success: true, userKey: updated.userKey, config: updated.config });
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

        const updateResult = await ProfileService.setPassword(activeUser, newPassword);
        if (!updateResult.success) {
            return res.status(404).json({ success: false, error: updateResult.error || 'User account not found.' });
        }

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/auth/password-reset/request
router.post('/password-reset/request', async (req, res) => {
    try {
        const { email, username } = req.body || {};
        const identifier = String(email || username || '').trim().toLowerCase();
        if (!identifier || !identifier.includes('@')) {
            return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
        }

        const issueResult = await ProfileService.issuePasswordResetToken(identifier);
        if (issueResult.success && typeof MailerService.sendPasswordResetEmail === 'function') {
            await MailerService.sendPasswordResetEmail(
                issueResult.email,
                issueResult.userKey,
                issueResult.token,
                { displayName: issueResult.displayName }
            );
        }

        return res.json({
            success: true,
            message: 'If that email is registered, a password reset link has been sent.'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/auth/password-reset/confirm
router.post('/password-reset/confirm', async (req, res) => {
    try {
        const { user, token, newPassword } = req.body || {};
        const cleanUser = String(user || '').trim().toLowerCase();
        const cleanToken = String(token || '').trim();

        if (!cleanUser || !cleanToken || !newPassword) {
            return res.status(400).json({ success: false, error: 'Missing reset token, user, or new password.' });
        }

        if (String(newPassword).length < 6) {
            return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
        }

        const resetResult = await ProfileService.resetPasswordWithToken(cleanUser, cleanToken, newPassword);
        if (!resetResult.success) {
            return res.status(400).json({ success: false, error: resetResult.error || 'Unable to reset password.' });
        }

        return res.json({ success: true, message: 'Password reset successful. You can now log in.' });
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