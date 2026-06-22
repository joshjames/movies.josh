// src/services/MailerService.js
// Transactional outbound SMTP email generation using Brevo Rest API Engine.

const axios = require('axios');
const logger = require('./logger');

async function sendVerificationEmail(email, username, token) {
    const verificationUrl = `https://movies.joshjames.site/api/auth/verify?token=${token}&user=${username}`;
    
    const payload = {
        sender: { 
            name: process.env.SENDER_NAME || "Joshflix Admin", 
            email: process.env.SENDER_EMAIL || "josh@joshjames.site" 
        },
        to: [{ email: email, name: username }],
        subject: "🎬 Activate Your Joshflix Profile",
        htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                body { background-color: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; padding: 30px; margin: 0; }
                .email-container { max-width: 600px; margin: 0 auto; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; text-align: center; }
                .logo-container { width: 220px; margin: 0 auto 24px auto; }
                h2 { color: #f1f5f9; font-size: 1.5rem; margin-top: 0; }
                p { color: #cbd5e1; font-size: 1rem; line-height: 1.6; text-align: left; }
                .btn-verify { display: inline-block; background-color: #e50914; color: #ffffff !important; padding: 14px 28px; font-weight: bold; text-decoration: none; border-radius: 6px; margin: 20px 0; text-transform: uppercase; font-size: 0.9rem; letter-spacing: 1px; }
                .footer { border-top: 1px solid #334155; margin-top: 28px; padding-top: 20px; font-size: 0.85rem; color: #94a3b8; text-align: left; line-height: 1.5; }
                .footer a { color: #38bdf8; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="email-container">
                <div class="logo-container">
                    <svg viewBox="0 0 500 120" xmlns="http://www.w3.org/2000/svg" width="100%">
                        <defs>
                            <path id="textArchPath" d="M 50,95 Q 250,45 450,95" fill="none" />
                            <filter id="cinematicGlow" x="-20%" y="-20%" width="140%" height="140%">
                                <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000000" flood-opacity="0.9" />
                                <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#b91c1c" flood-opacity="0.4" />
                            </filter>
                        </defs>
                        <text font-family="system-ui, -apple-system, sans-serif" font-size="52" font-weight="900" letter-spacing="4" fill="#e50914" filter="url(#cinematicGlow)">
                            <textPath href="#textArchPath" startOffset="50%" text-anchor="middle">JOSHFLIX</textPath>
                        </text>
                    </svg>
                </div>
                <h2>Welcome to Joshflix, ${username}!</h2>
                <p>Please follow this link to activate your account and secure your access:</p>
                <a href="${verificationUrl}" class="btn-verify">Activate Account</a>
                <p>Enjoy a more personalized media experience. Be sure to check out the library or browse the extended media browser once authenticated.</p>
                <div class="footer">
                    Please feel free to reach out if you have any feedback or issues directly to me at 
                    <a href="mailto:josh@joshjames.site">josh@joshjames.site</a>.<br><br>
                    Thanks,<br>
                    <strong>Josh</strong><br>
                    <a href="https://movies.joshjames.site">movies.joshjames.site</a>
                </div>
            </div>
        </body>
        </html>
        `
    };

    try {
        const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
            headers: {
                'accept': 'application/json',
                'api-key': process.env.EMAIL_API_KEY,
                'content-type': 'application/json'
            }
        });
        logger.log(`✉️ [MAILER] Verification successfully sent to ${email}. MessageId: ${response.data.messageId}`);
        return { success: true };
    } catch (error) {
        logger.log(`❌ [MAILER ERROR] Transactional relay dropped execution: ${error.response ? JSON.stringify(error.response.data) : error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

module.exports = { sendVerificationEmail };