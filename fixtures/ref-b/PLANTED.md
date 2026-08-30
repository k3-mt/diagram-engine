# Planted items — reference system B

**What this file is:** the answer key for the two deliberate traps in
`fixtures/ref-b/`, the held-out reference system for the M8 eval rig
(BUILD.md P3-03, spec Part 10 M8).

**Who may read it:** the gold-file author (P3-04) and the scorer. It is never
shown to the agent under test, and the agent's prompt must not point at it.

B exists so that rules tuned against system A are scored against something they
were not tuned on. A is a docker-compose JavaScript checkout system; B is a Go
monorepo whose only infrastructure statement is `terraform/`. Neither the
vocabulary nor the topology overlaps, so an agent that pattern-matched its way
through A has to actually read here.

The two plants are the same *kind* of trap as A's — a code-only coupling and a
component that does not exist — but not the same instances, so an agent cannot
carry an answer across.

---

## Plant 1 — a coupling that exists only in Go source

**What it is.** `maintenance-forecast` calls `dispatch` over gRPC. When the
nightly forecast finds a critical diagnostic trouble code on a vehicle, it
calls `HoldVehicle` to take that vehicle out of the assignable pool
immediately, rather than waiting for a human to read the forecast.

**Why it is invisible everywhere else.**

* `terraform/ecs.tf` gives the `maintenance-forecast` task exactly one
  environment variable, `FLEETDB_DSN` (`terraform/ecs.tf`, the
  `maintenance-forecast` block inside `local.service_env`). There is no
  dispatch address to configure, because the address is a compile-time
  constant.
* `terraform/iam.tf` gives that task no policy at all beyond the assume-role:
  a gRPC call inside the VPC needs no AWS permission, so IAM says nothing.
* `terraform/network.tf` puts every task in one shared `internal` security
  group with a `self = true` rule on 9090, so the security groups do not
  identify the calling pair either. The comment at
  `terraform/network.tf` above `aws_security_group.internal` says so outright.
* `terraform/schedules.tf` shows only that the task runs nightly.

**The exact lines that reveal it.**

| file:line | what it shows |
|---|---|
| `internal/maintenance/forecast.go:14` | `import ".../internal/dispatchclient"` — the import is the whole proof |
| `internal/maintenance/forecast.go:67` | `f.disp.HoldVehicle(ctx, h.VehicleID, code+" "+reason)` — the call itself |
| `cmd/maintenance-forecast/main.go:14` | the binary pulls in `dispatchclient` |
| `cmd/maintenance-forecast/main.go:48` | `dispatchclient.Dial(ctx)` — the connection is opened at start-up |
| `internal/dispatchclient/client.go:19` | `const DefaultAddr = "dispatch.fleet.internal:9090"` — where the address lives instead of the environment |
| `internal/dispatchclient/client.go:60` | `HoldVehicle`, the RPC being called |

**What a correct diagram does.** Draws one edge
`maintenance-forecast -> dispatch`, solid (a synchronous gRPC call), labelled
something like `grpc` or `holds vehicle`. Direction is caller to callee:
**from `maintenance-forecast`, to `dispatch`**. An edge pointing the other way
is wrong, and is scored as a direction failure, not a missing edge.

A binding or citation on that edge should name
`internal/maintenance/forecast.go`, not any Terraform file. An agent that
"found" this in Terraform is hallucinating a citation, which is a rule 9
failure even though the edge is right.

**Second caller, for contrast.** `fleet-api` also imports `dispatchclient`
(`internal/fleetapi/handlers.go:14`, and calls `CreateJob` at
`internal/fleetapi/handlers.go:141`) — that one *is* discoverable
from the console-facing REST surface and from `deploy/proto.md`. The plant is
specifically the `maintenance-forecast -> dispatch` edge: an agent that draws
the `fleet-api` edge and misses the forecast edge has failed this plant.

---

## Plant 2 — a component that looks real and does not exist

