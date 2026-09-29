# AI Agent Instruction: Hybrid Search, Data Enrichment & Indexing Architecture

## 1. System Overview & Objective

You are tasked with building a high-performance, fault-tolerant search and auto-complete microservice for a streaming platform. 

The goal is to evolve the existing metadata pipeline into an enriched, semantic-aware search engine that supports:
- Automatic metadata enrichment from IMDb and external sources.
- Real-time typo correction and prefix auto-complete (e.g., `acktion` → `Action`, `scfi` → `Sci-Fi`).
- Rich keyword and tag associations.
- Vector-based semantic search for natural language queries (e.g., *"movies where the bad guy wins"*).
- Index-poisoning prevention via asynchronous search stream buffering.

---

## 2. Existing Data Context

The existing system utilizes three primary JSON structures:
1. `metadata.json`: Contains primary media titles, IDs, basic tags, and stream references.
2. `catalogs.json`: Defines category structures and genres.
3. `rows.json`: Defines horizontal UI collection layout mappings.

---

## 3. Architecture Blueprint

The architecture is divided into three core sub-services:

```
┌─────────────────────────────────────────────────────────┐
│              1. Data Enrichment Pipeline                │
│  metadata.json ──► IMDb/OMDb API ──► metadata.data.json │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│         2. Indexing & Vector Embedding Worker           │
│  metadata.data.json ──► Embedding Model + SymSpell      │
│                            │                            │
│                            ▼                            │
│                 Redis Stack (RedisJSON)                 │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│              3. Real-Time Search Service                │
│  User Query ──► Typo Normalizer ──► RedisSearch Engine  │
│         │                                               │
│         └──────► Redis Stream (Query Logger)            │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Implementation Requirements

### Phase 1: Data Enrichment Service (`metadata.data.json`)

Build an isolated pipeline or microservice (`enrichment_worker.py` / `.ts`):

1. **Input:** Parse entries from `metadata.json`.
2. **Enrichment:**
   * Query external sources (IMDb / OMDb / TMDB API) for each media ID or title.
   * Fetch extended metadata: Plot outline, full cast/crew, genres, keywords, user ratings, awards, micro-tags, and thematic tropes.
3. **Output:** Merge into `metadata.data.json` structured by media ID:

```json
{
  "media_id_1042": {
    "title": "The Dark Knight",
    "year": 2008,
    "genres": ["Action", "Crime", "Drama"],
    "cast": ["Christian Bale", "Heath Ledger"],
    "keywords": ["heist", "bank robbery", "vigilante", "corrupt cop"],
    "themes": ["moral decay", "bad guy wins", "hero falls"],
    "plot": "When the menace known as the Joker wreaks havoc and chaos on the people of Gotham...",
    "canonical_synonyms": ["dark knight", "batman 2", "the dark knight"]
  }
}
```

---

### Phase 2: Indexing, Embeddings & Vector Storage

Create an indexing service (`index_builder.py` / `.ts`):

1. **Vector Embedding Generation:**
   * For each entry in `metadata.data.json`, generate a text embedding vector for semantic search.
   * **Target string for embedding:** Combine `${title} ${genres.join(' ')} ${keywords.join(' ')} ${themes.join(' ')} ${plot}`.
   * **Model:** Use a lightweight model (e.g., HuggingFace `all-MiniLM-L6-v2` or OpenAI `text-embedding-3-small`).

2. **RedisJSON Storage:**
   * Store enriched documents inside Redis using **RedisJSON**:
   * Key pattern: `media:<media_id>`

3. **RedisSearch Schema Setup:**
   * Initialize a RediSearch index over JSON documents:

```bash
FT.CREATE idx:media ON JSON PREFIX 1 media: SCHEMA \
  $.title AS title TEXT WEIGHT 5.0 \
  $.genres[*] AS genres TAG \
  $.keywords[*] AS keywords TEXT WEIGHT 2.0 \
  $.themes[*] AS themes TEXT WEIGHT 2.0 \
  $.plot AS plot TEXT WEIGHT 1.0 \
  $.embedding AS vector VECTOR FLAT 6 TYPE FLOAT32 DIM 384 DISTANCE_METRIC COSINE
```

---

### Phase 3: Typo Correction & Autocomplete Pipeline

Integrate **SymSpell** and **Redis Auto-complete**:

1. **SymSpell Dictionary Build:**
   * Load all standard genres, titles, keywords, actor names, and common misspellings into a SymSpell frequency dictionary during index build.
   * Fast $O(1)$ lookup for edit distances up to 2 (e.g., `sciffi` → `Sci-Fi`, `acktion` → `Action`).

2. **Redis Auto-complete Dictionary:**
   * Populated with canonical terms for fast prefix matching:

```bash
FT.SUGADD autocomplete "Sci-Fi" 1.0
FT.SUGADD autocomplete "Action" 1.0
```

---

### Phase 4: Dynamic Search Capture & Safe Index Growth

Prevent index poisoning from raw user queries (typos, spam, zero-result terms):

1. **Query Ingestion:**
   * Push incoming user queries to a **Redis Stream** (`xadd search_events * query <user_input> results_count <n>`).
2. **Aggregation Worker:**
   * Periodically evaluate stream items.
   * Only register terms into the permanent dictionary/autocomplete if:
     - `results_count > 0`
     - Query appears $\ge N$ times across distinct sessions.
     - Term passes profanity and sanitization filters.

---

## 5. End-to-End Query Execution Flow

When a user submits a query to the API:

```
1. Receive raw input (e.g., "acktion movies with bank robbery")
   │
2. SymSpell / Dictionary Normalizer
   └── Corrects "acktion" ──► "action"
   │
3. Route Query:
   ├── A. Exact / Prefix Match (Redis Auto-complete / Tag Match)
   └── B. Hybrid Vector Match (RedisSearch KNN)
   │
4. Log Raw Query to Redis Stream (Async)
   │
5. Return Consolidated & Ranked Results to UI
```

---

## 6. Development Checklist for AI Agent

- [ ] Build script to extract data from `metadata.json`, query external API, and write `metadata.data.json`.
- [ ] Implement embedding generator pipeline for media plots/keywords.
- [ ] Set up Redis Stack (RedisJSON + RediSearch) instance/container.
- [ ] Write index build script to push JSON documents and vector indices to Redis.
- [ ] Integrate SymSpell library for real-time query string normalization.
- [ ] Create Redis Stream logger for incoming user search events.
- [ ] Expose unified REST/gRPC endpoint for UI search box consuming autocomplete and search results.