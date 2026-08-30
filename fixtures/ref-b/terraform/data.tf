# data.tf — the stateful resources: fleetdb (Postgres), vehicle-state
# (DynamoDB), raw-frames (S3), telemetry-frames (Kinesis).

resource "aws_db_subnet_group" "fleetdb" {
  name       = "${local.name}-fleetdb"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "fleetdb" {
  identifier              = "${local.name}-fleetdb"
  engine                  = "postgres"
  engine_version          = "16.3"
  instance_class          = var.db_instance_class
  allocated_storage       = 200
  max_allocated_storage   = 1000
  db_name                 = "fleetdb"
  username                = "fleet"
  manage_master_user_password = true
  db_subnet_group_name    = aws_db_subnet_group.fleetdb.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  multi_az                = true
  backup_retention_period = 14
  storage_encrypted       = true
  skip_final_snapshot     = false
  final_snapshot_identifier = "${local.name}-fleetdb-final"
}

# One item per vehicle: last position, speed, odometer, frame time.
resource "aws_dynamodb_table" "vehicle_state" {
  name         = "${local.name}-vehicle-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "vehicle_id"

  attribute {
    name = "vehicle_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Raw NF-1 frames, gzipped, partitioned by day. Written by ingest-gateway.
# Nothing in this system reads it back; the analytics account queries it
# through the cross-account read policy below.
resource "aws_s3_bucket" "raw_frames" {
  bucket = "${local.name}-raw-frames"
}

resource "aws_s3_bucket_lifecycle_configuration" "raw_frames" {
  bucket = aws_s3_bucket.raw_frames.id

  rule {
    id     = "glacier-after-90d"
    status = "Enabled"

    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
  }
}
