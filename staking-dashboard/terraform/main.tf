locals {
  create_dns_record = true
}
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Environment = var.env
    }
  }
}

# Cloudfront certs & WAF require us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Environment = var.env
    }
  }
}

locals {
  bucket_name = "${var.env}-aztec-staking-dashboard"
}


resource "aws_s3_bucket" "staking_dashboard_bucket" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_ownership_controls" "ownership" {
  bucket = aws_s3_bucket.staking_dashboard_bucket.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "public_access" {
  bucket                  = aws_s3_bucket.staking_dashboard_bucket.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "bucket_policy" {
  bucket = aws_s3_bucket.staking_dashboard_bucket.id
  policy = data.aws_iam_policy_document.s3_policy.json
}

data "aws_iam_policy_document" "s3_policy" {
  statement {
    sid     = "AllowCloudFrontOAC"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.staking_dashboard_bucket.arn}/*"
    ]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.staking_dashboard_distribution.arn]
    }
  }

  statement {
    sid     = "AllowCloudFrontAccess"
    effect  = "Allow"
    actions = ["s3:ListBucket"]
    resources = [
      "${aws_s3_bucket.staking_dashboard_bucket.arn}"
    ]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.staking_dashboard_distribution.arn]
    }
  }

  statement {
    sid     = "AllowAccountOwnerAccess"
    effect  = "Allow"
    actions = ["s3:*"]
    resources = [
      "${aws_s3_bucket.staking_dashboard_bucket.arn}",
      "${aws_s3_bucket.staking_dashboard_bucket.arn}/*"
    ]
    principals {
      type        = "AWS"
      identifiers = [data.aws_caller_identity.current.account_id]
    }
  }
}

data "aws_caller_identity" "current" {}


resource "aws_cloudfront_origin_access_control" "oac-staking-dashboard" {
  name                              = "${var.env}-aztec-staking-dashboard-oac"
  description                       = "OAC for ${var.env} staking dashboard"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Security headers policy
resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "${var.env}-staking-dashboard-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000  # 2 years
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      content_security_policy = "frame-ancestors 'self' https://app.safe.global"
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=()"
      override = true
    }
  }
}

# CloudFront function for basic auth
resource "aws_cloudfront_function" "basic_auth_staking_dashboard" {
  name    = "${var.env}-aztec-staking-dashboard-cf-basic-auth"
  runtime = "cloudfront-js-1.0"
  comment = "Basic Auth for internal testing"

  code = templatefile("${path.module}/basic-auth-function.js.tpl", {
    basic_auth_user = var.basic_auth_user
    basic_auth_pass = var.basic_auth_pass
  })
}

# CloudFront function for SPA routing — rewrites non-file URIs to /index.html.
# This replaces the 404 custom_error_response so that API 404s pass through correctly
# (custom_error_response is distribution-wide and would swallow API errors).
resource "aws_cloudfront_function" "spa_routing" {
  name    = "${var.env}-aztec-staking-dashboard-spa-routing"
  runtime = "cloudfront-js-2.0"
  comment = "SPA routing: rewrite non-file paths to /index.html"

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      // If the URI has a file extension (e.g. .js, .css, .png), serve it as-is.
      // Otherwise rewrite to /index.html for SPA client-side routing.
      if (!uri.includes('.')) {
        request.uri = '/index.html';
      }

      return request;
    }
  EOF
}

# CORS response headers policy for the /api/* behavior
resource "aws_cloudfront_response_headers_policy" "api_cors" {
  name = "${var.env}-staking-dashboard-api-cors"

  cors_config {
    access_control_allow_credentials = false

    access_control_allow_headers {
      items = ["Content-Type", "Origin", "Accept", "X-Requested-With"]
    }

    access_control_allow_methods {
      items = ["GET", "OPTIONS", "HEAD"]
    }

    access_control_allow_origins {
      items = ["*"]
    }

    access_control_expose_headers {
      items = ["Content-Type"]
    }

    access_control_max_age_sec = 86400
    origin_override            = true
  }
}

resource "aws_cloudfront_distribution" "staking_dashboard_distribution" {
  comment             = "Staking Dashboard (${var.env}) — frontend + /api/* proxy to indexer"
  enabled             = true
  default_root_object = "index.html"
  web_acl_id          = module.website_waf.web_acl_arn

  # Use custom domain with certificate
  aliases = var.env == "prod" ? ["stake.aztec.network"] : ["${var.env}.stake.aztec.network"]

  # Origin 1: S3 bucket for static frontend assets
  origin {
    domain_name              = aws_s3_bucket.staking_dashboard_bucket.bucket_regional_domain_name
    origin_id                = "stakingDashboardS3Origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac-staking-dashboard.id
  }

  # Origin 2: Live indexer CloudFront (proxied for /api/* requests).
  # The blue-green cron workflow updates this origin's domain via AWS CLI
  # when switching between red/green indexers.
  origin {
    domain_name = local.atp_indexer_cf_domain
    origin_id   = "indexerOrigin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # /api/* requests → indexer origin
  ordered_cache_behavior {
    path_pattern     = "/api/*"
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD", "OPTIONS"]
    target_origin_id = "indexerOrigin"

    viewer_protocol_policy = "redirect-to-https"

    # CachingDisabled — the per-color indexer CloudFront handles caching
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    # AllViewer — forward all headers to origin
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"

    response_headers_policy_id = aws_cloudfront_response_headers_policy.api_cors.id
  }

  # Default: S3 static frontend assets
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "stakingDashboardS3Origin"
    viewer_protocol_policy     = "redirect-to-https"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
    compress                   = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    # SPA routing: rewrite non-file paths to /index.html so client-side
    # routing works on page refresh. This replaces the old 404 custom_error_response
    # which was distribution-wide and would have swallowed API 404s.
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_routing.arn
    }
  }

  # Redirect to blocked.html for 403 errors (geo-blocking)
  custom_error_response {
    error_code            = 403
    response_code         = 403
    response_page_path    = "/blocked.html"
    error_caching_min_ttl = 0
  }

  # NOTE: The 404 custom_error_response was removed because it's distribution-wide
  # and would intercept API 404s (returning index.html instead of JSON errors).
  # SPA routing is now handled by the spa_routing CloudFront Function above.

  restrictions {
    geo_restriction {
      restriction_type = "blacklist"
      locations = var.blocked_jurisdictions
    }
  }

  viewer_certificate {
    acm_certificate_arn            = local.create_dns_record ? module.domain.certificate_arn : null
    ssl_support_method             = local.create_dns_record ? "sni-only" : null
    minimum_protocol_version       = local.create_dns_record ? "TLSv1.2_2021" : null
    cloudfront_default_certificate = local.create_dns_record ? false : true
  }

  dynamic "logging_config" {
    for_each = local.cloudfront_logs_bucket != "" ? [1] : []
    content {
      bucket          = local.cloudfront_logs_bucket
      include_cookies = false
      prefix          = "frontend/staking-dashboard/"
    }
  }

  # The indexer origin domain is updated by the blue-green cron via AWS CLI.
  # Ignore origin changes so Terraform doesn't revert the switchover.
  # The S3 origin never changes so this is safe.
  lifecycle {
    ignore_changes = [origin]
  }
}

#
# ACM Certificate + DNS (creates cert, validates, and creates A record)
#
module "domain" {
  source = "../../terraform/modules/acm-certificate"
  
  providers = {
    aws.us_east_1 = aws.us_east_1
  }
  
  domain_name               = var.env == "prod" ? "stake.aztec.network" : "${var.env}.stake.aztec.network"
  subject_alternative_names = []
  hosted_zone_name          = "aztec.network"
  
  # DNS record will be created after CloudFront distribution
  create_dns_record      = local.create_dns_record
  cloudfront_domain_name = aws_cloudfront_distribution.staking_dashboard_distribution.domain_name
  cloudfront_zone_id     = aws_cloudfront_distribution.staking_dashboard_distribution.hosted_zone_id
  
  tags = {
    Environment = var.env
    Service     = "staking-dashboard"
  }
}


output "bucket_name" {
  value = aws_s3_bucket.staking_dashboard_bucket.bucket
}

output "staking_dashboard_distribution_id" {
  value = aws_cloudfront_distribution.staking_dashboard_distribution.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.staking_dashboard_distribution.domain_name
}

output "cloudfront_zone_id" {
  description = "CloudFront distribution hosted zone ID"
  value       = aws_cloudfront_distribution.staking_dashboard_distribution.hosted_zone_id
}

