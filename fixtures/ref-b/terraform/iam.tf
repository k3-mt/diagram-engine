# iam.tf — one task role per binary, scoped to the AWS data resources that
# binary actually touches.
#
# Note that service-to-service gRPC needs no IAM at all: those calls are
# authorised by the security group and are invisible in this file.

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  for_each           = toset(local.services)
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy" "ingest_gateway" {
  name = "data-access"
  role = aws_iam_role.task["ingest-gateway"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.raw_frames.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = aws_dynamodb_table.vehicle_state.arn
      },
      {
        Effect   = "Allow"
        Action   = ["kinesis:PutRecord", "kinesis:PutRecords"]
        Resource = aws_kinesis_stream.telemetry_frames.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "stream_consumers" {
  for_each = toset(["trip-builder", "geofence-eval"])
  name     = "stream-read"
  role     = aws_iam_role.task[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kinesis:DescribeStreamSummary",
          "kinesis:SubscribeToShard",
          "kinesis:GetRecords",
          "kinesis:GetShardIterator",
          "kinesis:ListShards",
        ]
        Resource = [
          aws_kinesis_stream.telemetry_frames.arn,
          "${aws_kinesis_stream.telemetry_frames.arn}/consumer/*",
        ]
      },
    ]
  })
}

resource "aws_iam_role_policy" "fleet_api" {
  name = "state-read"
  role = aws_iam_role.task["fleet-api"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.vehicle_state.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "dispatch_secrets" {
  name = "routing-key"
  role = aws_iam_role.task["dispatch"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.routing_api_key.arn
      },
    ]
  })
}

resource "aws_iam_role" "events_invoke_ecs" {
  name = "${local.name}-events-invoke-ecs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = "sts:AssumeRole"
        Principal = { Service = "events.amazonaws.com" }
      },
    ]
  })
}

resource "aws_iam_role_policy" "events_invoke_ecs" {
  name = "run-task"
  role = aws_iam_role.events_invoke_ecs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = "*"
      },
    ]
  })
}
