#!/bin/bash
set -eu

# Initialize the S3 deployment state files for blue-green indexer deployments.
# Run this once per environment before using the deploy-indexer-bluegreen workflow.
#
# Prerequisites:
#   - AWS CLI configured with access to the terraform state bucket
#   - Frontend staking-dashboard Terraform already applied
#   - Both red and green indexer deployments exist
#
# Usage:
#   ./scripts/init-deployment-state.sh <environment> <live_color>
#
# Examples:
#   ./scripts/init-deployment-state.sh testnet red
#   ./scripts/init-deployment-state.sh prod red

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/logging.sh"

ENVIRONMENT=${1:-""}
LIVE_COLOR=${2:-""}
STATE_BUCKET="aztec-token-sale-terraform-state"

if [ -z "$ENVIRONMENT" ] || [ -z "$LIVE_COLOR" ]; then
  echo "Usage: $0 <environment> <live_color>"
  echo ""
  echo "  environment: testnet or prod"
  echo "  live_color:  red or green (which color is currently serving traffic)"
  echo ""
  echo "Examples:"
  echo "  $0 testnet red"
  echo "  $0 prod red"
  exit 1
fi

if [ "$ENVIRONMENT" != "testnet" ] && [ "$ENVIRONMENT" != "prod" ]; then
  echo "Error: Environment must be 'testnet' or 'prod'"
  exit 1
fi

if [ "$LIVE_COLOR" != "red" ] && [ "$LIVE_COLOR" != "green" ]; then
  echo "Error: Live color must be 'red' or 'green'"
  exit 1
fi

log_step "Initializing deployment state for $ENVIRONMENT (live: $LIVE_COLOR)"

# Get CloudFront domain names from indexer terraform states
log_step "Reading red indexer CloudFront domain from terraform state..."
RED_STATE_KEY="${ENVIRONMENT}/backends/atp-indexer/terraform.tfstate"
RED_CF_DOMAIN=$(aws s3 cp "s3://${STATE_BUCKET}/${RED_STATE_KEY}" - | \
  jq -r '.outputs.cf_domain_name.value // empty')

if [ -z "$RED_CF_DOMAIN" ]; then
  echo "Error: Could not read red indexer CloudFront domain from state"
  echo "Make sure the red indexer has been deployed for $ENVIRONMENT"
  exit 1
fi
echo "  Red CF domain: $RED_CF_DOMAIN"

log_step "Reading green indexer CloudFront domain from terraform state..."
GREEN_STATE_KEY="${ENVIRONMENT}-green/backends/atp-indexer/terraform.tfstate"
GREEN_CF_DOMAIN=$(aws s3 cp "s3://${STATE_BUCKET}/${GREEN_STATE_KEY}" - | \
  jq -r '.outputs.cf_domain_name.value // empty')

if [ -z "$GREEN_CF_DOMAIN" ]; then
  echo "Error: Could not read green indexer CloudFront domain from state"
  echo "Make sure the green indexer has been deployed for $ENVIRONMENT"
  exit 1
fi
echo "  Green CF domain: $GREEN_CF_DOMAIN"

# Get frontend CloudFront distribution ID
log_step "Reading frontend CloudFront distribution ID from terraform state..."
FRONTEND_STATE_KEY="${ENVIRONMENT}-aztec-staking-dashboard/terraform.tfstate"
FRONTEND_DIST_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${FRONTEND_STATE_KEY}" - | \
  jq -r '.outputs.staking_dashboard_distribution_id.value // empty')

if [ -z "$FRONTEND_DIST_ID" ]; then
  echo "Error: Could not read frontend distribution ID from state."
  echo "Make sure the staking-dashboard Terraform has been applied for $ENVIRONMENT"
  exit 1
fi
echo "  Frontend distribution ID: $FRONTEND_DIST_ID"

# Create state file
STATE_FILE="/tmp/deploy-state-${ENVIRONMENT}.json"
cat > "$STATE_FILE" << EOF
{
  "live_color": "$LIVE_COLOR",
  "frontend_distribution_id": "$FRONTEND_DIST_ID",
  "colors": {
    "red": { "cf_domain": "$RED_CF_DOMAIN" },
    "green": { "cf_domain": "$GREEN_CF_DOMAIN" }
  },
  "pending_switchover": null
}
EOF

echo ""
log_step "State file contents:"
cat "$STATE_FILE"
echo ""

# Upload to S3
STATE_KEY="deployment-state/${ENVIRONMENT}.json"
log_step "Uploading to s3://${STATE_BUCKET}/${STATE_KEY}..."
aws s3 cp "$STATE_FILE" "s3://${STATE_BUCKET}/${STATE_KEY}" --content-type "application/json"

log_success "Deployment state initialized for $ENVIRONMENT (live: $LIVE_COLOR)"
echo ""
echo "You can now use the 'Deploy Indexer (Blue-Green)' workflow in GitHub Actions."
