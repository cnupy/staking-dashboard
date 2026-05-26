resource "random_password" "db" {
  length           = 20
  special          = true
  override_special = "_-"
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  effective_db_password      = var.db_password != "" ? var.db_password : random_password.db.result
  postgres_connection_string = "postgres://${var.db_username}:${local.effective_db_password}@${aws_rds_cluster.atp_indexer.endpoint}:5432/postgres?sslmode=no-verify"

  # Multi-AZ setup: distribute instances across availability zones
  instance_count = 1 + var.db_read_replica_count
  az_count       = length(data.aws_availability_zones.available.names)
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.full_name}-atp-db-subnets"
  subnet_ids = [local.private_subnet_1_id, local.private_subnet_2_id, local.private_subnet_3_id]

  tags = merge(local.common_tags, {
    Name = "${local.full_name}-atp-db-subnets"
    Type = "networking"
  })
}

resource "aws_security_group" "atp_db" {
  name_prefix = "${local.full_name}-atp-db-sg"
  description = "RDS PostgreSQL security group - ingress only"
  vpc_id      = local.vpc_id

  tags = merge(local.common_tags, {
    Name = "${local.full_name}-atp-db-sg"
    Type = "security"
  })
}

# Allow ATP indexer → RDS
resource "aws_security_group_rule" "ecs_indexer_to_rds" {
  description              = "Allow indexer service to connect to RDS"
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.atp_db.id
  source_security_group_id = aws_security_group.atp_indexer.id
}

resource "aws_security_group_rule" "ecs_server_to_rds" {
  description              = "Allow server to connect to RDS"
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.atp_db.id
  source_security_group_id = aws_security_group.atp_server.id
}

resource "aws_ssm_parameter" "db_password" {
  name        = var.db_password_ssm_name
  description = "ATP indexer DB password"
  type        = "SecureString"
  value       = local.effective_db_password

  lifecycle {
    prevent_destroy = true
  }
}

# Secrets Manager mirror of the DB password. Used by Aurora Data API
# when (if) it's enabled on the cluster — Data API doesn't read SSM, it
# requires Secrets Manager. We keep the SSM param above untouched (the
# ECS task definitions still read from SSM) and write a parallel entry
# here from the same `effective_db_password`. Both stay in sync because
# Terraform writes both from the same local.
#
# Currently the cluster's instance class (db.t4g.medium) doesn't
# support Data API — see the commented-out `enable_http_endpoint` above
# — so this secret is inert today. Kept around so it's a one-line
# Terraform change to enable Data API the moment the instance class
# crosses the supported tier.
resource "aws_secretsmanager_secret" "db_credentials" {
  name        = "${local.full_name}-db-credentials"
  description = "ATP indexer DB credentials for Aurora Data API access (ops-only)"

  tags = merge(local.common_tags, {
    Name = "${local.full_name}-db-credentials"
    Type = "secrets"
  })
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    username = var.db_username
    password = local.effective_db_password
  })
}

# Aurora PostgreSQL Cluster
# Storage: Automatically replicates 6 ways across 3 AZs
# Instances: Explicitly distributed across AZs for HA (see instances below)
resource "aws_rds_cluster" "atp_indexer" {
  cluster_identifier     = "${local.full_name}-aurora-cluster"
  engine                 = "aurora-postgresql"
  # Bumped from 16.8 → 16.11 to match the AWS auto-minor upgrade applied
  # during a maintenance window. AWS does not permit engine_version
  # downgrades, so any drift between this value and the deployed
  # version will fail to apply. Paired with `ignore_changes` below so
  # future auto-minor upgrades don't recreate the drift.
  engine_version         = "16.11"
  database_name          = "postgres"
  master_username        = var.db_username
  master_password        = local.effective_db_password
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.atp_db.id]

  # Backup configuration
  backup_retention_period      = var.db_backup_retention_days
  preferred_backup_window      = var.db_backup_window
  preferred_maintenance_window = var.db_maintenance_window

  # CloudWatch logs
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Deletion protection
  deletion_protection = true
  skip_final_snapshot = true

  # Apply changes immediately in non-prod, during maintenance window in prod
  apply_immediately = var.env != "prod"

  # Aurora Data API would be ideal for ops queries (HTTPS endpoint, no
  # VPC ingress, IAM-authenticated) — but it requires an instance class
  # of db.r6i.large / db.r6g.large or larger. We're on db.t4g.medium to
  # keep cost down, so enabling triggers
  # `InvalidParameterCombination: The instance class that you specified
  # doesn't support the HTTP endpoint for using RDS Data API`. The
  # Secrets Manager secret below stays in place so the moment the
  # instance class crosses that bar, flipping this back on is a one-line
  # change. For now, ops debug goes through a one-off SSM-managed
  # bastion EC2 in the private subnet.
  #
  # enable_http_endpoint = true

  tags = merge(local.common_tags, {
    Name = "${local.full_name}-aurora-cluster"
    Type = "database"
  })
}

# Aurora Cluster Instances
# Explicitly distributed across availability zones using round-robin allocation
# promotion_tier controls failover priority (0 = highest priority)
resource "aws_rds_cluster_instance" "instances" {
  count = local.instance_count

  identifier                            = "${local.full_name}-aurora-${count.index + 1}"
  cluster_identifier                    = aws_rds_cluster.atp_indexer.id
  instance_class                        = var.db_instance_class
  engine                                = aws_rds_cluster.atp_indexer.engine
  engine_version                        = aws_rds_cluster.atp_indexer.engine_version
  availability_zone                     = data.aws_availability_zones.available.names[count.index % local.az_count]
  publicly_accessible                   = false
  auto_minor_version_upgrade            = true
  promotion_tier                        = count.index
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  tags = merge(local.common_tags, {
    Name = "${local.full_name}-aurora-${count.index + 1}"
    Type = "database"
  })
}