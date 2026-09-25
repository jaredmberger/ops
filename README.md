# Curator Ops

Curator Ops is the operational control-plane monitor for Ocean Liner Curator / CuratorOS.

It is intentionally separate from content intelligence and site-quality monitoring. Ops tracks the machinery itself: service reachability, operational freshness, deployment reports, GitHub-to-Cloudflare deployment drift, scheduled-work freshness, synthetic visitor-path checks, real-browser search checks, deployment integrity, meaningful performance anomalies, monitoring-storage self-tests, and persistence-aware escalation into the CuratorOS Error Bus.

## Production

- Worker: `ops`
- Domain: `https://ops.oceanlinercurator.com`
- Primary KV binding: `CURATOR_OPS_RECORDS`
- Error Bus bridge KV binding: `CURATOR_ERROR_RECORDS`
- Current entrypoint: `src/entry-v1.18.js`

## Current capabilities

- Cross-zone reachability checks every 5 minutes
- Persistence-aware reachability states (`healthy` → `observing` → `degraded` → `persistent`)
- GitHub-to-running-Worker deployment drift checks
- Scheduled-work freshness checks
- Public Site Journey synthetic monitoring across homepage, shared navigation, homepage search, Pagefind runtime, standalone search, and Titanic destination
- Browser Search Journey using scheduled Playwright/Chromium against the live homepage search
- Deployment Integrity monitoring for critical documents/assets, redirects, content types, response size, markers, JSON validity, and error-page substitution
- Performance Anomaly monitoring using rolling per-path median baselines with conservative thresholds
- CuratorOS Self-Test that verifies persistence through both the Ops KV and Error Bus KV paths
- Dependency-aware Operational State that correlates reachability, scheduled freshness, deployment truth, synthetic monitors, browser dispatch state, and repository integrity
- Per-monitor snapshot freshness thresholds so a technically reachable monitor cannot silently stop reporting
- Root-cause classification that labels active findings as `root`, `independent`, or downstream `symptom` without suppressing the underlying evidence
- Correlated Incident Groups that present multiple related Error Bus incidents as one operational problem while preserving every underlying record
- Three-pass recovery verification for bridge-managed incidents and correlation groups
- Strict incident ownership boundaries so the legacy bridge cannot recover incidents created by newer specialist monitors
- Deployment correlation that places recent reported/runtime deployments beside incident onset without claiming causation from timing alone
- Compact daily operational rollups for efficient 24-hour, 7-day, and 30-day stability views
- Backward-compatible physical-device observability with optional firmware, board, display, Wi-Fi RSSI, battery, charging, power-source, and heartbeat-age metadata
- Bounded security telemetry for honeypot/sensor events with 1-hour / 24-hour / 7-day counts and burst detection, deliberately kept separate from Error Bus incident severity
- Current Briefing that condenses service health, deployments, scheduled work, correlated incidents, history, devices, and security into one operational readout
- Evidence-first “Why is this red?” diagnostic engine that explains confirmed upstream causes, downstream symptoms, independent findings, supporting evidence, and recent-but-unproven deployment correlations
- Stable homepage extension anchors plus a normalized navigation surface for every major operational view
- Pull-request smoke validation for JavaScript syntax, active import-chain integrity, wrangler entrypoint existence, and README/production-entrypoint agreement
- Quiet Ops → Error Bus escalation for persistent operational failures only
- Evidence-based Error Bus recovery: bridge-managed incidents require three consecutive clean reconciliation passes; specialist monitors retain their own recovery contracts
- Human-readable fleet dashboard
- `GET /api/status`
- `GET /api/error-bus-bridge`
- `GET /api/public-site-journey`
- `GET /api/browser-search-journey`
- `GET /api/deployment-integrity`
- `GET /api/performance-anomaly`
- `GET /api/self-test`
- `GET /api/operational-state`
- `GET /api/incident-correlation`
- `GET /api/operational-history`
- `GET /api/devices`
- `GET /api/security-summary`
- `GET /api/briefing`
- `GET /api/diagnostics`
- `GET /journey`
- `GET /browser-search-journey`
- `GET /deployment-integrity`
- `GET /performance-anomaly`
- `GET /self-test`
- `GET /operational-state`
- `GET /incidents`
- `GET /timeline`
- `GET /devices`
- `GET /security`
- `GET /briefing`
- `GET /diagnose`
- `POST /api/check-now`
- `POST /api/public-site-journey-check-now`
- `POST /api/browser-search-journey-check-now`
- `POST /api/deployment-integrity-check-now`
- `POST /api/performance-anomaly-check-now`
- `POST /api/self-test-check-now`
- `POST /api/operational-state-check-now`
- `POST /api/incident-correlation-check-now`
- `POST /api/operational-history-check-now`
- authenticated `POST /api/security-event`
- `POST /api/diagnostics-check-now`
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

