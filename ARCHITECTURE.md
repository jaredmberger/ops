# Curator Ops Architecture

Curator Ops is the operational control plane for CuratorOS. It aggregates evidence from individual services and produces deployment truth, freshness state, synthetic checks, correlated incidents, history, device/security context, and diagnostics.

## Stable production entrypoint

Cloudflare must deploy:

`src/ops.js`

The stable entrypoint now delegates directly to the named `fleet-diagnostics.js` module. No numbered `entry-v1.x.js` file is part of the production import graph.

The numbered `entry-v1.x.js` pattern is frozen. Do not add `entry-v1.20.js` or later wrappers for new production capabilities.

New work should either:

1. modify the named module that owns the concern, or
2. extract the relevant compatibility layer into a named module and route the stable entrypoint through that module.

## Current compatibility map

- `src/runtime-identity.js` — runtime identity and runtime inventory
- `src/deployment-drift.js` — deployment drift
- `src/scheduled-freshness.js` — scheduled-work freshness
- `src/error-bus-bridge.js` — Ops → Error Bus reconciliation bridge
- `entry-v1.1.js` through `entry-v1.4.js` — compatibility shims only
- `src/incident-history.js` — incident history and `/api/curator-intelligence`
- `entry-v1.5.js` — compatibility shim only
- `src/public-site-journey.js` — Public Site Journey
- `src/self-test.js` — CuratorOS persistence self-test
- `src/monitoring-summary.js` — homepage monitoring summary injection
- `src/browser-search-journey.js` — Browser Search Journey
- `src/deployment-integrity.js` — Deployment Integrity
- `src/performance-anomaly.js` — Performance Anomaly
- `entry-v1.6.js` through `entry-v1.11.js` — compatibility shims only
- `src/browser-search-dispatch.js` — Browser Search dispatch supervisor
- `src/operational-state.js` — dependency-aware Operational State
- `src/incident-correlation.js` — incident correlation and recovery lifecycle
- `src/operational-history.js` — operational history intelligence and deployment correlation
- `src/device-security-briefing.js` — device observability, security telemetry, and briefing
- `src/diagnostics.js` — diagnostic engine
- `entry-v1.12.js` through `entry-v1.17.js` — compatibility shims only
- `src/recovery-home.js` — recovery export and homepage/navigation normalization
- `src/fleet-diagnostics.js` — inline fleet diagnostics presentation
- `entry-v1.18.js` and `entry-v1.19.js` — compatibility shims only

## Extraction strategy

The chain should be migrated incrementally rather than rewritten.

Preferred extraction order:

1. foundational control-plane modules — extracted:
   - runtime identity
   - deployment drift
   - scheduled freshness
   - Error Bus bridge
2. independent active monitors — extracted:
   - Public Site Journey
   - self-test
   - homepage monitoring summary adapter
   - Browser Search
   - Deployment Integrity
   - Performance Anomaly
3. correlation/intelligence layers — extracted:
   - Browser Search dispatch supervision
   - Operational State
   - incident correlation
   - history intelligence
   - devices/security/briefing support
   - diagnostics
4. presentation/support — extracted:
   - device/security/briefing
   - incident history/intelligence
   - recovery export
   - homepage/fleet presentation

Each extraction must preserve routes, KV key families, scheduled behavior, incident ownership boundaries, and recovery semantics.

## Design constraints

- Ops reports evidence, not guesses.
- Transient observations should not become persistent incidents without the documented persistence threshold.
- Specialist monitors own their own incidents; the bridge must not recover incidents it did not create.
- Deployment Drift uses runtime-stamped Git identity and GitHub ancestry/file-diff evidence.
- Ops includes itself in deployment truth using local runtime metadata.
- Recovery/export surfaces remain read-only except for explicitly authenticated operational write endpoints.
- Physical-device telemetry is observational and should not create infrastructure incidents merely because a device is powered off.

## Architecture guard

CI validates that:

- `wrangler.toml` points to `src/ops.js`
- `src/ops.js` exists
- the stable entrypoint imports/re-exports only an existing compatibility or named module
- no `entry-v1.20.js` or later wrapper is introduced
- README and Wrangler agree on the production entrypoint
- the active relative-import graph resolves completely

This keeps the stable boundary fixed while allowing the internal implementation to improve safely.


## Named foundational control plane

The first four operational layers now live in named modules:

- `runtime-identity.js`
- `deployment-drift.js`
- `scheduled-freshness.js`
- `error-bus-bridge.js`

The historical v1.1-v1.4 files are compatibility shims only, and `entry-v1.5.js` imports the named bridge directly. This removes the foundational control plane from the numbered-wrapper traversal without changing routes, KV keys, schedules, or incident semantics.


## Named independent monitors

The primary independent monitor stack now lives in named modules:

- `public-site-journey.js`
- `self-test.js`
- `monitoring-summary.js`
- `browser-search-journey.js`
- `deployment-integrity.js`
- `performance-anomaly.js`

The historical v1.6-v1.11 files are compatibility shims only. `entry-v1.12.js` now imports `performance-anomaly.js` directly, so those six numbered layers are no longer part of live traversal.

This extraction preserves each monitor's persistence thresholds, KV key families, scheduled behavior, and specialist incident ownership.


## Named correlation and intelligence layers

The correlation/intelligence path now lives in named modules:

- `browser-search-dispatch.js`
- `operational-state.js`
- `incident-correlation.js`
- `operational-history.js`
- `device-security-briefing.js`
- `diagnostics.js`

The historical v1.12-v1.17 files are compatibility shims only. `entry-v1.18.js` imports `diagnostics.js` directly, removing the entire correlation/intelligence sequence from numbered-wrapper traversal.

The extraction preserves dependency-aware state classification, lossless incident grouping, repeated recovery confirmation, temporal-not-causal deployment correlation, observational device/security semantics, and evidence-labeled diagnostics.


## Completed named-module migration

The production import graph is now fully named from `src/ops.js` downward.

Historical `entry-v1.x.js` files remain only as compatibility shims for repository history and any external references. CI fails if any numbered compatibility shim re-enters the production import graph.
