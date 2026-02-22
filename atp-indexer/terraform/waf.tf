# WAF for ATP indexer CloudFront distribution
module "indexer_waf" {
  source = "../../terraform/modules/waf"

  providers = {
    aws = aws.us_east_1
  }

  name  = "${local.full_name}-waf"
  scope = "CLOUDFRONT"

  rate_limit          = 5000
  max_request_size_kb = 8

  # Managed rule sets
  enable_managed_core_rule_set     = true
  enable_known_bad_inputs_rule_set = true
  enable_sql_injection_rule_set    = false  # Read-only API
  enable_ip_reputation_list        = true
  enable_anon_ip_rule_set          = false
  enable_bot_control_rule_set      = false  # API must be accessible to scripts, crons, and CF-to-CF proxying
  enable_xss_rule_set              = true

  # API only serves GET/HEAD/OPTIONS
  allowed_methods = ["GET", "HEAD", "OPTIONS"]

  # No geo-blocking — handled by the frontend CloudFront WAF
  enable_geo_blocking = false

  tags = merge(local.common_tags, {
    Type = "security"
  })
}