A scheduled GitHub Actions job runs a real headed Chromium browser with Playwright every 15 minutes. It:

1. Opens the OceanLiners.net homepage
2. Waits for the injected homepage archive search
3. Types `Titanic`
4. Submits the search
5. Loads Pagefind through the narrowly scoped authenticated Pagefind exception
6. Confirms a rendered Titanic result exists
7. Confirms the result points to a valid OceanLiners.net Titanic destination

The synthetic intentionally does not navigate into the result because Cloudflare may challenge automated navigation to ordinary content pages. The success boundary is the functioning search experience and a valid rendered destination URL.

Curator Ops polls the GitHub Actions result every five minutes using the optional `GITHUB_OPS_TOKEN` Worker secret for authenticated GitHub API access. Failed-run persistence is counted by unique workflow run ID, so repeated polls of the same failed run do not inflate the failure streak. Three separate failed browser runs are required for a persistent Error Bus incident. Ops also detects a stale workflow when no fresh browser result has appeared within 45 minutes.

## Deployment Integrity

The deployment-integrity layer checks a small set of stable, high-value public-site invariants every five minutes:

1. Homepage document structure and minimum size
2. Shared navigation script
3. Homepage search component
4. Shared search-engine module
5. Pagefind metadata JSON
6. Primary hero/logo image
7. Titanic destination
8. Ship Archive destination

Each check verifies the expected HTTP response, content type, minimum response size, stable content markers where appropriate, and absence of unexpected redirects. Text responses are also screened for Cloudflare/error HTML returned in place of the expected asset, and Pagefind metadata must parse as valid JSON.

A single bad integrity observation is `observing`, a second consecutive bad observation is `degraded`, and a third is `persistent`. Only persistent failure creates an Error Bus incident (`p2`). Recovery is automatic once all integrity checks pass again.

## Performance Anomaly

The performance layer watches four representative successful requests every five minutes: the homepage, shared navigation script, homepage search component, and Titanic destination.

Each path builds its own rolling median from up to 72 recent successful observations. At least 12 successful samples are required before a path is judged, so the monitor begins in `warming` for roughly the first hour after deployment.

A timing observation is considered anomalous only when it is both at least **5× slower than that path's recent median** and at least **1500 ms** in absolute duration. An anomalous sample is excluded from the rolling baseline so a real slowdown does not immediately redefine normal. Failed HTTP requests are not treated as performance anomalies because availability and deployment-integrity monitors already cover those failure classes.

One anomalous observation is `observing`, two consecutive anomalous observations are `degraded`, and three consecutive anomalous observations are `persistent`. Only persistent regression creates a `p2` Error Bus incident. Normal performance automatically recovers the incident.

## CuratorOS Self-Test

The self-test monitors the monitoring storage paths themselves. Each scheduled run reads the sentinel written by the previous run, verifies that it is recent and structurally valid, and then writes the next sentinel to both `CURATOR_OPS_RECORDS` and `CURATOR_ERROR_RECORDS`.

This cross-run design avoids treating normal Workers KV propagation as a failure. The first run is expected to show a warming state because there is no previous sentinel yet. As with other Ops checks, only three consecutive failures become persistent and generate an Error Bus incident; recovery is automatic once both storage paths are healthy again.

