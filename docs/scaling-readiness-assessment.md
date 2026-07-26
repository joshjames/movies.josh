# Scaling Readiness Assessment

This note covers two separate targets:

1. Local load balancing and horizontal scaling on one site.
2. Multi-site active/active or active/passive failover between servers.

## Bottom Line

The codebase is partially ready for local scaling, but not yet ready for clean multi-site failover without discipline around write authority and startup jobs.

The current architecture is closer to this model:

- `metadata.json` on disk is the canonical media truth.
- Redis is a derived read/cache layer.
- The web/API process still owns static assets, auth, media routes, and several startup jobs.
- Workers are already split out, which is the strongest part of the current design.

That means the system can be improved with incremental splitting, but a second node cannot yet be treated as a fully interchangeable peer unless the write path and boot-time side effects are tightened.

## Ordered Task Breakdown

This is the recommended order if the goal is to support one central write site first, then replicate read capability to another site with minimal complexity.

### Stage 1: Freeze the path contract

1. Define a canonical media path/URI model in metadata.
2. Store the absolute playback source for processed media, including the site FQDN when the file is still local to a site.
3. Keep cloud object keys alongside the site path so both delivery modes are available.
4. Add a clear fallback order for readers: cloud key first, local absolute path second, peer-site absolute URL third.

This is the key simplifier. It lets a replicated site still serve recently added media from the central site over the WAN if the file has not yet been pushed to object storage.

### Stage 2: Split the serving surfaces

5. Move static `/public` delivery out of the core app container.
6. Keep the API/web process separate from worker execution.
7. Make the app tier safe to run as multiple replicas behind a local reverse proxy or container LB.

This is the local load balancing slice. It is useful, but it should stay small and should not be allowed to drag the multi-site work backward.

### Stage 3: Lock down the single writer site

8. Keep downloads, queue coordination, and worker writes on one designated main site for now.
9. Ensure only that site runs startup scans, queue reconciliation, and destructive maintenance jobs.
10. Make all other sites read-mostly replicas until the write path is fully centralized.

This keeps the first multi-site version simple and avoids cross-node write conflicts.

### Stage 4: Replicate only the small, safe state

11. Sync metadata, manifests, registry files, and other small operational files between sites.
12. Exclude large media files from rsync so they do not dominate replication time.
13. Rebuild Redis from files at each site instead of treating Redis as the only source of truth.
14. Keep Redis as a cache/projection layer that can be rebuilt at any point.

This is the stage where the second site can be brought up and still function without owning the full media corpus.

### Stage 5: Add peer-site playback fallback

15. Teach the playback resolver to use local media if present.
16. If local media is missing, allow the resolver to stream from the central site by absolute site URL.
17. Use this only as a transition path for recently processed media, not as the long-term delivery model.

This gives you continuity while the object storage migration is still incomplete.

### Stage 6: Move finished media off the site link

18. Push processed media to object storage once it is finalized.
19. Update metadata so completed media points to cloud delivery as the primary path.
20. Keep the site URL fallback only for transitional or partial states.

At this point the WAN fallback becomes a safety net instead of the normal delivery path.

### Stage 7: Introduce site-aware routing

21. Add geo or health-based DNS routing once the data model is stable.
22. Route users to the nearest healthy site for login and read traffic.
23. Keep a known main site available for write-heavy operations until you are ready to make coordination fully distributed.

This is the point where multi-site feels like a platform instead of a workaround.

## Local Load Balancing Assessment

### What is already good

- The compose stack already separates workers from the main app process.
- `pipeline-runner` is already a distinct service.
- Worker endpoints are externalized through `WORKER_URL_*` variables.
- Redis startup is optional and non-blocking, so the app can still boot in reduced mode.

### What still blocks easy horizontal scaling

