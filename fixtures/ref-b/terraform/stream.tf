# stream.tf — the single telemetry stream and its two registered consumers.
#
# ingest-gateway is the only producer. Each consumer below is a separate
# enhanced-fan-out registration, which is why both trip-builder and
# geofence-eval receive every record instead of competing for records.

resource "aws_kinesis_stream" "telemetry_frames" {
  name             = "${local.name}-telemetry-frames"
  shard_count      = var.stream_shards
  retention_period = 48

  stream_mode_details {
    stream_mode = "PROVISIONED"
  }

  encryption_type = "KMS"
  kms_key_id      = "alias/aws/kinesis"
}

resource "aws_kinesis_stream_consumer" "trip_builder" {
  name       = "${local.name}-trip-builder"
  stream_arn = aws_kinesis_stream.telemetry_frames.arn
}

resource "aws_kinesis_stream_consumer" "geofence_eval" {
  name       = "${local.name}-geofence-eval"
  stream_arn = aws_kinesis_stream.telemetry_frames.arn
}
