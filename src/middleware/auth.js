// src/middleware/auth.js
// Enforces user profile session validation bounds across secure routes.

function requireAuth(req, res, next) {
    const activeUser = req.cookies?.user_profile;

    if (!activeUser) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ success: false, error: "Authentication required." });
        }
        return res.redirect('/login.html');
    }
    next();
}

/**
 * Middleware helper to extract active user identity context
 */
function getActiveUser(req) {
    return req.cookies?.user_profile || 'guest';
}

module.exports = { requireAuth, getActiveUser };