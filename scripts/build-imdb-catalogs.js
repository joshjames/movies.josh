#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.data');
const METADATA_DIR = path.join(ROOT, 'metadata');

const BASICS_FILE = path.join(DATA_DIR, 'title.basics.tsv.gz');
const RATINGS_FILE = path.join(DATA_DIR, 'title.ratings.tsv.gz');
const EPISODE_FILE = path.join(DATA_DIR, 'title.episode.tsv.gz');
const AKAS_FILE = path.join(DATA_DIR, 'title.akas.tsv.gz');

const TV_INDEX_LIMIT = Math.max(5000, Math.min(parseInt(process.env.TV_SHOW_INDEX_LIMIT || '12000', 10), 25000));
const MOVIE_INDEX_LIMIT = Math.max(5000, Math.min(parseInt(process.env.MOVIE_INDEX_LIMIT || '20000', 10), 30000));
const CURRENT_YEAR = new Date().getFullYear();
const RECENT_TV_YEAR_CUTOFF = CURRENT_YEAR - 3;
const RECENT_MOVIE_YEAR_CUTOFF = CURRENT_YEAR - 3;

function assertExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label || filePath} not found`);
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

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueGenres(genres) {
  return [...new Set(String(genres || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function sortByPopularity(rows) {
  return rows.slice().sort((a, b) => {
    if (b.votes !== a.votes) return b.votes - a.votes;
    if (b.rating !== a.rating) return b.rating - a.rating;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function writeJson(fileName, payload) {
  fs.mkdirSync(METADATA_DIR, { recursive: true });
  const destination = path.join(METADATA_DIR, fileName);
  fs.writeFileSync(destination, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`✔ wrote ${destination}`);
  return destination;
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/["\n\r\t]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function buildTvSearchText(item) {
  const aliasText = Array.isArray(item.aliases) ? item.aliases.join(' ') : '';
  return normalizeText([
    item.imdbId,
    item.title,
    item.originalTitle,
    item.genres,
    item.startYear,
    item.endYear,
    aliasText
  ].filter(Boolean).join(' '));
}

function buildMovieSearchText(item) {
  return normalizeText([
    item.imdbId,
    item.title,
    item.year,
    item.genres.join(' ')
  ].filter(Boolean).join(' '));
}

class MinHeap {
  constructor(compareFn) {
    this.compare = compareFn;
    this.items = [];
  }

  swap(i, j) {
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
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

  pop() {
    if (this.items.length === 0) return null;
    if (this.items.length === 1) return this.items.pop();
    const top = this.items[0];
    this.items[0] = this.items.pop();
    this.bubbleDown(0);
    return top;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.items[index], this.items[parent]) >= 0) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  bubbleDown(index) {
    const length = this.items.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && this.compare(this.items[left], this.items[smallest]) < 0) smallest = left;
      if (right < length && this.compare(this.items[right], this.items[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
  }

  toArray() {
    return [...this.items];
  }
}

async function loadRatings() {
  assertExists(RATINGS_FILE, 'IMDb ratings file');
  const ratings = new Map();
  await streamTsvGz(RATINGS_FILE, async (row) => {
    ratings.set(row.tconst, {
      averageRating: Number(row.averageRating || 0),
      numVotes: Number(row.numVotes || 0)
    });
  });
  return ratings;
}

async function loadEpisodeCounts() {
  if (!fs.existsSync(EPISODE_FILE)) return new Map();
  const counts = new Map();
  await streamTsvGz(EPISODE_FILE, async (row) => {
    if (!row.parentTconst) return;
    counts.set(row.parentTconst, (counts.get(row.parentTconst) || 0) + 1);
  });
  return counts;
}

async function loadAkasForIds(ids) {
  if (!fs.existsSync(AKAS_FILE)) return new Map();
  const aliasMap = new Map();
  await streamTsvGz(AKAS_FILE, async (row) => {
    const titleId = row.titleId;
    if (!ids.has(titleId)) return;
    const alias = String(row.title || '').trim();
    if (!alias) return;
    const existing = aliasMap.get(titleId) || new Set();
    existing.add(alias);
    aliasMap.set(titleId, existing);
  });

  const result = new Map();
  for (const [id, aliases] of aliasMap.entries()) {
    result.set(id, Array.from(aliases).slice(0, 10));
  }
  return result;
}

async function buildTvIndex() {
  assertExists(BASICS_FILE, 'IMDb basics file');
  assertExists(RATINGS_FILE, 'IMDb ratings file');

  const ratings = await loadRatings();
  const episodeCounts = await loadEpisodeCounts();

  const recentMap = new Map();
  const candidateHeap = new MinHeap((a, b) => {
    if (a.numVotes !== b.numVotes) return a.numVotes - b.numVotes;
    return a.averageRating - b.averageRating;
  });

  let scanned = 0;
  let includedRecent = 0;

  await streamTsvGz(BASICS_FILE, async (row) => {
    scanned += 1;
    if (row.titleType !== 'tvSeries') return;
    if (row.isAdult === '1') return;

    const startYear = row.startYear === '' ? null : Number(row.startYear);
    const endYear = row.endYear === '' ? null : Number(row.endYear);

    const rating = ratings.get(row.tconst) || { averageRating: 0, numVotes: 0 };
    const episodeCount = episodeCounts.get(row.tconst) || 0;
    const item = {
      imdbId: row.tconst,
      title: row.primaryTitle || row.originalTitle || '',
      originalTitle: row.originalTitle || row.primaryTitle || '',
      startYear: row.startYear || '',
      endYear: row.endYear || '',
      genres: uniqueGenres(row.genres),
      averageRating: rating.averageRating,
      numVotes: rating.numVotes,
      episodeCount,
      isAdult: row.isAdult === '1',
      aliases: [],
      source: 'imdb-tv-index'
    };

    if (!item.title) return;
    if (startYear && startYear >= RECENT_TV_YEAR_CUTOFF && rating.numVotes >= 5) {
      recentMap.set(item.imdbId, item);
      includedRecent += 1;
    }

    if (rating.numVotes >= 1000) {
      if (candidateHeap.size() < TV_INDEX_LIMIT) {
        candidateHeap.push(item);
      } else if (candidateHeap.peek() && (item.numVotes > candidateHeap.peek().numVotes || (item.numVotes === candidateHeap.peek().numVotes && item.averageRating > candidateHeap.peek().averageRating))) {
        candidateHeap.pop();
        candidateHeap.push(item);
      }
    }
  });

  const topCandidates = sortByPopularity(candidateHeap.toArray());
  const selected = new Map();

  for (const item of topCandidates) {
    if (selected.size >= TV_INDEX_LIMIT) break;
    selected.set(item.imdbId, item);
  }

  for (const [key, item] of recentMap.entries()) {
    selected.set(key, item);
  }

  const aliasMap = await loadAkasForIds(new Set(selected.keys()));
  for (const [imdbId, aliases] of aliasMap.entries()) {
    const item = selected.get(imdbId);
    if (item) {
      item.aliases = aliases;
    }
  }

  const items = Array.from(selected.values())
    .map((item) => ({
      ...item,
      searchText: buildTvSearchText(item)
    }))
    .sort((a, b) => {
      if (b.numVotes !== a.numVotes) return b.numVotes - a.numVotes;
      if (b.averageRating !== a.averageRating) return b.averageRating - a.averageRating;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

  const payload = {
    updatedAt: new Date().toISOString(),
    source: {
      basics: path.relative(ROOT, BASICS_FILE),
      ratings: path.relative(ROOT, RATINGS_FILE),
      episodes: fs.existsSync(EPISODE_FILE) ? path.relative(ROOT, EPISODE_FILE) : null,
      akas: fs.existsSync(AKAS_FILE) ? path.relative(ROOT, AKAS_FILE) : null
    },
    totals: {
      scanned,
      selected: items.length,
      includedRecent
    },
    items
  };

  writeJson('tv-show-index.json', payload);
  writeJson('tv-show-index.csv', [
    ['imdbId', 'title', 'originalTitle', 'startYear', 'endYear', 'genres', 'averageRating', 'numVotes', 'episodeCount', 'searchText'].join(','),
    ...items.map((item) => [
      item.imdbId,
      item.title,
      item.originalTitle,
      item.startYear,
      item.endYear,
      item.genres.join(', '),
      item.averageRating,
      item.numVotes,
      item.episodeCount,
      item.searchText
    ].map(csvEscape).join(','))
  ].join('\n'));

  return items;
}

async function buildMovieCatalogs() {
  assertExists(BASICS_FILE, 'IMDb basics file');
  assertExists(RATINGS_FILE, 'IMDb ratings file');

  const ratings = await loadRatings();
  const candidateHeap = new MinHeap((a, b) => {
    if (a.votes !== b.votes) return a.votes - b.votes;
    return a.rating - b.rating;
  });
  const recentMap = new Map();

  let scanned = 0;
  let includedRecent = 0;

  await streamTsvGz(BASICS_FILE, async (row) => {
    scanned += 1;
    if (row.titleType !== 'movie') return;
    if (row.isAdult === '1') return;

    const year = row.startYear === '' ? null : Number(row.startYear);
    const rating = ratings.get(row.tconst) || { averageRating: 0, numVotes: 0 };
    const item = {
      imdbId: row.tconst,
      title: row.primaryTitle || row.originalTitle || '',
      year: row.startYear || '',
      genres: uniqueGenres(row.genres),
      rating: rating.averageRating,
      votes: rating.numVotes,
      source: 'imdb-movie-index'
    };

    if (!item.title) return;

    if (year && year >= RECENT_MOVIE_YEAR_CUTOFF && rating.numVotes >= 5) {
      recentMap.set(item.imdbId, item);
      includedRecent += 1;
    }

    if (rating.numVotes >= 1000) {
      if (candidateHeap.size() < MOVIE_INDEX_LIMIT) {
        candidateHeap.push(item);
      } else if (candidateHeap.peek() && (item.votes > candidateHeap.peek().votes || (item.votes === candidateHeap.peek().votes && item.rating > candidateHeap.peek().rating))) {
        candidateHeap.pop();
        candidateHeap.push(item);
      }
    }
  });

  const topItems = sortByPopularity(candidateHeap.toArray());
  const selected = new Map();

  for (const item of topItems) {
    if (selected.size >= MOVIE_INDEX_LIMIT) break;
    selected.set(item.imdbId, item);
  }

  for (const [key, item] of recentMap.entries()) {
    selected.set(key, item);
  }

  const items = Array.from(selected.values())
    .map((item) => ({ ...item, searchText: buildMovieSearchText(item) }))
    .sort((a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      if (b.rating !== a.rating) return b.rating - a.rating;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

  writeJson('movie-index.json', items);

  const masterPopular = items.slice(0, 2000);
  writeJson('catalog_master_popular_2000.json', masterPopular);
  writeJson('catalog_master_popular_2000_trimmed.json', masterPopular);

  const top100AllTime = items.filter((movie) => movie.votes >= 50000)
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      return b.votes - a.votes;
    })
    .slice(0, 100);
  writeJson('catalog_top_100_all_time.json', top100AllTime);
  writeJson('catalog_top_100_all_time_trimmed.json', top100AllTime);

  const criticsChoices = items.filter((movie) => movie.rating >= 8.2 && movie.votes >= 15000)
    .sort((a, b) => b.rating - a.rating || b.votes - a.votes)
    .slice(0, 150);
  writeJson('catalog_critics_choices.json', criticsChoices);
  writeJson('catalog_critics_choices_trimmed.json', criticsChoices);

  const decades = {};
  masterPopular.forEach((movie) => {
    const year = Number(movie.year);
    if (!Number.isFinite(year)) return;
    const decade = Math.floor(year / 10) * 10;
    const key = `${decade}s`;
    decades[key] = decades[key] || [];
    decades[key].push(movie);
  });

  Object.keys(decades).forEach((decadeKey) => {
    const bucket = decades[decadeKey].slice(0, 100);
    writeJson(`catalog_popular_${decadeKey}.json`, bucket);
    writeJson(`catalog_popular_${decadeKey}_trimmed.json`, bucket);
  });

  return { items, totals: { scanned, selected: items.length, includedRecent } };
}

async function main() {
  const skipTv = process.argv.includes('--skip-tv');
  const skipMovies = process.argv.includes('--skip-movies');

  if (skipTv && skipMovies) {
    console.log('Nothing to build; both TV and movie builds were skipped.');
    process.exit(0);
  }

  if (!skipTv) {
    console.log('Building IMDb TV show index...');
    await buildTvIndex();
    console.log('IMDb TV show index build complete.');
  }

  if (!skipMovies) {
    console.log('Building IMDb movie catalogs and movie index...');
    await buildMovieCatalogs();
    console.log('IMDb movie catalogs build complete.');
  }

  console.log('\nFinished building IMDb indexes and catalogs.');
}

main().catch((err) => {
  console.error(`Build failed: ${err.message}`);
  process.exit(1);
});
