// src/services/MetadataService.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger'); // Adjust path to your logger if needed

const MOVIES_DIR = fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies';
const MANIFEST_PATH = path.join(MOVIES_DIR, '.joshflix-manifest.json');
const API_URL = 'http://www.omdbapi.com/?apikey=84196d01&t=';

class MetadataService {
    loadManifest() {
        if (fs.existsSync(MANIFEST_PATH)) {
            try {
                return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
            } catch (e) {
                logger.warn("⚠️ Manifest tracking file corrupted. Initializing fresh index state.");
            }
        }
        return { lastRun: null, folders: {} };
    }

    saveManifest(manifest) {
        manifest.lastRun = new Date().toISOString();
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 4));
    }

    async downloadCover(url, destPath) {
        try {
            const response = await axios({ method: 'GET', url, responseType: 'stream' });
            const writer = fs.createWriteStream(destPath);
            response.data.pipe(writer);
            return new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        } catch (err) {
            console.error(`   ⚠️ Cover download skipped: ${err.message}`);
        }
    }

    async fetchOMDb(title, year = '', type = 'movie') {
        let queryUrl = `${API_URL}${encodeURIComponent(title.trim())}${year ? `&y=${year}` : ''}`;
        if (type === 'series') {
            queryUrl = `${API_URL}${encodeURIComponent(title.trim())}&type=series`;
        }
        const res = await axios.get(queryUrl);
        return res.data;
    }
}

module.exports = new MetadataService();