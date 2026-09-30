# gastos-nuvem

**[abiru.to/gastos-nuvem](https://abiru.to/gastos-nuvem/)**: a daily dashboard of what I spend on
Google Cloud, Cloudflare R2 and Magalu Cloud, broken down by *use* (roughly one per repo) across
[`pedalhidro/*`](https://github.com/pedalhidro) and my own [`danlessa/*`](https://github.com/danlessa) projects.

```
 GitHub Actions (daily 06:17 BRT)
   collect.py ──► BigQuery billing export (GCP, whole billing account)
              ──► Cloudflare GraphQL: R2 storage + ops  → × list price − free tier
              ──► Magalu consumption API (FOCUS, BRL)
              ──► BCB PTAX (USD→BRL)
        │
        ├─► data/raw/*.json   raw history, committed (R2 metrics only live ~90 days)
        └─► mapping.toml ─► site/data/costs.json ─► GitHub Pages
```

## Layout

| path | what |
|---|---|
| `collect.py` | collector + build, stdlib only (`python3 collect.py --help`) |
| `mapping.toml` | regex rules `provider\|project\|service\|resource` → use case → scope. Applied at build time, so edits re-classify history |
| `data/raw/` | raw daily rows per provider + PTAX rates (committed by CI) |
| `site/` | static dashboard, no build step, no dependencies (SVG by hand) |
| `.github/workflows/atualizar.yml` | cron: collect → commit `data/raw` → deploy Pages |
| `scripts/setup-ci.sh` | one-time GCP/GitHub setup (keyless, via Workload Identity Federation) |

## How costs are computed

- **GCP**: net cost (`cost + credits`, including free tier) from the resource-level billing export
  `pedal-hidrografico.billing_export.gcp_billing_export_resource_v1_015CF8_384D2A_5CE27E`.
  It covers every project on the billing account: `pedal-hidrografico`, `danlessa`, `japucoisas` and `ecotono`.
  Data starts on 2026-06-01, when the export was turned on.
- **Cloudflare R2**: Cloudflare has no daily-cost API.
  - The collector reads `r2StorageAdaptiveGroups` / `r2OperationsAdaptiveGroups` and prices them at the
    [list price](https://developers.cloudflare.com/r2/pricing/): $0.015/GB-month, $4.50/M class A, $0.36/M class B.
  - The monthly free tier (10 GB, 1M A, 10M B) comes off the month's cumulative usage, and each day gets the difference.
  - Cloudflare only keeps these metrics for ~90 days, so history before 2026-07-03 is gone.
- **Magalu**: `GET https://api.magalu.cloud/consumption/usage` (`EffectiveCost`, BRL).
- Days are UTC; the last day is always partial. BRL↔USD conversion uses the daily PTAX sell rate.

## Running locally

```bash
python3 collect.py                      # default window (1st of previous month → today) + build
python3 collect.py --since 2026-06-01   # backfill
python3 collect.py --build-only         # re-apply mapping.toml only
cd site && python3 -m http.server 8000  # → http://localhost:8000
```

Credentials locally: `gcloud auth print-access-token`, the `wrangler login` OAuth token (or
`CLOUDFLARE_API_TOKEN`), `MGC_API_KEY`. A provider without credentials is skipped and keeps its history.

## One-time setup

1. `scripts/setup-ci.sh`. This creates the `gh-gastos-nuvem` service account (read access to the billing
   export table + `bigquery.jobUser`), sets up the OIDC provider for this repo in the existing `github` pool,
   sets the repo variables and enables Pages (workflow build).
2. **Cloudflare**: create an API token at <https://dash.cloudflare.com/profile/api-tokens> →
   *Custom token* → permission **Account · Account Analytics · Read** (for the account) →
   `gh secret set CLOUDFLARE_API_TOKEN --repo danlessa/gastos-nuvem`.
3. **Magalu**: in the ID Magalu console create an API key with the application
   **tally-consumption-api** → `gh secret set MGC_API_KEY --repo danlessa/gastos-nuvem`.
4. `gh workflow run atualizar --repo danlessa/gastos-nuvem`.

## New resources

Anything that matches no rule lands in *não mapeado* (scope *Outros*), and `collect.py` prints a
warning. Add a rule to `mapping.toml`. The first matching rule wins.

> Note: the repo is public and Pages is public, so the numbers (and resource names) are too.
