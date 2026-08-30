# Deploying the telemetry platform

`make build` produces six binaries; CI builds one image per binary, pushes to
the ECR repositories in `terraform/ecr.tf`, and applies `terraform/`.

Five of the six run as ECS services. `maintenance-forecast` is not a service:
EventBridge starts it once a night and it exits (`terraform/schedules.tf`).

## Who talks to what

The console (`northwind-fleet/console`, a separate repository — a React app on
CloudFront, not deployed from here) calls `fleet-api` only. In-vehicle units
speak NF-1 to `ingest-gateway` only. Everything else is internal.

Internal names resolve through Cloud Map (`fleet.internal`). If you are trying
to work out which service calls which, the environment blocks in
`terraform/ecs.tf` will not tell you: a Cloud Map name compiled into a Go
client needs no configuration, so it appears in neither the task definition nor
IAM. Read the imports in `cmd/` and `internal/` instead.

## Runbook notes

* **Console map is slow.** *(2024-11-02)* The map view issues one DynamoDB read
  per visible vehicle. The position cache from FLEET-812 is meant to absorb
  this; set `position_cache_endpoint` for the environment and restart
  `fleet-api`. **Update *(2025-03-18)*: this note is stale. The ElastiCache
  subnet group was never approved, FLEET-812 is still open, and setting the
  variable does nothing — no resource reads it and no binary imports
  `internal/platform/cache`. The real mitigation is the 30s client-side poll
  interval shipped in console 4.2.**
* **Stream lag on one shard.** A poison frame cannot stall a shard —
  `trip-builder` logs and skips undecodable records — so lag on one shard means
  a hot vehicle. Raise `stream_shards`.
* **Vehicle stuck unassignable.** Something called `HoldVehicle`. Check the
  `hold_reason` column in `vehicles`; a DTC code there means an automated
  caller took it out of the pool. Grep the source for `HoldVehicle` to see who.