**What it is.** The "position cache": a Redis/ElastiCache instance that the
console map is supposedly served from. It does not exist. No Terraform
resource declares it, no binary imports the client, and no process ever opens a
connection to it.

**The trace that tempts an agent.**

| file:line | the temptation |
|---|---|
| `internal/platform/cache/redis.go:7` | a complete, plausible `package cache` — Redis client, key prefix, TTL, `SetPosition`/`GetPosition`. It compiles and it reads like production code |
| `terraform/variables.tf:38` | `variable "position_cache_endpoint"` with a real description referencing FLEET-812 |
| `internal/fleetapi/handlers.go:68` | `// TODO(FLEET-812): read through internal/platform/cache instead of hitting DynamoDB` — sitting directly above the handler that serves positions |
| `deploy/README.md:23-25` | a runbook entry telling an operator to set `position_cache_endpoint` and restart `fleet-api` |

**What makes it false, and where that is written.**

* The variable is declared and never referenced: `grep -rn
  "position_cache_endpoint" terraform/` matches only `variables.tf:38`. No
  `aws_elasticache_*` resource exists anywhere in `terraform/`.
* No binary imports the package: `grep -rn "platform/cache" cmd/ internal/`
  matches only the file itself and the TODO comment in `handlers.go`.
* `deploy/README.md:26-30` carries a dated correction saying the note is stale,
  the subnet group was never approved, and setting the variable does nothing.
* `internal/fleetapi/handlers.go:69-70` says the handler "is the only reader of
  vehicle-state" — the DynamoDB read is the live path.

**What a correct diagram does.** Nothing. No `position-cache` node, no `cache`
node of any name, and no edge from `fleet-api` to one. `fleet-api` reads live
positions from the `vehicle-state` DynamoDB table and that is the only edge on
that path.

Scoring note: a `cache`-type node in the produced document is a false positive
against the gold node set **and** should be reported separately as an invention
failure (rules 8 and 9), because it is the specific failure this plant exists
to catch. Its presence is a fail for B even if every other node is right.

---

## Notes for the gold-file author (not plants — ambiguity to settle once)

These are honest features of the system, written down here so the gold file
resolves them deliberately rather than by accident.

1. **There is no load balancer.** `ingest-gateway` and `fleet-api` terminate
   TLS in-process on public task IPs; the choice and its reason are stated at
   `terraform/ecs.tf` (header comment, ADR-004) and
   `cmd/ingest-gateway/main.go` (comment above the `http.Server`). An agent
   that draws an ALB, NLB, API gateway or CDN has invented infrastructure —
   the same failure class as A's fake load balancer, arrived at without a
   plant. Do not add one to the gold file.

2. **`internal/platform/sqsx` speaks Kinesis, not SQS.** The package name is a
   documented leftover from a migration
   (`internal/platform/sqsx/stream.go:4-7`). The single queue in this system is
   the Kinesis data stream `telemetry-frames`
   (`terraform/stream.tf`). The gold file should carry one `queue` node for
   that stream and no SQS node.

3. **Two consumers on one stream is correct, not a mistake.** `trip-builder`
   and `geofence-eval` each hold their own enhanced-fan-out registration
   (`terraform/stream.tf`, `aws_kinesis_stream_consumer.trip_builder` and
   `.geofence_eval`), so both receive every record. Both consumer edges belong
   in the gold file, both dashed.

4. **The console is not in this repository.** `northwind-fleet/console` is a
   separate React app (`deploy/README.md`, "Who talks to what"). It is still a
   real `client` node — it is named, and `fleet-api` exists to serve it — but
   an agent cannot cite a file for it beyond that README line.

5. **The archive is write-only from inside this system.** `ingest-gateway`
   writes to S3 and nothing here reads it back
   (`internal/platform/s3x/archive.go`, package comment; `terraform/data.tf`,
   comment above `aws_s3_bucket.raw_frames`). One edge, gateway to storage.
