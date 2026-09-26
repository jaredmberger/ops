# Curator Ops Recovery Export

Curator Ops provides a complete, read-only backup of its primary `CURATOR_OPS_RECORDS` Cloudflare KV namespace at:

`GET /api/recovery-export`

## Scope

The export is intentionally limited to `CURATOR_OPS_RECORDS`.

Curator Ops also reads and writes the shared `CURATOR_ERROR_RECORDS` namespace, but that store has its own authoritative recovery export in the Error Bus service. Keeping the two backup boundaries separate avoids duplicate or conflicting copies of shared monitoring state.

The Ops export paginates every key in its primary namespace and preserves exact key/value pairs, including future keys that are not yet known to this documentation.

## Security

Configure the Cloudflare Worker secret:

`RECOVERY_EXPORT_TOKEN`

Send it as:

`X-Curator-Recovery-Key: <RECOVERY_EXPORT_TOKEN>`

If the secret is absent, the endpoint remains disabled and returns 503.

## Backup contents

Each export includes:

- every key in `CURATOR_OPS_RECORDS`
- total key count
- approximate category counts for deployments, scheduled work, reachability, journeys, deployment integrity, performance, self-test, operational state, incident correlation, history, devices, security, diagnostics, and other state
- namespace identity
- export timestamp
- SHA-256 integrity metadata

The downloaded filename is:

`curator-ops-recovery-<timestamp>.json`

## Validation

```bash
node scripts/validate-recovery-backup.mjs /path/to/curator-ops-recovery-....json
```

Validation checks format, schema version, duplicate keys, key-count agreement, and SHA-256 integrity.

## iPad / iPhone backup

Use Shortcuts:

1. Get Contents of URL
2. URL: `https://ops.oceanlinercurator.com/api/recovery-export`
3. Method: GET
4. Header: `X-Curator-Recovery-Key` = the configured recovery token
5. Save File

Keep the resulting JSON outside GitHub and outside Cloudflare.

## Restore policy

There is intentionally no production restore endpoint.

Any restoration must first target an explicitly named disposable KV namespace and verify the complete restored keyset before production is considered.
