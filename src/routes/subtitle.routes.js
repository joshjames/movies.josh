// src/routes/subtitles.routes.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Fallback to environment variables or global properties safely
const MOVIES_DIR = process.env.MOVIES_DIR || '/app/storage/movies';
const SERIES_DIR = process.env.SERIES_DIR || '/app/storage/series';

// =========================================================================
// DYNAMIC SRT-TO-WEBVTT SUBTITLE STREAM ENGINE
// =========================================================================
router.get('/subtitles/:id', (req, res) => {
    try {
        const mediaId = decodeURIComponent(req.params.id);
        
        // 🎯 FIX: Check the movies folder first, fallback to the series folder if missing
        let folderPath = path.join(MOVIES_DIR, mediaId);
        if (!fs.existsSync(folderPath)) {
            folderPath = path.join(SERIES_DIR, mediaId);
        }

        if (!fs.existsSync(folderPath)) {
            return res.status(404).send('Media directory folder not found.');
        }

        const files = fs.readdirSync(folderPath);
        const srtFile = files.find(f => f.endsWith('.srt'));

        if (!srtFile) {
            return res.status(404).send('No subtitles found.');
        }

        const srtPath = path.join(folderPath, srtFile);
        let srtContent = fs.readFileSync(srtPath, 'utf-8');

        // On-the-fly conversion from SRT format to browser-compliant WebVTT
        let vttContent = "WEBVTT\n\n" + srtContent
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

        res.setHeader('Content-Type', 'text/vtt');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).send(vttContent);

    } catch (err) {
        console.error("💣 Subtitle engine failure:", err);
        res.status(500).send('Error processing subtitle asset.');
    }
});

module.exports = router;