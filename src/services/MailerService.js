// src/services/MailerService.js
// Transactional outbound SMTP email generation using Brevo Rest API Engine.

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const TEMPLATE_DIR = path.join(__dirname, '../templates');
const templateCache = new Map();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function loadTemplate(templateName) {
    const safeName = String(templateName || '').trim();
    if (!safeName) throw new Error('Template name is required.');
    if (safeName.includes('..') || safeName.includes('/') || safeName.includes('\\')) {
        throw new Error('Invalid template name.');
    }

    if (templateCache.has(safeName)) {
        return templateCache.get(safeName);
    }

    const filePath = path.join(TEMPLATE_DIR, safeName);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Template not found: ${safeName}`);
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    templateCache.set(safeName, raw);
    return raw;
}

function renderTemplate(templateName, variables = {}) {
    const raw = loadTemplate(templateName);
    return raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
        if (Object.prototype.hasOwnProperty.call(variables, key)) {
            return escapeHtml(variables[key]);
        }
        return '';
    });
}

async function sendEmail({ toEmail, toName, subject, htmlContent }) {
    if (!toEmail || !subject || !htmlContent) {
        throw new Error('Missing required email payload fields.');
    }

    const payload = {
        sender: { 
            name: process.env.SENDER_NAME || "AnyMovie Admin", 
            email: process.env.SENDER_EMAIL || "admin@anymovie.online" 
        },
        to: [{ email: toEmail, name: toName || '' }],
        subject,
        htmlContent
    };

    try {
        const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
            headers: {
                'accept': 'application/json',
                'api-key': process.env.EMAIL_API_KEY,
                'content-type': 'application/json'
            }
        });
        logger.info(`✉️ [MAILER] Email sent to ${toEmail}. MessageId: ${response.data.messageId}`);
        return { success: true };
    } catch (error) {
        logger.error(`❌ [MAILER ERROR] Transactional relay dropped execution: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        return { success: false, error: error.message };
    }
}

async function sendTemplateEmail({ toEmail, toName, subject, templateName, variables = {} }) {
    const htmlContent = renderTemplate(templateName, variables);
    return sendEmail({ toEmail, toName, subject, htmlContent });
}

async function sendVerificationEmail(email, username, token, options = {}) {
    const verificationUrl = `https://anymovie.online/api/auth/verify?token=${encodeURIComponent(token)}&user=${encodeURIComponent(username)}`;
    const subject = options.subject || process.env.VERIFICATION_EMAIL_SUBJECT || 'Activate Your AnyMovie Profile';

    return sendTemplateEmail({
        toEmail: email,
        toName: username,
        subject,
        templateName: options.templateName || 'verification-email.html',
        variables: {
            username,
            verificationUrl,
            supportEmail: process.env.SUPPORT_EMAIL || 'josh@joshjames.site',
            appUrl: process.env.APP_URL || 'https://anymovie.online',
            senderName: process.env.SENDER_NAME || 'AnyMovie Admin'
        }
    });
}

module.exports = { sendVerificationEmail, sendTemplateEmail };