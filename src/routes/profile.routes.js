// src/routes/profile.routes.js
// User profile settings, watch history tracking, and playback position state persistence.

const express = require('express');
const router = express.Router();

const { getActiveUser } = require('../middleware/auth');
// Import your data manager instance
// const ProfileManager = require('../services/ProfileManager');

// =========================================================================
// PLAYBACK RESUME & SYNC PORTS
// =========================================================================

// POST: /api/profile/playback/sync (Heartbeat endpoint for active video players)
router.post('/playback/sync', async (req, res) => {
    try {
        const username = getActiveUser(req);
        const { mediaId, position } = req.body;

        if (!mediaId || position === undefined) {
            return res.status(400).json({ success: false, error: 'Missing sync states' });
        }

        const numericPosition = parseFloat(position);

        // 🛡️ ANTI-RESET SHIELD
        // Prevents unmount/page tear-down race conditions from zeroing out saved progress.
        if (numericPosition === 0) {
            const currentPlayback = await ProfileManager.getPlaybackState(username);
            if (currentPlayback && currentPlayback[mediaId] && currentPlayback[mediaId].position > 10) {
                // Ignore the rogue 0 save and preserve the asset coordinate maps
                return res.json({ success: true, message: 'Ignored teardown zero reset.' });
            }
        }

        await ProfileManager.savePlaybackPosition(username, mediaId, numericPosition);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/profile/playback/state (Fetch current progress coordinates for resume windows)
router.get('/playback/state', async (req, res) => {
    try {
        const username = getActiveUser(req);
        const { mediaId } = req.query;

        if (!mediaId) {
            return res.status(400).json({ success: false, error: 'Missing media identity key.' });
        }

        const playback = await ProfileManager.getPlaybackState(username);
        const state = playback?.[mediaId] || { position: 0 };

        res.json({ success: true, position: state.position });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// SKELETONS FOR COMPLEMENTARY PROFILE DATA TRACKS
router.get('/history', (req, res) => res.status(501).json({ error: 'Not implemented' }));
router.post('/history/clear', (req, res) => res.status(501).json({ error: 'Not implemented' }));

module.exports = router;