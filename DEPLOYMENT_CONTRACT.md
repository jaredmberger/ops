# CuratorOS Production Deployment Contract

CuratorOS treats deployment state as operational evidence, not as an assumption derived from a successful pull-request build.

## Canonical source

For each Git-connected Worker monitored by Curator Ops:

- canonical repository branch: `main`
- production deploy command: `npx wrangler deploy --config wrangler.toml`
- pull-request / non-production builds are previews only
- a successful preview build does not prove that production advanced after merge

## Runtime identity

Every monitored Worker should expose `GET /api/runtime` with:

- `service`
- `repository`
- `runtime`
- `version`
- `cloudflareVersion.id`
- `cloudflareVersion.timestamp`
- `build.commit`
- `build.branch`
- `build.buildUuid`
- `build.source`
- `observedAt`

The authoritative deployed Git identity is `build.commit`.

Build metadata may use Cloudflare Workers Builds variables when present and must fall back to the checked-out Git HEAD so manual or GitHub-driven Wrangler deploys remain attributable.

## Cloudflare Git settings

For each production Worker, verify in Cloudflare:

1. **Settings → Build → Branch control**
2. Production branch is **`main`**
3. Preview builds may be enabled for pull requests, but they must not be treated as production evidence
4. Production deploy command is **`npx wrangler deploy --config wrangler.toml`**
5. Preview command should use the Worker preview path appropriate to the project, normally **`npx wrangler preview`** when Worker Previews are enabled

If a Worker is still using an older preview model, review that configuration separately; preview behavior must not overwrite or substitute for the production branch contract.

## Curator Ops classification

Deployment Drift compares the runtime-stamped commit with GitHub `main`.

- identical SHA → `in-sync`
- different SHA but zero changed files → `in-sync / content-equivalent`
- recent GitHub head inside the deployment grace window → `pending`
- verified running commit behind `main` with changed files → `drift`
- verified running commit ahead of `main` → `drift`
- divergent histories → `drift`
- mismatch without verifiable Git relationship → `unknown`, not confirmed drift

Only confirmed `drift` is eligible for Ops → Error Bus escalation.

## Self-observation

Curator Ops must follow the same contract as the services it monitors.

Ops stamps its own build commit during deployment and evaluates that local runtime identity directly. It does not fetch its own public hostname to determine self-deployment state.

This prevents stale Ops production code from silently producing outdated fleet conclusions.

## Monitored deployment-truth fleet

Current deployment-drift inventory:

- Curator Ops — `jaredmberger/ops`
- Error Bus — `jaredmberger/errors`
- Curator Verify — `jaredmberger/verify`
- Site Health — `jaredmberger/site-health`
- Curator Integrity — `jaredmberger/curator-integrity`
- Curator Speed — `jaredmberger/speed`
- Curator Indexer — `jaredmberger/curator-indexer`
- Search Intelligence — `jaredmberger/search-intelligence`
- Curator Analytics — `jaredmberger/analytics`
- Content Opportunity — `jaredmberger/content-opportunity`

## Incident response for a red deployment row

1. Read the running commit and GitHub main commit in `/deployments`.
2. Check the relationship and changed-file count reported by Ops.
3. If the running commit is genuinely behind, inspect the Worker's Cloudflare production branch/build settings.
4. Confirm `main` is the production branch.
5. Confirm the production deploy command is Wrangler deploy, not versions upload or a preview command.
6. Trigger a fresh production build from current `main`.
7. Re-run Deployment Drift.
8. Do not manually clear the Error Bus incident; allow repeated clean Ops evidence to recover it through the normal bridge contract.
