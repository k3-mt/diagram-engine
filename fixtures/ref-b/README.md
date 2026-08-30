# Northwind Fleet — telemetry platform

A vehicle telematics backend. In-vehicle units stream position, speed, odometer
and diagnostic-trouble-code (DTC) frames; the platform turns those frames into
trips, geofence alerts, dispatch assignments and maintenance forecasts, and
serves the whole lot to the fleet console.

One Go module, six binaries, one stream. Infrastructure is Terraform only —
there is no compose file and nothing here runs locally as a stack.

## Binaries (`cmd/`)

| binary | what it does |
|---|---|
| `ingest-gateway` | terminates device TLS, decodes telemetry frames, archives the raw frame, updates the vehicle's latest state, publishes a decoded event |
| `trip-builder` | consumes decoded events, stitches them into trips, writes trips to Postgres |
| `geofence-eval` | consumes the same events, evaluates zone rules, writes alerts to Postgres |
| `fleet-api` | REST API for the fleet console: vehicles, trips, alerts, job creation |
| `dispatch` | gRPC service that assigns jobs to vehicles; asks the routing provider for ETAs |
| `maintenance-forecast` | nightly job: reads odometer and DTC history, forecasts service due dates |

## Shared packages (`internal/`)

`platform/` holds the thin AWS and Postgres wrappers. Domain packages
(`telemetry`, `trips`, `geofence`, `fleetapi`, `maintenance`, `routing`,
`dispatchclient`) hold the logic. A binary is a `main` that wires one domain
package to the platform clients it needs — so **the import list of a `cmd/`
package plus the packages it pulls in is the accurate dependency statement**,
more accurate than the Terraform task definitions, which only carry what needs
configuring.

## Wiring

Service-to-service calls resolve through AWS Cloud Map under the private DNS
namespace `fleet.internal` (`terraform/discovery.tf`). There is no load
balancer: `ingest-gateway` and `fleet-api` terminate TLS in-process on public
task IPs, with Route 53 records pointing at the Cloud Map namespace. See the
comment at the top of `terraform/ecs.tf`.

## Data

* `fleetdb` — RDS Postgres. Vehicles, drivers, trips, zones, alerts, jobs.
* `vehicle-state` — DynamoDB. One item per vehicle: last position, last frame time.
* `raw-frames` — S3. Every decoded frame, gzipped, partitioned by day.
* `telemetry-frames` — Kinesis Data Stream. The single queue in the system.
  Decoded frames fan out to two registered consumers, `trip-builder` and
  `geofence-eval`, over enhanced fan-out (`terraform/stream.tf`).
