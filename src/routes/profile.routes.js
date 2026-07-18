// src/routes/profile.routes.js
const express = require('express');
const router = express.Router();
const ProfileService = require('../services/ProfileService'); 
const NotificationService = require('../services/NotificationService');

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

// GET: /api/profile/watch-history
router.get('/watch-history', async (req, res) => {
    try {
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        const limit = parseInt(req.query.limit, 10) || 200;

        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        const history = await ProfileService.getWatchHistory(username, { limit });
        return res.json({
            success: true,
            userKey: username,
            count: history.length,
            history
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/profile/watch-later
router.get('/watch-later', async (req, res) => {
    try {
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        const limit = parseInt(req.query.limit, 10) || 500;

        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        const items = await ProfileService.getWatchLater(username, { limit });
        return res.json({ success: true, userKey: username, count: items.length, items });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/profile/watch-later
router.post('/watch-later', async (req, res) => {
    try {
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        const item = req.body || {};
        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        const result = await ProfileService.addWatchLaterItem(username, item);
        if (!result.success) {
            return res.status(400).json(result);
        }
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE: /api/profile/watch-later/:mediaId
router.delete('/watch-later/:mediaId', async (req, res) => {
    try {
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        const mediaId = decodeURIComponent(String(req.params.mediaId || ''));
        const result = await ProfileService.removeWatchLaterItem(username, mediaId);
        if (!result.success) {
            return res.status(400).json(result);
        }
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/profile/notifications
router.get('/notifications', async (req, res) => {
    try {
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        const limit = parseInt(req.query.limit, 10) || 30;
        const limitPerCategory = parseInt(req.query.limitPerCategory, 10) || 3;
        const payload = await NotificationService.list(username, { limit, limitPerCategory });
        return res.json({ success: true, ...payload });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/profile/notifications
// Normal users can only push `user` category to themselves.
router.post('/notifications', async (req, res) => {
    try {
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        const config = await ProfileService.readData(username, 'config', {});
        const isPrivileged = username === 'josh' || username.startsWith('josh@') || config?.isAdmin === true;
        const requestedCategory = NotificationService.normalizeCategory(req.body?.category || 'user');

        if (!isPrivileged && requestedCategory !== 'user') {
            return res.status(403).json({ success: false, error: 'Only user-category notifications are allowed for this account.' });
        }

        const targetUser = isPrivileged && req.body?.targetUser
            ? String(req.body.targetUser || '').toLowerCase().trim()
            : username;

        const title = String(req.body?.title || '').trim();
        const message = String(req.body?.message || '').trim();
        if (!title) {
            return res.status(400).json({ success: false, error: 'title is required.' });
        }

        const pushed = await NotificationService.push(targetUser, {
            category: requestedCategory,
            title,
            message,
            href: req.body?.href || '',
            ttlMs: req.body?.ttlMs,
            payload: req.body?.payload
        });

        return res.json({ success: true, ...pushed });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/profile/notifications/prune
router.post('/notifications/prune', async (req, res) => {
    try {
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        const result = await NotificationService.prune(username);
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE: /api/profile/notifications/category/:category
router.delete('/notifications/category/:category', async (req, res) => {
    try {
        const username = (req.cookies?.user_profile || '').toLowerCase().trim();
        if (!username) {
            return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
        }

        const category = String(req.params.category || '').trim();
        const result = await NotificationService.clearCategory(username, category);
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;