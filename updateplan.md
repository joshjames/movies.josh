🏗️ Step 1: Target Architectural Blueprint
Here is the clean, maintainable directory layout we need to transition toward. This structure completely separates the API delivery mechanism from the heavy background worker loops.

Plaintext
```
movie-streamer/
├── config/                  # Sane, centralized state configuration
│   ├── db.js                # Shared database or file storage baseline connections
│   └── s3.js                # Consolidated AWS SDK/B2 S3 Client
├── src/
│   ├── server.js            # Light execution entrypoint (Loads middleware and routers)
│   ├── middleware/          # Security and auth wrappers
│   │   └── auth.js          # The requireAuth logic
│   ├── routes/              # Highly isolated, clean API endpoint clusters
│   │   ├── auth.routes.js
│   │   ├── admin.routes.js
│   │   ├── media.routes.js  # Clean wrapper around MediaService / playback endpoints
│   │   └── torrent.routes.js
│   └── services/            # Pure, stateless business logic handlers
│       ├── MediaService.js  # Presigned B2 URLs
│       ├── MetadataService.js # OMDb logic / mapping
│       └── TorrentService.js  # qBittorrent wrapper
├── workers/                 # 🧠 ATOMIC, ISOLATED BACKGROUND WORKERS
│   ├── file-sanitizer.worker.js   # Strictly fixes directory shapes and naming
│   ├── metadata-fetch.worker.js   # Strictly fetches OMDb/Posters and saves files
│   ├── cloud-sync.worker.js       # The migrated test-upload.js (Handles multi-part B2 streaming)
│   └── transcoder.worker.js       # Handles 720p/480p FFmpeg generation
├── Orchestrator.js          # 🚀 The Central Controller/Pipeline State Engine
├── public/                  # Frontend UI delivery (.html, .css, .js files)
├── .env                     # Raw configuration strings
└── package.json             # Upgraded engine requirements (Node >= 22)

```
# 🛠️ Step 2:
## The Core Strategic Action
Items:
To safely migrate without breaking the great progress you've made, we should attack the refactor using these structural 

phases:
1. Stripping down server.js (The Execution Hub)The Issue: Your server file is balancing route handling, business logic, asynchronous file scans, and database modifications simultaneously.The Move: server.js should only instantiate Express, register global middlewares (cookie-parser, express.json), mount the new decoupled sub-routers from the /src/routes/ directory, and listen on the execution port. It should not contain explicit route logic or deep anonymous callbacks.

2. Upgrading to Node.js >= 22 & Modern PatternsThe Issue: The runtime warning explicitly flagged old patterns and suggested upgrading to Node >= 22.The Move: Update your package.json to enforce "engines": { "node": ">=22.0.0" }. Take advantage of native features built directly into Node 22+, such as utilizing the native node:fs/promises cleanups and built-in environmental parsing tools where appropriate.

3. Deconstructing the Sanitizer into Atomic WorkersRight now, your sanitizer is doing too many sequential things, which causes it to drop out or produce duplicate assets when an unexpected failure happens. We need to split it into four pure, isolated workers that only do one job flawlessly:File Sanitizer Worker: Scans MOVIES_DIR. If it detects messy torrent names, it renames files/folders into a standard format (Title.Year). It does not call external APIs or talk to B2.Metadata Ingestion Worker: Looks for folders missing a metadata.json or movie_info.json. It connects to OMDb, pulls the structural payload, downloads the raw poster asset to disk, and updates the cache immediately.Cloud Sync Worker (The new worker.js replacing test-upload.js): Scans files that are marked as local but have a metadata.json layout.
It safely pipes multi-part file streams to Backblaze B2, validates completion, updates the local JSON storage block to "status": "synced", and handles local cleanup safely.🚀 

# Step 3:
## Designing the Orchestrator Engine
 
To completely remove procedural "falling rock" async issues from server.js, we introduce Orchestrator.js. 
This module manages state, schedules events, and safely chains workers using discrete Execution Triggers.
Architectural Trigger MatrixTrigger TypeSourceTarget ActionEvent-DrivenPOST /api/trigger-automation or qBittorrent script hooksTriggers File Sanitizer Worker, then cascades to metadata lookups.Scheduled / IntervalInternal setInterval tick or Cron (e.g., every 6 hours)
Triggers Cloud Sync Worker to sweep for pending transcoded files.
Manual OverridePOST /api/admin/sanitizer/run from Admin PanelExecutes specific worker thread on demand, immediately returning status to UI.