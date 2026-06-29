// src/services/logger.js
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

// Set default level to debug for local development, info for production
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; 
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '../../logs');

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }), // Automatically capture stack traces
    winston.format.splat(),
    winston.format.json()
);

const textFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
        return `[${timestamp}] [${level.toUpperCase()}]: ${stack || message}`;
    })
);

const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: logFormat,
    transports: [
        // 1. Standard Console Output for Docker logs / Host terminal
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                textFormat
            )
        }),
        // 2. Daily Rotating Combined Log File
        new winston.transports.DailyRotateFile({
            dirname: LOG_DIR,
            filename: 'anymovie-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true, // Compress old logs
            maxSize: '20m',      // Rotate if file hits 20MB
            maxFiles: '14d',     // Retain 14 days of history
            format: textFormat   // Plain text makes streaming/reading simple
        })
    ]
});

// Export log directory configuration so the streaming engine knows where to look
logger.LOG_DIR = LOG_DIR;

module.exports = logger;