- `server.js` still serves the frontend, API routes, auth, and media assets from one process.
- `server.js` also runs startup scans and queue reconciliation, which would duplicate work if you run several replicas.
- There is an in-memory `sessionActivity` map used for runtime metrics, which is fine for observability but not shareable state.
- The web process still touches local filesystem paths directly for media and metadata access.

### Recommended local split

For local load balancing, the smallest useful split is:

- Static frontend: move `/public` behind a CDN or a separate static origin.
- API/runtime: keep a stateless API/web service behind a local reverse proxy or container LB.
- Workers: keep scaled separately from the API/web tier.
- Single coordinator: keep only one replica responsible for pipeline watcher and autoscan unless those jobs are made idempotent and distributed.

### Local scaling priorities

1. Externalize static assets so the app container does not need to carry frontend traffic.
2. Split the API/web runtime from background scanning and pipeline coordination.
3. Make startup scans and reconciliation run on a single designated node only.
4. Keep the worker tier independent so it can scale separately from the web tier.

## Multi-Site Readiness Assessment

### Current truth model

The codebase is not currently using Redis as the source of truth.

Current behavior is:

- Disk metadata is the canonical record.
- Redis stores a derived library snapshot.
- `db.js` falls back to JSON if Redis is unavailable.
- `metadata-flow.md` already documents this contract.

That is good for recoverability, but it means a second site is only safe if the disk layer and the write paths are kept consistent.

### What must be true for site failover

If you want to rsync folders and sync Redis between two servers, the following must be true:

- Writes must happen in one place or through a conflict-safe registry.
- Every authoritative file write must be replicated before the second site is considered live.
- Redis must be rebuildable from disk at any time.
- Any in-memory-only state must be treated as disposable or rebuilt on boot.
- Background jobs must not double-write when both sites are online.

### Main multi-site blockers

- Canonical writes still depend on file-system local paths.
- Redis is derived, not authoritative, so it cannot by itself resolve conflicts between two active writers.
- Queue startup and library scanning can run on boot, which is risky if both sites are active.
- Torrent/qBittorrent, metadata repair, and media writes still assume one active write authority.
- A few runtime maps and startup sweeps are process-local, so they do not transfer across nodes automatically.

### Recommended multi-site model

The safest near-term model is:

- One active writer site.
- One or more read-capable standby or peer sites.
- Redis mirrored or rebuildable, but not trusted as the only truth layer.
- Media/storage synchronized externally through rsync or object storage.
- Only one node allowed to run queue-processing and destructive maintenance jobs.

If you later want true active/active, the write model needs to be made conflict-aware first. Right now the code is closer to active/read-mostly with a single write coordinator.

## Recommended Architecture Direction

### Short term

- Keep the current metadata-on-disk contract.
- Split the static frontend off the app container.
- Keep workers split and scale only the worker that has meaningful CPU pressure.
- Make one node the designated queue and scan coordinator.

### Medium term

- Introduce a clear web/API service boundary.
- Add a dedicated coordination layer for writes and scan scheduling.
- Make Redis a replicated read model that can be rebuilt from disk.
- Move media delivery toward CDN/object storage where possible.

### Long term

- Treat the app as a distributed platform with one authoritative write path and globally replicated reads.
- Put all media payloads on object storage or a similarly durable shared layer.
- Use geo routing only after the state model is safe across sites.

## Practical Recommendation

Do not try to solve local load balancing and multi-site failover at the same time.

The best order is:

1. Separate static frontend delivery from the app process.
2. Make the API/web tier safe for multiple replicas.
3. Keep one designated writer/coordinator.
4. Prove rsync/Redis sync restore between two nodes.
5. Only then add geo routing and multi-site DNS failover.

## Key References

- [docs/metadata-flow.md](./metadata-flow.md)
- [docs/ACTIVE_ACTIVE_WORKER_DEPLOYMENT.md](./ACTIVE_ACTIVE_WORKER_DEPLOYMENT.md)
- [server.js](../server.js)
- [docker-compose.yml](../docker-compose.yml)