## Operational State

The operational-state layer is the correlation plane above the individual monitors. It reads their latest persisted snapshots and applies explicit freshness expectations to each one. A monitor whose endpoint is still reachable but whose snapshot has stopped advancing is therefore visible as stale rather than falsely healthy.

It also consumes Ocean Liner Curator's public `/api/device/curatoros-integrity.json` manifest, allowing Curator Ops to include archive/sitemap/device-feed/Random-Ship reconciliation in the same operational picture.

The dependency model is intentionally conservative. Curator Ops currently recognizes only relationships supported by the architecture:

- Public Site reachability is upstream of Public Site Journey, Deployment Integrity, Performance Anomaly, and failed Browser Search Journey observations.
- Browser Search Journey staleness can be downstream of a blocked or failed Browser Dispatch Supervisor.
- An unhealthy CuratorOS Self-Test can explain stale persisted Ops snapshots because the storage layer itself is under question.

Other failures remain independent rather than being grouped by name or proximity. Phase 2 reports correlation but does not suppress existing Error Bus incidents; this provides a production proving period before incident deduplication changes alert behavior.

## Incident Correlation and Recovery Verification

The incident-correlation layer reads the dependency-aware Operational State and the active Error Bus registry together.

It does not delete, merge, rewrite, or hide Error Bus incidents. Instead, it creates a lossless operational grouping:

- one group represents the best evidenced root cause or independent failure
- related downstream incidents remain attached as individual evidence records
- the dashboard reports both grouped incident count and underlying active-incident count
- uncorrelated incidents remain standalone groups rather than being forced into a relationship

This means a public-site reachability failure plus several dependent synthetic failures can appear as one operational problem with several supporting signals, while all original Error Bus fingerprints and incident histories remain intact.

Recovery now uses positive repeated evidence in two places:

1. The original Ops Error Bus bridge requires three consecutive clean reconciliation passes before recovering an incident it owns.
2. Correlated incident groups remain in a `recovering` state until absent for three consecutive correlation passes.

The legacy bridge is also restricted to the incident families it actually owns: reachability, deployment drift, scheduled freshness, and Public Site Journey. Specialist incidents created by Browser Search, Deployment Integrity, Performance Anomaly, and Self-Test remain exclusively owned by those monitors.

## Deployment Correlation and History Intelligence

The history-intelligence layer adds long-horizon context without turning temporal coincidence into a causal claim.

For each active correlated incident group, Curator Ops looks for a service-matched deployment observed in the preceding 60 minutes. Matching evidence can come from authenticated deployment reports or the running-version/deployment-drift inventory. A match is labeled `temporal-correlation` and explicitly carries `causal: false`; it is an investigation clue, not a verdict.

Curator Ops also maintains one compact daily operational bucket. Every scheduled collection updates the bucket with:

- sample counts by healthy / observing / degraded / attention state
- maximum active correlated incident groups
- maximum underlying active Error Bus incidents
- maximum number of correlated duplicate signals
- accumulated root, independent, and downstream-symptom observations

Timestamped correlation snapshots power the rolling **24-hour** summary; compact daily buckets power the **7-day** and **30-day** summaries. Historical rollup coverage begins when this layer is deployed; older retained Error Bus incident/recovery events remain available separately and are included in window event counts where present. The 24-hour view is bounded by exact snapshot timestamps rather than whole-day bucket boundaries.

## Device Observability

The existing authenticated `POST /api/heartbeat` contract remains compatible with older CuratorOS devices. The minimum required field is still `service`.

New firmware may optionally report:

- `deviceId`
- `deviceClass`
- `board`
- `display`
- `firmware`
- `wifiRssi` / `rssi`
- `batteryPercent` / `battery`
- `powerSource`
- `charging`
- `maxAgeMinutes`

