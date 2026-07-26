# Cloudflare DNS Operations

This repo now includes a Cloudflare DNS CLI so you can inspect zones and manage DNS records directly from the project environment.

## Supported Credentials

The CLI will use the first available token from:

1. `CF_API_TOKEN`
2. `ACCOUNT_API_TOKEN`
3. `AUTH_TOKEN`
4. `ACCOUNT_API_KEY`

For DNS work, the token must have at minimum:

1. `Zone:Read`
2. `DNS:Read`
3. `DNS:Edit` for update operations

`ACCESS_ID`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and `S3_API` are useful for R2/object storage, not DNS. In your setup, `AUTH_TOKEN` may also be an R2 user token, so prefer `ACCOUNT_API_TOKEN` for DNS.

## Commands

List accessible zones:

```bash
npm run cf:dns:list-zones
```

List DNS records in a zone:

```bash
npm run cf:dns:list-records -- --zone any.movie
```

Filter by record type or name:

```bash
npm run cf:dns:list-records -- --zone any.movie --type CNAME
npm run cf:dns:list-records -- --zone any.movie --name www
```

Upsert a single record:

```bash
npm run cf:dns:sync-record -- --zone any.movie --type A --name @ --content 203.0.113.10 --proxied true --ttl 1
```

Bulk sync from a file:

```bash
npm run cf:dns:sync-file -- --file config/cloudflare-dns.records.example.json
```

## Bulk Sync File Format

Use a JSON array of record definitions. See [config/cloudflare-dns.records.example.json](/home/epic/movie-streamer/config/cloudflare-dns.records.example.json).

Each item supports:

1. `zoneName`
2. `type`
3. `name`
4. `content`
5. `ttl`
6. `proxied`
7. `comment`

## Recommended Domain Layout

For your current cutover plan:

1. Keep `any.movie` as the canonical root.
2. Keep `anyseries.online` and your active `anymovie.*` domains live as alias domains.
3. Point alias domains at the same frontend/proxy target until geo-routing is ready.
4. Use server FQDNs under `any.movie` for future region-specific origins, for example:
   - `edge-us-lax-1.any.movie`
   - `edge-au-syd-1.any.movie`
   - `edge-eu-fra-1.any.movie`

## Notes

1. Zone IDs do not need to be stored in `.env`; the CLI resolves them by zone name.
2. This tooling manages DNS records only. It does not configure Cloudflare Load Balancer, Geo Steering, or health checks.
3. Start with `list-zones` and `list-records` before applying sync operations.