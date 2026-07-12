# Active/Active Worker Split Deployment

## Goal
Run web/API on both sites, but keep queue ingestion single-active first.

- LA: active pipeline runner + qBittorrent + workers
- Sydney: web/API active, pipeline runner disabled

This avoids duplicate queue processing while still allowing both sites to serve users.

## Runtime Topology
- `movie-streamer-web` (port 3000): web/API only
- `pipeline-runner`: queue processor (`PipelineWorker`) only
- `ingest-worker` (port 5000)
- `metadata-worker` (port 5001)
- `subtitle-worker` (port 5002)
- `transcoder-worker` (port 5003)
- `cloudsync-worker` (port 5004)
- `redis`
- `qbittorrent`

## Worker Endpoint Environment Variables
All worker calls are now endpoint-driven:

- `WORKER_URL_INGEST` default `http://ingest-worker:5000/process`
- `WORKER_URL_METADATA` default `http://metadata-worker:5001/process`
- `WORKER_URL_SUBTITLES` default `http://subtitle-worker:5002/process`
- `WORKER_URL_TRANSCODE` default `http://transcoder-worker:5003/process`
- `WORKER_URL_CLOUDSYNC` default `http://cloudsync-worker:5004/process`

Legacy fallback is still accepted for cloud sync:
- `WORKER_URL_UPLOAD`

## qBittorrent Over WireGuard
Use a WireGuard-reachable qBittorrent URL for any runtime that needs torrent status/tag operations:

- `QBIT_URL=http://<wg-ip-or-dns>:8080`

## Single-Active Queue Safety
Run exactly one `pipeline-runner` service across both sites in phase 1.

- LA: enabled
- Sydney: not deployed or scaled to 0

## Cloud Sync Completion Gate (optional but recommended)
To require cloud upload before items become playable/complete in queue flow:

- `REQUIRE_CLOUDSYNC_BEFORE_COMPLETE=true`

When enabled, queue progression is:
- `INGEST -> METADATA -> SUBTITLES -> TRANSCODE -> CLOUDSYNC -> COMPLETE`

## Suggested Site Modes
### LA (active pipeline)
- deploy full stack including `pipeline-runner`
- local workers or LAN workers

### Sydney (read-mostly + remote processing)
- deploy `movie-streamer-web`, `redis`
- do not run `pipeline-runner`
- set worker endpoints to LA over WireGuard if you want centralized processing:
  - `WORKER_URL_INGEST=http://<la-wg-ip>:5000/process`
  - `WORKER_URL_METADATA=http://<la-wg-ip>:5001/process`
  - `WORKER_URL_SUBTITLES=http://<la-wg-ip>:5002/process`
  - `WORKER_URL_TRANSCODE=http://<la-wg-ip>:5003/process`
  - `WORKER_URL_CLOUDSYNC=http://<la-wg-ip>:5004/process`

## Data Authority Notes
- Keep `MetadataRegistry` as the metadata write authority for JSON + Redis mirror.
- Continue using one queue runner until all write paths are fully centralized and conflict-safe.