When `maxAgeMinutes` is omitted, Curator Ops uses a conservative 30-minute expectation. A device is `online` inside that window, `quiet` for up to three times the expected interval, and `stale` after that. Device state is observability information only; it does not automatically create an Error Bus incident because many physical displays may be intentionally powered down.

## Security Telemetry

Authenticated `POST /api/security-event` accepts bounded honeypot or security-sensor observations. It supports both generic field names and common OpenCanary-style names such as `src_host`, `dst_port`, and `logtype`.

Events are retained for 30 days and summarized into:

- last-hour, 24-hour, and 7-day volume
- 24-hour unique source count
- common destination ports
- common event categories
- common source addresses
- simple burst detection against the immediately preceding hour

Raw probe observations remain security telemetry rather than Error Bus incidents. This prevents normal Internet scanning from polluting infrastructure incident state.

## Current Briefing

`/briefing` provides a concise current-state summary built entirely from existing CuratorOS evidence. It includes service reachability, deployment truth, scheduled freshness, correlated incidents, 24-hour observed health, physical-device state, and security volume.

Briefing priorities can surface active operational incident groups, stale device heartbeats, and security bursts, but the briefing never raises incident severity by itself.

## Diagnostic Engine — “Why is this red?”

The diagnostic engine is the explanatory layer above Operational State, Correlated Incidents, History Intelligence, Device Observability, Security Telemetry, and the Error Bus.

`GET /diagnose` lists active diagnostic targets. Selecting a target, or calling `GET /api/diagnostics?target=<id>`, produces a structured diagnostic containing:

- current severity and confidence
- confirmed root or upstream cause when one is evidenced
- downstream `causedBy` relationship when present
- active Error Bus fingerprints supporting the condition
- service reachability, deployment state, and scheduled-work freshness where relevant
- recent deployment context from History Intelligence
- device heartbeat / RSSI / battery context for device targets
- concurrent security-burst context where relevant
- explicit next checks that would strengthen or falsify the current explanation

Evidence is intentionally labeled by strength. A dependency-backed upstream relationship can be `confirmed`; a related monitor or Error Bus record can be `supporting`; a recent deployment is always `temporal` and retains `causal: false` unless some future diagnostic layer independently establishes causation.

If CuratorOS lacks enough evidence to identify a root cause, the diagnostic says so and keeps the condition independent rather than forcing a narrative.

## Secrets

Create a Cloudflare Worker secret named `OPS_WRITE_KEY` for authenticated write endpoints.

Create a Cloudflare Worker secret named `GITHUB_OPS_TOKEN` to authenticate the Browser Search Journey GitHub API poll and avoid unauthenticated rate/abuse limits on shared Worker egress.

Authenticated Ops write requests send `OPS_WRITE_KEY` in the `x-curator-ops-key` header. Never commit either secret to GitHub.

## Design rule

Ops reports operational truth only when it has evidence. Transient failures are observed quietly. Error Bus escalation is reserved for persistent reachability failures, persistent synthetic-journey failures, persistent browser-search failures or staleness, persistent deployment-integrity failures, persistent meaningful performance regressions, persistent monitoring self-test failures, confirmed deployment drift beyond the grace period, and genuinely stale scheduled work.

## Repository validation

Pull requests and pushes to `main` run `.github/workflows/ops-smoke.yml`.

The smoke gate:

1. syntax-checks every JavaScript / MJS file under `src` and `scripts`
2. verifies that `wrangler.toml` declares a real production entrypoint
3. walks the active relative-import chain and verifies every imported source exists
4. verifies that the README's documented production entrypoint exactly matches `wrangler.toml`

The base homepage also exposes stable `CURATOR_OPS_NAV` and `CURATOR_OPS_CARDS` extension anchors. The final entry layer normalizes homepage navigation against those anchors so newer features no longer depend on replacing links introduced by earlier wrappers.

## Deployment note

Cloudflare Git builds must deploy the current repository HEAD with `npx wrangler deploy --config wrangler.toml`. If a dashboard endpoint reflects an older entrypoint, trigger a fresh Git commit rather than using a stale source-snapshot redeploy.
