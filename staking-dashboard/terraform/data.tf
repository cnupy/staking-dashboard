# Red indexer (deployment suffix "")
data "terraform_remote_state" "atp-indexer-red" {
  backend = "s3"
  config = {
    bucket = "aztec-token-sale-terraform-state"
    key    = "${var.env}/backends/atp-indexer/terraform.tfstate"
    region = "eu-west-2"
  }
}

# Green indexer (deployment suffix "-green")
data "terraform_remote_state" "atp-indexer-green" {
  backend = "s3"
  config = {
    bucket = "aztec-token-sale-terraform-state"
    key    = "${var.env}-green/backends/atp-indexer/terraform.tfstate"
    region = "eu-west-2"
  }
}

# Reference the shared backend infrastructure state for CloudFront logs bucket
data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "aztec-token-sale-terraform-state"
    key    = "${var.env_parent}/backends/ignition-infrastructure/terraform.tfstate"
    region = "eu-west-2"
  }
}

# Local references to backend service URLs
locals {
  # Both indexer CF domains — green may not exist yet for new environments
  red_indexer_cf_domain   = data.terraform_remote_state.atp-indexer-red.outputs.cf_domain_name
  green_indexer_cf_domain = try(data.terraform_remote_state.atp-indexer-green.outputs.cf_domain_name, "")
  has_green_indexer       = local.green_indexer_cf_domain != ""

  cloudfront_logs_bucket = try(data.terraform_remote_state.shared.outputs.cloudfront_logs_bucket_domain_name, "")
}

output "atp_indexer_url" {
  value = "https://${local.red_indexer_cf_domain}"
}
