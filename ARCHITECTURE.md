# Curator Ops Architecture

Curator Ops is the operational control plane for CuratorOS. It aggregates evidence from individual services and produces deployment truth, freshness state, synthetic checks, correlated incidents, history, device/security context, and diagnostics.

## Stable production entrypoint

Cloudflare must deploy:

`src/ops.js`

The stable entrypoint currently delegates to the historical compatibility chain ending at `entry-v1.19.js`.

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
- `entry-v1.5.js` — operational history / intelligence
- `entry-v1.6.js` — Public Site Journey
- `entry-v1.7.js` — CuratorOS persistence self-test
- `entry-v1.8.js` — homepage monitoring summary injection
- `entry-v1.9.js` — Browser Search Journey
- `entry-v1.10.js` — Deployment Integrity
- `entry-v1.11.js` — Performance Anomaly
- `entry-v1.12.js` — Browser Search dispatch supervisor
- `entry-v1.13.js` — dependency-aware Operational State
- `entry-v1.14.js` — incident correlation and recovery lifecycle
- `entry-v1.15.js` — operational history intelligence and deployment correlation
- `entry-v1.16.js` — device observability, security telemetry, and briefing
- `entry-v1.17.js` — diagnostic engine
- `entry-v1.18.js` — recovery export and homepage/navigation normalization
- `entry-v1.19.js` — inline fleet diagnostics presentation

## Extraction strategy

The chain should be migrated incrementally rather than rewritten.

Preferred extraction order:

1. foundational control-plane modules — extracted:
   - runtime identity
   - deployment drift
   - scheduled freshness
   - Error Bus bridge
2. independent active monitors:
   - Public Site Journey
   - self-test
   - Browser Search
   - Deployment Integrity
   - Performance Anomaly
3. correlation/intelligence layers:
   - Operational State
   - incident correlation
   - history intelligence
   - diagnostics
4. presentation/support:
   - device/security/briefing
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
