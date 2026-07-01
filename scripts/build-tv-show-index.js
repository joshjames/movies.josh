#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.data');
const METADATA_DIR = path.join(ROOT, 'metadata');
const OUTPUT_JSON = path.join(METADATA_DIR, 'tv-show-index.json');
const OUTPUT_CSV = path.join(METADATA_DIR, 'tv-show-index.csv');
const BASICS_FILE = path.join(DATA_DIR, 'title.basics.tsv.gz');
const RATINGS_FILE = path.join(DATA_DIR, 'title.ratings.tsv.gz');
const EPISODE_FILE = path.join(DATA_DIR, 'title.episode.tsv.gz');
const TOP_LIMIT = 2000;

function assertExists(filePath, label) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${label} not found at ${filePath}`);
    }
}

function parseTsvLine(line, header) {
    const cols = line.split('\t');
    const row = {};
    header.forEach((col, index) => {
        row[col] = cols[index] === '\\N' ? '' : (cols[index] || '');
    });
    return row;
}

async function streamTsvGz(filePath, onRow) {
    const input = fs.createReadStream(filePath).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let header = null;

    for await (const line of rl) {
        if (!header) {
            header = line.split('\t');
            continue;
        }

        if (!line) continue;
        const row = parseTsvLine(line, header);
        await onRow(row);
    }
}

function uniqueGenres(genres) {
    return [...new Set(String(genres || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean))].slice(0, 3);
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function csvEscape(value) {
    const raw = String(value ?? '');
    if (/[",\n\r\t]/.test(raw)) {
        return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
}

class MinHeap {
    constructor(compareFn) {
        this.compare = compareFn;
        this.items = [];
    }

    size() {
        return this.items.length;
    }

    peek() {
        return this.items[0] || null;
    }

    push(value) {
        this.items.push(value);
        this.bubbleUp(this.items.length - 1);
    }

    replaceTop(value) {
        this.items[0] = value;
        this.bubbleDown(0);
    }

    bubbleUp(index) {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.compare(this.items[index], this.items[parent]) >= 0) break;
            [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
            index = parent;
        }
    }

    bubbleDown(index) {
        const length = this.items.length;
        while (true) {
            let smallest = index;
            const left = index * 2 + 1;
            const right = left + 1;

            if (left < length && this.compare(this.items[left], this.items[smallest]) < 0) smallest = left;
            if (right < length && this.compare(this.items[right], this.items[smallest]) < 0) smallest = right;
            if (smallest === index) break;

            [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
            index = smallest;
        }
    }

    toArray() {
        return [...this.items];
    }
}

async function main() {
    assertExists(BASICS_FILE, 'IMDb basics file');
    assertExists(RATINGS_FILE, 'IMDb ratings file');

    const ratings = new Map();
    await streamTsvGz(RATINGS_FILE, async row => {
        ratings.set(row.tconst, {
            averageRating: Number(row.averageRating || 0),
            numVotes: Number(row.numVotes || 0)
        });
    });

    const episodeCounts = new Map();
    if (fs.existsSync(EPISODE_FILE)) {
        await streamTsvGz(EPISODE_FILE, async row => {
            if (!row.parentTconst) return;
            episodeCounts.set(row.parentTconst, (episodeCounts.get(row.parentTconst) || 0) + 1);
        });
    }

    const heap = new MinHeap((a, b) => {
        if (a.numVotes !== b.numVotes) return a.numVotes - b.numVotes;
        return a.averageRating - b.averageRating;
    });

    let scanned = 0;
    let included = 0;
    await streamTsvGz(BASICS_FILE, async row => {
        scanned += 1;
        if (row.titleType !== 'tvSeries') return;

        const rating = ratings.get(row.tconst) || { averageRating: 0, numVotes: 0 };
        const item = {
            imdbId: row.tconst,
            title: row.primaryTitle || row.originalTitle || '',
            originalTitle: row.originalTitle || row.primaryTitle || '',
            startYear: row.startYear || '',
            endYear: row.endYear || '',
            genres: uniqueGenres(row.genres).join(', '),
            averageRating: rating.averageRating,
            numVotes: rating.numVotes,
            episodeCount: episodeCounts.get(row.tconst) || 0,
            isAdult: row.isAdult === '1',
            searchText: normalizeText([
                row.tconst,
                row.primaryTitle,
                row.originalTitle,
                row.startYear,
                row.endYear,
                row.genres,
                rating.numVotes,
                rating.averageRating
            ].filter(Boolean).join(' '))
        };

        if (heap.size() < TOP_LIMIT) {
            heap.push(item);
            included += 1;
            return;
        }

        const weakest = heap.peek();
        if (!weakest) return;
        if (item.numVotes > weakest.numVotes || (item.numVotes === weakest.numVotes && item.averageRating > weakest.averageRating)) {
            heap.replaceTop(item);
        }
    });

    const items = heap.toArray().sort((a, b) => {
        if (b.numVotes !== a.numVotes) return b.numVotes - a.numVotes;
        if (b.averageRating !== a.averageRating) return b.averageRating - a.averageRating;
        return a.title.localeCompare(b.title);
    });

    fs.mkdirSync(METADATA_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify({
        updatedAt: new Date().toISOString(),
        source: {
            basics: path.relative(ROOT, BASICS_FILE),
            ratings: path.relative(ROOT, RATINGS_FILE),
            episodes: fs.existsSync(EPISODE_FILE) ? path.relative(ROOT, EPISODE_FILE) : null
        },
        totals: {
            scanned,
            tvSeriesTop: items.length,
            included
        },
        items
    }, null, 2), 'utf-8');

    const csvLines = [
        ['imdbId', 'title', 'originalTitle', 'startYear', 'endYear', 'genres', 'averageRating', 'numVotes', 'episodeCount', 'searchText'].join(',')
    ];
    items.forEach(item => {
        csvLines.push([
            item.imdbId,
            item.title,
            item.originalTitle,
            item.startYear,
            item.endYear,
            item.genres,
            item.averageRating,
            item.numVotes,
            item.episodeCount,
            item.searchText
        ].map(csvEscape).join(','));
    });
    fs.writeFileSync(OUTPUT_CSV, csvLines.join('\n'), 'utf-8');

    console.log(`Built TV show index with ${items.length} items.`);
    console.log(`JSON: ${OUTPUT_JSON}`);
    console.log(`CSV: ${OUTPUT_CSV}`);
}

main().catch(err => {
    console.error(`Failed to build TV show index: ${err.message}`);
    process.exitCode = 1;
});