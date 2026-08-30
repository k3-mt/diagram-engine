# ecs.tf — the Fargate cluster, one task definition per binary, and the five
# long-running services.
#
# There is deliberately NO load balancer in this system. ingest-gateway and
# fleet-api terminate TLS in-process on a public task IP (see the comment in
# cmd/ingest-gateway/main.go) and Route 53 points at them; adding an ALB was
# rejected in ADR-004 because the device protocol needs the client certificate
# at the application layer.
#
# The environment blocks below carry only what a process must be TOLD. An
# address a Go package already knows (Cloud Map names, see discovery.tf) does
# not appear here, so this file is not a complete statement of who calls whom.

resource "aws_ecs_cluster" "fleet" {
  name = "${local.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(local.services)
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

locals {
  fleetdb_dsn = "postgres://fleet@${aws_db_instance.fleetdb.endpoint}/fleetdb?sslmode=require"

  # Per-service environment. Anything absent here is either not used by that
  # binary or is resolved by the binary itself.
  service_env = {
    ingest-gateway = {
      LISTEN_ADDR         = ":8443"
      RAW_FRAME_BUCKET    = aws_s3_bucket.raw_frames.id
      VEHICLE_STATE_TABLE = aws_dynamodb_table.vehicle_state.name
      TELEMETRY_STREAM    = aws_kinesis_stream.telemetry_frames.name
    }

    trip-builder = {
      FLEETDB_DSN               = local.fleetdb_dsn
      TELEMETRY_STREAM          = aws_kinesis_stream.telemetry_frames.name
      TELEMETRY_STREAM_CONSUMER = aws_kinesis_stream_consumer.trip_builder.arn
    }

    geofence-eval = {
      FLEETDB_DSN               = local.fleetdb_dsn
      TELEMETRY_STREAM          = aws_kinesis_stream.telemetry_frames.name
      TELEMETRY_STREAM_CONSUMER = aws_kinesis_stream_consumer.geofence_eval.arn
    }

    fleet-api = {
      LISTEN_ADDR         = ":8443"
      FLEETDB_DSN         = local.fleetdb_dsn
      VEHICLE_STATE_TABLE = aws_dynamodb_table.vehicle_state.name
    }

    dispatch = {
      LISTEN_ADDR      = ":9090"
      FLEETDB_DSN      = local.fleetdb_dsn
      ROUTING_BASE_URL = var.routing_base_url
    }

    maintenance-forecast = {
      FLEETDB_DSN = local.fleetdb_dsn
    }
  }

  service_cpu = {
    ingest-gateway       = 1024
    trip-builder         = 1024
    geofence-eval        = 2048
    fleet-api            = 512
    dispatch             = 512
    maintenance-forecast = 2048
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each                 = toset(local.services)
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.service_cpu[each.key]
  memory                   = local.service_cpu[each.key] * 2
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.service[each.key].repository_url}:latest"
      essential = true

      environment = [
        for k, v in local.service_env[each.key] : { name = k, value = tostring(v) }
      ]

      secrets = each.key == "dispatch" ? [
        { name = "ROUTING_API_KEY", valueFrom = aws_secretsmanager_secret.routing_api_key.arn }
      ] : []

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])
}

resource "aws_ecs_service" "long_running" {
  for_each        = toset(local.long_running)
  name            = each.key
  cluster         = aws_ecs_cluster.fleet.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = each.key == "geofence-eval" ? 4 : 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets = contains(["ingest-gateway", "fleet-api"], each.key) ? aws_subnet.public[*].id : aws_subnet.private[*].id

    security_groups = contains(["ingest-gateway", "fleet-api"], each.key) ? [aws_security_group.edge.id, aws_security_group.internal.id] : [aws_security_group.internal.id]

    assign_public_ip = contains(["ingest-gateway", "fleet-api"], each.key)
  }

  # Only dispatch registers a discoverable name; the other four are never
  # dialled by another service.
  dynamic "service_registries" {
    for_each = each.key == "dispatch" ? [1] : []

    content {
      registry_arn = aws_service_discovery_service.dispatch.arn
    }
  }
}

resource "aws_secretsmanager_secret" "routing_api_key" {
  name = "${local.name}/routing-api-key"
}
