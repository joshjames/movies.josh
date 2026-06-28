// src/routes/profile.routes.js
const express = require('express');
const router = express.Router();
const ProfileService = require('../services/ProfileService'); 

// Helper function to force uniform media keys matching your storage tree structure
function sanitizeMediaId(id) {
    if (!id) return '';
    return id
        .replace(/\[.*?\]/g, '')                  // Strip release group metadata tags like [YTS]
        .replace(/\(.*?\)/g, '')                  // Strip year tags or parenthesis
        .replace(/[-_\s]+/g, '.')                 // Normalize spaces/dashes to dot-notation
        .replace(/\.+$/, '')                      // Trim trailing periods
        .trim();
}

// POST: /api/profile/playback/sync
router.post('/playback/sync', async (req, res) => {
    // 🎯 FIX: Safely fallback to the cookie identity if the payload body lacks a username
    const username = (req.body.username || req.cookies?.user_profile || '').toLowerCase().trim();
    const { mediaId, position } = req.body; 

    if (!username) {
        return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
    }

    if (!mediaId || position === undefined) {
        return res.status(400).json({ success: false, error: 'Missing sync states' });
    }

    const numericPosition = parseFloat(position);
    const cleanMediaId = sanitizeMediaId(mediaId);

    try {
        // 🛡️ ANTI-RESET SHIELD
        if (numericPosition === 0) {
            const currentPlayback = await ProfileService.getPlaybackState(username);
            if (currentPlayback[cleanMediaId] && currentPlayback[cleanMediaId].position > 10) {
                return res.json({ success: true, message: 'Ignored teardown zero reset.' });
            }
        }

        await ProfileService.savePlaybackPosition(username, cleanMediaId, numericPosition);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/profile/playback/state
router.get('/playback/state', async (req, res) => {
    try {
        // 🎯 FIX: Extract directly from cookies to match your server.js auth state
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        const { mediaId } = req.query;

        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        if (!mediaId) {
            return res.status(400).json({ success: false, error: 'Missing media identity key.' });
        }

        const cleanMediaId = sanitizeMediaId(mediaId);
        const playbackState = await ProfileService.getPlaybackState(username);
        
        // Check both normalized and original raw key variants for legacy fallback
        const state = playbackState[cleanMediaId] || playbackState[mediaId] || { position: 0 };

        res.json({ success: true, position: state.position });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;