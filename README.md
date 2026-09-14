# Curator Ops

Curator Ops is the operational control-plane monitor for Ocean Liner Curator / CuratorOS.

It is intentionally separate from content intelligence and site-quality monitoring. Ops tracks the machinery itself: service reachability, operational freshness, deployment reports, GitHub-to-Cloudflare deployment drift, scheduled-work freshness, synthetic visitor-path checks, real-browser search checks, monitoring-storage self-tests, and persistence-aware escalation into the CuratorOS Error Bus.

## Production

- Worker: `ops`
- Domain: `https://ops.oceanlinercurator.com`
- Primary KV binding: `CURATOR_OPS_RECORDS`
- Error Bus bridge KV binding: `CURATOR_ERROR_RECORDS`
- Current entrypoint: `src/entry-v1.9.js`

## Current capabilities

- Cross-zone reachability checks every 5 minutes
- Persistence-aware reachability states (`healthy` → `observing` → `degraded` → `persistent`)
- GitHub-to-running-Worker deployment drift checks
- Scheduled-work freshness checks
- Public Site Journey synthetic monitoring across homepage, shared navigation, homepage search, Pagefind runtime, standalone search, and Titanic destination
- Browser Search Journey using scheduled Playwright/Chromium against the live homepage search
- CuratorOS Self-Test that verifies persistence through both the Ops KV and Error Bus KV paths
- Quiet Ops → Error Bus escalation for persistent operational failures only
- Automatic Error Bus recovery when Ops sees the condition clear
- Human-readable fleet dashboard
- `GET /api/status`
- `GET /api/error-bus-bridge`
- `GET /api/public-site-journey`
- `GET /api/browser-search-journey`
- `GET /api/self-test`
- `GET /journey`
- `GET /browser-search-journey`
- `GET /self-test`
- `POST /api/check-now`
- `POST /api/public-site-journey-check-now`
- `POST /api/browser-search-journey-check-now`
- `POST /api/self-test-check-now`
- Authenticated `POST /api/heartbeat`
- Authenticated `POST /api/deployment`

## Public Site Journey

The Worker-level synthetic journey checks the served feature chain rather than only checking whether the homepage returns HTTP 200. It validates expected content and minimum response size for:

1. Homepage HTML
2. Shared navigation loader
3. Homepage search component
4. Pagefind runtime
5. Standalone search page
6. Titanic destination

A single failed journey is `observing`, a second consecutive failure is `degraded`, and a third consecutive failure is `persistent`. Only the persistent state is eligible for Error Bus escalation. A later successful journey clears the condition automatically through the existing Ops bridge.

## Browser Search Journey

A scheduled GitHub Actions job runs a real Chromium browser with Playwright every 15 minutes. It:

1. Opens the OceanLiners.net homepage
2. Waits for the injected homepage archive search
3. Types `Titanic`
4. Submits the search
5. Confirms a rendered Titanic result exists
6. Opens that result
7. Confirms Titanic content is present on the destination page

Curator Ops polls the public GitHub Actions result every five minutes. Failed-run persistence is counted by unique workflow run ID, so repeated polls of the same failed run do not inflate the failure streak. Three separate failed browser runs are required for a persistent Error Bus incident. Ops also detects a stale workflow when no fresh browser result has appeared within 45 minutes.

## CuratorOS Self-Test

The self-test monitors the monitoring storage paths themselves. Each scheduled run reads the sentinel written by the previous run, verifies that it is recent and structurally valid, and then writes the next sentinel to both `CURATOR_OPS_RECORDS` and `CURATOR_ERROR_RECORDS`.

This cross-run design avoids treating normal Workers KV propagation as a failure. The first run is expected to show a warming state because there is no previous sentinel yet. As with other Ops checks, only three consecutive failures become persistent and generate an Error Bus incident; recovery is automatic once both storage paths are healthy again.

## Write authentication

Create a Cloudflare Worker secret named `OPS_WRITE_KEY`.

Authenticated write requests send the secret in the `x-curator-ops-key` header. Never commit the secret to GitHub.

## Design rule

Ops reports operational truth only when it has evidence. Transient failures are observed quietly. Error Bus escalation is reserved for persistent reachability failures, persistent synthetic-journey failures, persistent browser-search failures or staleness, persistent monitoring self-test failures, confirmed deployment drift beyond the grace period, and genuinely stale scheduled work.

## Deployment note

Cloudflare Git builds must deploy the current repository HEAD with `npx wrangler deploy --config wrangler.toml`. If a dashboard endpoint reflects an older entrypoint, trigger a fresh Git commit rather than using a stale source-snapshot redeploy.
