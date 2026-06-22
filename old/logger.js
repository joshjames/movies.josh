// logger.js
const { EventEmitter } = require('events');
const logStream = new EventEmitter();

const MAX_LOGS = 200;
let logHistory = [];

function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${type.toUpperCase()}] ${message}`;
    
    // 1. Always output to standard stdout for docker logs
    console.log(message);

    // 2. Push to local rolling memory buffer
    logHistory.push(formattedMessage);
    if (logHistory.length > MAX_LOGS) logHistory.shift();

    // 3. Broadcast to any open admin browser tabs live
    logStream.emit('line', formattedMessage);
}

module.exports = {
    log,
    logStream,
    getHistory: () => logHistory
};