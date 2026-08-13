# Curator Ops

Curator Ops is the operational control-plane monitor for Ocean Liner Curator / CuratorOS.

It is intentionally separate from content intelligence and site-quality monitoring. Ops tracks the machinery itself: service reachability, operational freshness, deployment reports, and eventually GitHub-to-Cloudflare deployment drift.

## Production

- Worker: `ops`
- Domain: `https://ops.oceanlinercurator.com`
- KV binding: `CURATOR_OPS_RECORDS`

## v1 capabilities

- Cross-zone reachability checks every 5 minutes
- Persistent operational snapshots
- Human-readable dashboard
- `GET /api/status`
- `POST /api/check-now`
- Authenticated `POST /api/heartbeat`
- Authenticated `POST /api/deployment`

## Write authentication

Create a Cloudflare Worker secret named `OPS_WRITE_KEY`.

Authenticated write requests send the secret in the `x-curator-ops-key` header. Never commit the secret to GitHub.

## Design rule

Ops reports operational truth only when it has evidence. A reachable service is not assumed to be correctly deployed, and GitHub/Cloudflare deployment parity will not be claimed until deployment metadata is wired into the system.
