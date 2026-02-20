# Deployment

This repo contains two deployable components:

1. **Staking Dashboard** (`staking-dashboard/`) — React frontend served from S3 via CloudFront
2. **ATP Indexer** (`atp-indexer/`) — Ponder blockchain indexer running on ECS Fargate

Both are deployed per-environment (`dev`, `staging`, `testnet`, `prod`). The indexer has two instances per environment — **red** and **green** — to enable zero-downtime deployments.

## Architecture

```
                   stake.aztec.network
                          │
                   ┌──────┴──────┐
                   │  CloudFront │
                   │ Distribution│
                   └──┬───────┬──┘
                      │       │
              /static │       │ /api/*
                      │       │
               ┌──────┴──┐  ┌─┴─────────────┐
               │ S3      │  │ indexerOrigin │ ← points to live color
               │ Bucket  │  │ (CF domain)   │
               └─────────┘  └──────┬────────┘
                                   │
                      ┌────────────┴────────────┐
                      │                         │
               ┌──────┴──────┐          ┌───────┴─────┐
               │  Red CF     │          │  Green CF   │
               └──────┬──────┘          └──────┬──────┘
               ┌──────┴──────┐          ┌──────┴──────┐
               │  Red ALB    │          │  Green ALB  │
               └──────┬──────┘          └──────┴──────┘
                      │                        │
                 Red ECS                  Green ECS
              (indexer+server)         (indexer+server)
```

The frontend CloudFront distribution has two origins:
- **S3** for static assets (default behavior)
- **indexerOrigin** for `/api/*` requests, pointing to whichever indexer color is live

This means the frontend always uses its own domain for API calls (`/api/*`). Indexer switchovers only update the CloudFront origin — no frontend redeploy needed.

## Environments

| Environment | Chain    | AWS Cluster | Domain                          | Branch restriction |
|-------------|----------|-------------|---------------------------------|--------------------|
| `dev`       | Mainnet  | dev         | —                               | None (any PR)      |
| `staging`   | Mainnet  | dev         | —                               | None               |
| `testnet`   | Sepolia  | dev         | `testnet.stake.aztec.network`   | None               |
| `prod`      | Mainnet  | prod        | `stake.aztec.network`           | `main` only        |

Each environment requires a matching [GitHub environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) with the relevant secrets and variables (AWS credentials, RPC URL, contract addresses, etc.).

To allow deploying `dev` from any PR branch, set its GitHub environment's **Deployment branches** to "All branches".

## Deploying the Frontend

**Workflow:** `Deploy Staking Dashboard` (`deploy-staking-dashboard.yaml`)

Trigger manually from the Actions tab or push a tag:
```
v1.0.0-testnet-dashboard
v1.0.0-prod-dashboard
```

This builds the React app, uploads to S3, and invalidates the CloudFront cache. No interaction with red/green — the frontend is a single static deployment.

## Deploying the Indexer (Blue-Green)

The indexer uses a two-phase blue-green deployment. When indexer code changes, the new version re-indexes from scratch (~30 minutes). Rather than having a GitHub Actions runner sit idle waiting, the deploy exits immediately and a cron job handles the switchover.

### Phase 1: Deploy to Backup

**Workflow:** `Deploy Indexer (Blue-Green)` (`deploy-indexer-bluegreen.yaml`)

1. Reads deployment state from S3 to determine which color is **live** and which is **backup**
2. Deploys the indexer to the backup (Terraform + Docker + ECS)
3. Writes a `pending_switchover` to the S3 state file
4. Exits (~5–10 min total)

Trigger manually from the Actions tab:
- **environment**: `dev` / `staging` / `testnet` / `prod`
- **dry_run**: Plan only, don't apply
- **force**: Override an existing pending switchover

### Phase 2: Automatic Switchover

**Workflow:** `Check Indexer Sync & Switchover` (`check-indexer-sync.yaml`)

Runs on a cron every 30 minutes. For each environment with a `pending_switchover`:

1. Hits `GET /api/sync-status` on the backup's CloudFront domain
2. If not synced yet → exits, retries next cron run
3. If synced → performs the switchover:
   - Updates the frontend CloudFront's `indexerOrigin` to point to the new live color (via AWS CLI)
   - Invalidates `/api/*` cache
   - Updates the S3 deployment state (`live_color` = new color, `pending_switchover` = null)
   - Triggers `Deploy ATP Indexer` for the old live (so both colors end up on the latest code)
4. If timed out (>2 hours) → clears the pending switchover and logs an error

Can also be triggered manually to check a specific environment immediately.

### Sync Status Endpoint

`GET /api/sync-status` returns:

```json
{
  "synced": true,
  "indexedBlock": 21345678,
  "chainHead": 21345680,
  "behindBlocks": 2,
  "hasData": true,
  "timestamp": "2024-02-19T12:00:00Z"
}
```

The indexer is considered synced when `behindBlocks < 50` and `hasData` is true (at least one provider exists in the database).

### Deploying to a Single Color (Manual)

**Workflow:** `Deploy ATP Indexer` (`deploy-indexer.yaml`)

Deploys to a specific color without blue-green orchestration. Used by the cron to update the old live, or for manual overrides:
- Set **green** = true to deploy the green instance, false for red

Can also be triggered via tags:
```
v1.0.0-testnet-indexer
v1.0.0-testnet-indexer-green
v1.0.0-prod-indexer
v1.0.0-prod-indexer-green
```

## S3 Deployment State

Path: `s3://aztec-token-sale-terraform-state/deployment-state/{env}.json`

```json
{
  "live_color": "red",
  "frontend_distribution_id": "E1234567890",
  "colors": {
    "red":   { "cf_domain": "d10cun7h2qqnvc.cloudfront.net" },
    "green": { "cf_domain": "dgk9duhuxabbq.cloudfront.net" }
  },
  "pending_switchover": null
}
```

When a switchover is pending:
```json
{
  "pending_switchover": {
    "target_color": "green",
    "started_at": "2024-02-19T12:00:00Z",
    "commit_sha": "abc123"
  }
}
```

## Initial Setup

Before using the blue-green workflow for an environment, run the init script once:

```bash
./scripts/init-deployment-state.sh <environment> <live_color>
```

This reads the CloudFront domains from Terraform state and creates the S3 deployment state file. Prerequisites:
- AWS CLI configured with access to the state bucket
- Both red and green indexer Terraform applied
- Frontend staking-dashboard Terraform applied

## Terraform

The frontend CloudFront distribution's `indexerOrigin` is managed with `lifecycle { ignore_changes = [origin] }` so that Terraform doesn't revert origin changes made by the blue-green cron via AWS CLI.

SPA routing is handled by a CloudFront Function (`spa_routing`) on the default behavior's viewer-request event instead of a 404 `custom_error_response`, because `custom_error_response` is distribution-wide and would intercept API 404s.

## Troubleshooting

**Switchover stuck / timed out:** The cron clears pending switchovers after 2 hours. Check the backup's `/api/sync-status` endpoint directly. If the indexer is erroring, check ECS logs.

**Switchover never triggers:** Verify the S3 state file has a `pending_switchover` set. The cron only runs every 30 minutes — trigger `Check Indexer Sync & Switchover` manually for faster feedback.

**Wrong color is live:** Manually run `Deploy ATP Indexer` targeting the correct color, then update the S3 state file's `live_color` field directly.

**Terraform wants to revert the origin:** The `lifecycle { ignore_changes = [origin] }` block should prevent this. If it's happening, check that the block is still present in `staking-dashboard/terraform/main.tf`.
