# v2 UPDATE

complete re-write - microservice seperation

orchastrator and workers and prover routes


```
                  ┌──────────────────────────────┐
                  │   Background Cron Worker     │
                  │   (Runs LibraryScanner)      │
                  └──────────────┬───────────────┘
                                 │ Scans Drives & Read metadata.json
                                 ▼
                  ┌──────────────────────────────┐
                  │    Redis DB (Selected DB)    │◄─── [Acts as Source of Truth]
                  └──────────────┬───────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
┌──────────────────────────────┐                ┌──────────────────────────────┐
│       /api/library           │                │       /api/movies/:id        │
│    (Serves Dashboard)        │                │   (Resolves Playback URIs)   │
├──────────────────────────────┤                ├──────────────────────────────┤
│ Pulls complete catalog grid  │                │ Checks metadata storage tags.│
│ payload from Redis memory in │                │ If 'remote' -> calls B2 API. │
│ less than 1ms.               │                │ If 'local' -> targets NVMe.  │
└──────────────────────────────┘                └──────────────────────────────┘

```








# 🎬 StreamEngine Node
A lightweight, automated, database-less home media streaming server built with Node.js, Express, and Docker.

This platform allows you to search a global movie and TV series index, queue downloads with a single click directly into an isolated client, the meda is then automatically sanitized incoming file structures are renamed, cleaned up, deleted excess, optimize video containers via an asynchronous FFmpeg transcoding loop, stream high-performance progressive video directly to native HTML5 web players.

## 🚀 Core Features
Database-Less State Architecture: Zero database footprint. The system leverages the native storage engine of the torrent client for active tasks and uses on-disk metadata and transient file-system locks (.processing) to calculate live processing states.

Integrated Proxy Search: Queries the lightweight public REST API framework on the fly to surface movie details, cover art, and IMDb rating fields directly inside the frontend dashboard.

One-Click Ingestion Pipeline: Builds magnet links with robust public trackers on the fly and dispatches them across internal container networks with isolated tracking tags (movie-streamer).

Autonomous Lifecycle Execution: A completion webhook intercepts post-download lifecycle triggers to instantly execute a two-stage cleanup and normalization array (library-sanitizer.js ➡️ pre-transcode.js).

Web-Native Streaming Engine: Serves video assets over high-performance HTTP Byte-Range requests for responsive scrubbing, playback timeline accuracy, and on-the-fly .srt to WebVTT subtitle conversion.

## 🏗️ System Architecture
```
[ Web Browser UI ] 
        │ (YTS Proxy Search / Click to Add)
        ▼
[ Node/Express Server ] ──(Exposes Internal API on Port 3000)
        │
        ├──► [ qBittorrent Container:8080 ] (Dispatches Tagged Magnet Stream)
        │              │
        │              ▼ (Download Finalizes)
        │--> polls status and on complete initiates post processing chain.
        └──► Runs Command Chain:
              ├──► library-sanitizer.js (Cleans folder garbage)
              └──► pre-transcode.js (Drops .processing lock & runs FFmpeg loop)
```
## 📂 Project Repository Tree
Plaintext
```
.
├── movies/                       # Mounted media volumes container layer represents a local media folder
│   └── [Movie-Folder-Name]/
│       ├── Cover.jpg             # Local cover graphic asset
│       ├── Metadata.json         # Localized data record track
│       ├── Video_File.mp4        # Raw source file wrapper
│       ├── Video_File.web.mp4    # Optimized target asset container
│       └── .processing           # Transient state lock-file indicator
├── public/                       # Frontend assets directory
│   ├── index.html                # Media gallery dashboard
│   └── browse.html               # YTS API catalog crawler component
|   |__ player.html               # html5 media player interface.
├── server.js                     # Core Express engine router and streaming controller
├── library-sanitizer.js          # File structure normalization automation script
├── pre-transcode.js              # Recursive sequential FFmpeg x264/AAC transcode worker
└── package.json                  # Node dependencies configuration manifest
```
# 🛠️ Installation & Setup
1. Environmental Prerequisites
Ensure your microservices run inside the same user-defined bridge network space inside your Docker deployment stack.

2. Dependency Ingestion
Clone the repository into your runtime engine folder and install the internal node package frames:

Bash
npm install express axios form-data
3. qBittorrent Client Configuration
To allow your web dashboard to dispatch payloads cleanly through the internal network interfaces without managing session token expirations:

Navigate to Tools ➡️ Options ➡️ Web UI in the qBittorrent dashboard.

Scroll to the Authentication module context block.

Check Bypass authentication for clients on local subnets.

Define your Docker subnet address matrix configurations:

Plaintext
172.16.0.0/12, 127.0.0.1
4. Hooking Up The Automation Trigger   !!## Depricated - node service now initriates post processing automatically.
To trigger the post-processing optimization loop automatically when a download hits 100%, add this run command into your qBittorrent client configuration options under "Run external program on torrent completion":
```
Bash
curl -X POST http://movie-streamer-app:3000/api/trigger-automation < this  is not necassary anymore as the internal monitoring will trigger it itself.
```

## 🔧 Automation Pipeline Workflow Details
File Ingestion Pipeline
When clicking "Add to Library" on the catalog index screen:

The client assembles a standard magnet:?xt=urn:btih:... string tracking multiple trackers.

The payload lands on /api/yts/add, gets stamped with a custom movie-streamer workflow tag, and transfers to your download path.

Library Scanning & Transient Locking
While downloading, the movie remains invisible to users to prevent partial-file errors.

When the script picks up the file for processing, it drops a zero-byte .processing lock file into the directory. This flags the frontend monitor dashboard with a Pre-Transcoding (Optimizing) status.

Once FFmpeg outputs the web-optimized .web.mp4 stream file and removes the lock file, the movie automatically surfaces on the main dashboard screen, instantly ready for playback.

## 💻 Running the Server
Start the core streamer system engine cluster manually:

Bash
node server.js
For production deployment environments, wrap your operational container layer via Docker Compose mapping paths down onto local storage disks.

# To Do.

document updates made to the cloud / object storage expansion
document the worker configuration
document the auto subtitles
document the admin interface
document the user manager and signup process.
document the media profile configuration and automation transcode.
