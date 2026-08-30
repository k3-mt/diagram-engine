# outputs.tf — what the deploy pipeline and the runbooks need.

output "cluster_arn" {
  value = aws_ecs_cluster.fleet.arn
}

output "fleetdb_endpoint" {
  value     = aws_db_instance.fleetdb.endpoint
  sensitive = true
}

output "telemetry_stream_name" {
  value = aws_kinesis_stream.telemetry_frames.name
}

output "vehicle_state_table" {
  value = aws_dynamodb_table.vehicle_state.name
}

output "raw_frame_bucket" {
  value = aws_s3_bucket.raw_frames.id
}

output "internal_namespace" {
  value = aws_service_discovery_private_dns_namespace.internal.name
}
