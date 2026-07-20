#!/usr/bin/env node

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const OUTPUT_DIR = path.join(PUBLIC_DIR, 'images', 'welcome-covers');
const CATALOG_COVER_DIR = path.join(PUBLIC_DIR, 'images', 'catalog-covers');
const TV_COVER_DIR = path.join(ROOT, 'metadata', 'tv-covers');
const OUTPUT_FILE = path.join(DATA_DIR, 'welcome-assets.js');

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function shuffle(values) {
  const items = values.slice();
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }
  return items;
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function listImageFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return (await fsp.readdir(dirPath))
    .filter((fileName) => /\.(jpg|jpeg|png|webp)$/i.test(fileName))
    .map((fileName) => ({ fileName, filePath: path.join(dirPath, fileName) }));
}

async function copyLocalAssets(sourceFiles, prefix, limit) {
  const picked = shuffle(sourceFiles).slice(0, limit);
  const assets = [];

  for (let index = 0; index < picked.length; index += 1) {
    const source = picked[index];
    const ext = path.extname(source.fileName) || '.jpg';
    const targetName = `${prefix}-${String(index + 1).padStart(2, '0')}${ext.toLowerCase()}`;
    const targetPath = path.join(OUTPUT_DIR, targetName);
    await fsp.copyFile(source.filePath, targetPath);

    assets.push({
      source: prefix,
      title: path.basename(source.fileName, ext).replace(/[-_.]+/g, ' ').trim(),
      url: `/images/welcome-covers/${targetName}`
    });
  }

  return assets;
}

function buildTmdbRequestConfig() {
  const apiKey = String(process.env.THEMOVIEDB_API_KEY || '').trim();
  const token = String(process.env.THEMOVIEDB_API_READ_ACCESS_TOKEN || '').trim();
  const headers = {};
  const params = {
    language: 'en-US'
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (apiKey) {
    params.api_key = apiKey;
  }

  return { headers, params };
}

async function fetchTmdbTrending(limit) {
  const apiBase = String(process.env.TMDB_API_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
  const { headers, params } = buildTmdbRequestConfig();
  if (!headers.Authorization && !params.api_key) return [];

  const response = await axios.get(`${apiBase}/trending/all/week`, {
    headers,
    params,
    timeout: 10000
  });

  const results = Array.isArray(response.data?.results) ? response.data.results : [];
  return results
    .filter((item) => item && (item.backdrop_path || item.poster_path))
    .slice(0, limit)
    .map((item, index) => ({
      source: 'tmdb',
      title: String(item.title || item.name || `Trending ${index + 1}`).trim(),
      url: `https://image.tmdb.org/t/p/w780${item.backdrop_path || item.poster_path}`,
      tmdbId: item.id,
      mediaType: item.media_type || 'all'
    }));
}

async function downloadRemoteAssets(items) {
  const assets = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const targetName = `tmdb-${String(item.tmdbId || index + 1).replace(/[^a-zA-Z0-9_-]/g, '')}.jpg`;
    const targetPath = path.join(OUTPUT_DIR, targetName);

    try {
      const response = await axios.get(item.url, {
        responseType: 'arraybuffer',
        timeout: 12000
      });
      await fsp.writeFile(targetPath, Buffer.from(response.data));

      assets.push({
        source: 'tmdb',
        title: item.title,
        url: `/images/welcome-covers/${targetName}`,
        tmdbId: item.tmdbId,
        mediaType: item.mediaType
      });
    } catch (_err) {
      // Skip individual failures so the static bundle still completes.
    }
  }

  return assets;
}

async function main() {
  await ensureDir(DATA_DIR);
  await ensureDir(OUTPUT_DIR);

  const localCatalogFiles = await listImageFiles(CATALOG_COVER_DIR);
  const localTvFiles = await listImageFiles(TV_COVER_DIR);
  const localAssets = [];

  localAssets.push(...await copyLocalAssets(localCatalogFiles, 'catalog', 8));
  localAssets.push(...await copyLocalAssets(localTvFiles, 'tv', 8));

  let tmdbAssets = [];
  try {
    tmdbAssets = await downloadRemoteAssets(await fetchTmdbTrending(12));
  } catch (err) {
    console.warn(`[welcome-assets] TMDb snapshot failed: ${err.message}`);
  }

  const combined = shuffle([...localAssets, ...tmdbAssets]).slice(0, 20);
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceCounts: {
      local: localAssets.length,
      tmdb: tmdbAssets.length
    },
    items: combined
  };

  const output = `window.__WELCOME_ASSETS__ = ${JSON.stringify(payload, null, 2)};\n`;
  await fsp.writeFile(OUTPUT_FILE, output, 'utf8');

  console.log(`[welcome-assets] Wrote ${combined.length} items to ${path.relative(ROOT, OUTPUT_FILE)}`);
}

main().catch((err) => {
  console.error(`[welcome-assets] ERROR: ${err.message}`);
  process.exit(1);
});