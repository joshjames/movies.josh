#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.data');
const ENV_FILES = [path.join(ROOT, '.env'), path.join(ROOT, '.env.local')];
ENV_FILES.forEach((file) => {
  if (fs.existsSync(file)) dotenv.config({ path: file });
});

const SOURCE_BASE = String(process.env.IMDB_DATA_SOURCE_URL || 'https://datasets.imdbws.com').replace(/\/+$/, '');
const FILES = [
  'title.basics.tsv.gz',
  'title.ratings.tsv.gz',
  'title.episode.tsv.gz',
  'title.akas.tsv.gz',
  'name.basics.tsv.gz'
];

const REQUEST_OPTIONS = {
  timeout: 30000,
  maxRedirects: 5
};

function assertDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveFileUrl(fileName) {
  const override = process.env[`IMDB_DATA_FILE_URL_${fileName.toUpperCase().replace(/\W+/g, '_')}`];
  if (override && override.trim()) {
    return override.trim();
  }
  return `${SOURCE_BASE}/${fileName}`;
}

function resolveDestination(fileName) {
  return path.join(DATA_DIR, fileName);
}

async function fetchHead(url) {
  try {
    const response = await axios.head(url, REQUEST_OPTIONS);
    return response.headers || {};
  } catch (_err) {
    return {};
  }
}

async function downloadFile(fileName, force = false) {
  const url = resolveFileUrl(fileName);
  const destination = resolveDestination(fileName);
  const tmpDestination = `${destination}.tmp`;

  assertDir(DATA_DIR);

  if (fs.existsSync(destination) && !force) {
    const localStat = fs.statSync(destination);
    const headers = await fetchHead(url);
    const remoteModified = headers['last-modified'] ? Date.parse(headers['last-modified']) : null;

    if (remoteModified && Number.isFinite(remoteModified) && localStat.mtimeMs >= remoteModified) {
      console.log(`✔ Skipping ${fileName} (local copy is up to date)`);
      return { skipped: true, destination };
    }
  }

  console.log(`⬇ Downloading ${fileName} from ${url}`);
  const response = await axios.get(url, { ...REQUEST_OPTIONS, responseType: 'stream' });
  if (response.status !== 200) {
    throw new Error(`Failed to download ${fileName}: HTTP ${response.status}`);
  }

  const writer = fs.createWriteStream(tmpDestination);
  const stream = response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  fs.renameSync(tmpDestination, destination);
  console.log(`✔ Saved ${fileName} (${fs.statSync(destination).size.toLocaleString()} bytes)`);
  return { skipped: false, destination };
}

async function main() {
  const forceDownload = process.argv.includes('--force') || process.argv.includes('-f');
  const selectedFiles = process.argv.length > 2
    ? process.argv.slice(2).filter(arg => !arg.startsWith('-'))
    : FILES;

  if (!selectedFiles.length) {
    throw new Error('No IMDb data files were selected to download. Pass file names or omit arguments to download the default set.');
  }

  const results = [];
  for (const fileName of selectedFiles) {
    if (!FILES.includes(fileName)) {
      console.warn(`⚠️ Skipping unknown IMDb file: ${fileName}`);
      continue;
    }
    results.push(await downloadFile(fileName, forceDownload));
  }

  console.log('\nIMDb data download complete.');
  results.forEach((result) => {
    if (result) {
      console.log(`- ${result.skipped ? 'cached' : 'downloaded'}: ${result.destination}`);
    }
  });
}

main().catch((err) => {
  console.error(`Failed to update IMDb data: ${err.message}`);
  process.exit(1);
});
