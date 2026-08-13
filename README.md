# Curator Ops

Curator Ops is the operational control-plane monitor for Ocean Liner Curator / CuratorOS.

It is intentionally separate from content intelligence and site-quality monitoring. Ops tracks the machinery itself: service reachability, operational freshness, deployment reports, GitHub-to-Cloudflare deployment drift, scheduled-work freshness, and persistence-aware escalation into the CuratorOS Error Bus.

## Production

- Worker: `ops`
- Domain: `https://ops.oceanlinercurator.com`
- Primary KV binding: `CURATOR_OPS_RECORDS`
- Error Bus bridge KV binding: `CURATOR_ERROR_RECORDS`
- Current entrypoint: `src/entry-v1.4.js`

## Current capabilities

- Cross-zone reachability checks every 5 minutes
- Persistence-aware reachability states (`healthy` → `observing` → `degraded` → `persistent`)
- GitHub-to-running-Worker deployment drift checks
- Scheduled-work freshness checks
- Quiet Ops → Error Bus escalation for persistent operational failures only
- Automatic Error Bus recovery when Ops sees the condition clear
- Human-readable fleet dashboard
- `GET /api/status`
- `GET /api/error-bus-bridge`
- `POST /api/check-now`
- Authenticated `POST /api/heartbeat`
- Authenticated `POST /api/deployment`

## Write authentication

Create a Cloudflare Worker secret named `OPS_WRITE_KEY`.

Authenticated write requests send the secret in the `x-curator-ops-key` header. Never commit the secret to GitHub.

## Design rule

Ops reports operational truth only when it has evidence. Transient failures are observed quietly. Error Bus escalation is reserved for persistent reachability failures, confirmed deployment drift beyond the grace period, and genuinely stale scheduled work.

## Deployment note

Cloudflare Git builds must deploy the current repository HEAD with `npx wrangler deploy --config wrangler.toml`. If a dashboard endpoint reflects an older entrypoint, trigger a fresh Git commit rather than using a stale source-snapshot redeploy.
