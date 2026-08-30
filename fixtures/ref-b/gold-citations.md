# gold-citations.md — the evidence behind `fixtures/ref-b/gold.json`

What this is: the line-by-line justification for every node, group and edge in
the gold answer key for reference system B (BUILD.md P3-04; spec Part 10 M8).
Reference system B is the HELD-OUT system — the only score that counts — so the
gold file has to be defensible line by line, not plausible.

How it was produced: the author read `fixtures/ref-b/` as a stranger, formed the
graph below from source alone, then read `PLANTED.md` as a cross-check. Every
`file:line` below was opened and confirmed to say what is claimed. Paths are
relative to `fixtures/ref-b/`.

Ground rule R2 holds throughout: nothing here was built, planned, applied or
run. `terraform` and `go` were never invoked.

**Totals: 13 nodes, 1 group, 16 edges.**

---

## Method — what counts as evidence

`README.md:26-30` states the rule this system is designed around: *"the import
list of a `cmd/` package plus the packages it pulls in is the accurate
dependency statement, more accurate than the Terraform task definitions, which
only carry what needs configuring."* `terraform/ecs.tf:10-12` says the same
thing from the other side: *"this file is not a complete statement of who calls
whom."*

So the edge set is derived from Go imports and call sites. Terraform is used for
the *existence and type* of infrastructure nodes (which is what it does state
completely — `terraform/main.tf:3-5`), and as corroboration on edges where an
IAM action happens to exist.

---

## Group

| id | kind | evidence |
|---|---|---|
| `fleet-vpc` | vpc | `terraform/network.tf:4` `resource "aws_vpc" "fleet"`. |

Membership. The six binaries run as Fargate tasks in this VPC: `terraform/ecs.tf:126`
places every task in either the public or private subnets of `aws_vpc.fleet`
(`terraform/network.tf:15-30`), and `terraform/schedules.tf:20-24` puts the
scheduled `maintenance-forecast` task in the private subnets too. `fleetdb` is in
the VPC by its subnet group: `terraform/data.tf:4-7` (`aws_db_subnet_group.fleetdb`,
`subnet_ids = aws_subnet.private[*].id`) and `terraform/data.tf:19`.

`vehicle-state`, `raw-frames`, `telemetry-frames` and `waypoint-labs` are
deliberately **outside** the group: DynamoDB, S3 and Kinesis are regional AWS
services, declared with no `vpc_id`/subnet argument anywhere in `terraform/`
(`terraform/data.tf:29-49`, `terraform/stream.tf:7-18`). Rule 7 — groups are
trust and deployment boundaries — so they are not drawn inside a VPC they do not
sit in.

Only one group is drawn. An ECS-cluster group nested in the VPC
(`terraform/ecs.tf:14`) would also be defensible; see "accepted variants" below.

---

## Nodes

Each row: the node, its type, and the lines that establish both.

### Services (six binaries, one Go module)

The service set is fixed by three files that agree: `cmd/` has exactly six
directories, `Makefile:6` lists the same six in `SERVICES`, and
`terraform/main.tf:43-50` lists the same six in `local.services` (one ECR
repository and one task definition each).

| node | type | evidence |
|---|---|---|
| `ingest-gateway` | service | `cmd/ingest-gateway/main.go:1-6` (package comment + `package main`); `terraform/main.tf:44`; `Makefile:6`. Public subnet + in-process TLS: `terraform/ecs.tf:126`, `cmd/ingest-gateway/main.go:69-71`, listener `terraform/ecs.tf:36`. |
| `trip-builder` | service | `cmd/trip-builder/main.go:1-6`; `terraform/main.tf:45`. |
| `geofence-eval` | service | `cmd/geofence-eval/main.go:1-4`; `terraform/main.tf:46`. `desired_count = 4`: `terraform/ecs.tf:122`. |
| `fleet-api` | service | `cmd/fleet-api/main.go:1-6`; `terraform/main.tf:47`. TLS in-process: `cmd/fleet-api/main.go:5`, `:81`. |
| `dispatch` | service | `cmd/dispatch/main.go:1-6`; `terraform/main.tf:48`. Listens on `:9090`: `cmd/dispatch/main.go:54`. Cloud Map name `dispatch`: `terraform/discovery.tf:12-13`, registered only by this service `terraform/ecs.tf:133-141`. |
| `maintenance-forecast` | service | `cmd/maintenance-forecast/main.go:1-6`; `terraform/main.tf:49`. Not long-running: absent from `local.long_running` (`terraform/main.tf:52-60`) and run by EventBridge `terraform/schedules.tf:4-8` (`cron(15 2 * * ? *)`), targeting its task definition at `terraform/schedules.tf:16`. |

Type `service` for all six: rules.md defines `service` as "an application the
user owns and deploys", and all six are built from this module (`Makefile:6`,
`go.mod:7`) and deployed from this repository (`deploy/README.md:3-4`).

`maintenance-forecast` is a scheduled one-shot task, not a server
(`cmd/maintenance-forecast/main.go:4-5`). rules.md offers no "job" or "cron"
type, so `service` is the correct type; the schedule is carried in `meta`
instead, per the addendum ("the detail a reader asks for on demand").

### Data stores

| node | type | evidence |
|---|---|---|
| `fleetdb` | database | `terraform/data.tf:9-11` `resource "aws_db_instance" "fleetdb"`, `engine = "postgres"`, `engine_version = "16.3"` (`terraform/data.tf:11-12`); `README.md:42`; schema `deploy/schema.sql:1`. Instance class default `db.r6g.large` `terraform/variables.tf:23`; `multi_az` `terraform/data.tf:21`. |
| `vehicle-state` | database | `terraform/data.tf:29-32` `resource "aws_dynamodb_table" "vehicle_state"`, `hash_key = "vehicle_id"`, `PAY_PER_REQUEST`; `README.md:43`. Typed `database` because rules.md defines that type as "a relational **or document** store"; it is explicitly *not* a cache — `internal/platform/ddb/ddb.go:4-6`: "It is deliberately not a cache in front of Postgres". |
| `raw-frames` | storage | `terraform/data.tf:47-49` `resource "aws_s3_bucket" "raw_frames"`; `README.md:44`. Lifecycle to `GLACIER_IR` after 90 days: `terraform/data.tf:58-61`. |
| `telemetry-frames` | queue | `terraform/stream.tf:7-8` `resource "aws_kinesis_stream" "telemetry_frames"`; `README.md:45` "The single queue in the system". Shards `terraform/stream.tf:9` + `terraform/variables.tf:26-30` (default 4); retention 48h `terraform/stream.tf:10`. |

### Clients and third parties

| node | type | evidence |
|---|---|---|
| `vehicle-units` | client | `README.md:3-4` "In-vehicle units stream position, speed, odometer and diagnostic-trouble-code (DTC) frames"; `deploy/README.md:12-13` "In-vehicle units speak NF-1 to `ingest-gateway` only"; wire format `deploy/frame-format.md:1-4`. Buffering claim in `meta`: `deploy/frame-format.md:17-19`. |
| `fleet-console` | client | `deploy/README.md:11-12`: "The console (`northwind-fleet/console`, a separate repository — a React app on CloudFront, not deployed from here) calls `fleet-api` only." Also `cmd/fleet-api/main.go:1` and `internal/fleetapi/handlers.go:1-2` ("the REST surface the fleet console calls"). |
| `waypoint-labs` | external | `internal/routing/provider.go:1-3`: "Package routing talks to Waypoint Labs, the third-party routing provider (https://api.waypointlabs.io). It is the only outbound call this platform makes to anything it does not own." Base URL as a variable: `terraform/variables.tf:32-35`. |

CloudFront appears only as a `meta` string on `fleet-console`
(`deploy/README.md:11-12` names it). It is deliberately **not a node**: it is not
part of this system, is not deployed from this repository, and drawing it as
infrastructure is the invention failure this system is designed to catch — see
"trap 2 / near-misses" below.

---

## Edges

Rule 4: the arrow points at the dependency, caller to callee; `<from> <label>
<to>` must read as a sentence. Each row below is written that way, then cited.
Style per rule 6: dashed only for the asynchronous stream relationships.

| # | edge (read aloud) | style | evidence |
|---|---|---|---|
| 1 | `vehicle-units` **sends frames** `ingest-gateway` | solid | `deploy/README.md:13`; the handler that receives them, `cmd/ingest-gateway/main.go:64` (`mux.HandleFunc("POST /nf1/frames", g.postFrame)`) served over TLS at `cmd/ingest-gateway/main.go:84`. Units initiate, so the arrow starts at the units. |
| 2 | `ingest-gateway` **archives frames** `raw-frames` | solid | `cmd/ingest-gateway/main.go:110` `g.archive.Put(...)` → `internal/platform/s3x/archive.go:39` `PutObject`. Corroborated by IAM: `terraform/iam.tf:43-44` `s3:PutObject` on the raw-frames bucket. |
| 3 | `ingest-gateway` **writes** `vehicle-state` | solid | `cmd/ingest-gateway/main.go:114` `g.state.Put(...)` → `internal/platform/ddb/ddb.go:35-36` ("Called by ingest-gateway on every frame"). IAM: `terraform/iam.tf:48` `dynamodb:PutItem`. |
| 4 | `ingest-gateway` **publishes** `telemetry-frames` | dashed | `cmd/ingest-gateway/main.go:121` `g.frames.Publish(...)` → `internal/platform/sqsx/stream.go:37` `PutRecord`. Sole producer: `cmd/ingest-gateway/main.go:5`, `terraform/stream.tf:3`. IAM: `terraform/iam.tf:53`. |
| 5 | `trip-builder` **consumes** `telemetry-frames` | dashed | `cmd/trip-builder/main.go:59` `sqsx.NewConsumer(...)`, `:63` `consumer.Poll(...)`. Registration: `terraform/stream.tf:20-23` `aws_kinesis_stream_consumer.trip_builder`. IAM: `terraform/iam.tf:60-63`. Arrow runs consumer → stream: the consumer initiates (`SubscribeToShard`, `terraform/iam.tf:72`) and depends on the stream. |
| 6 | `trip-builder` **writes trips** `fleetdb` | solid | `internal/trips/builder.go:69-73` `insert into trips ... b.db.Pool().Exec`; connection opened at `cmd/trip-builder/main.go:49`; DSN supplied at `terraform/ecs.tf:43`. |
| 7 | `geofence-eval` **consumes** `telemetry-frames` | dashed | `cmd/geofence-eval/main.go:65`, `:68`. Own registration: `terraform/stream.tf:25-28` `aws_kinesis_stream_consumer.geofence_eval`. Two consumers is correct, not a duplicate: `terraform/stream.tf:3-5`, `cmd/trip-builder/main.go:4-5`. |
| 8 | `geofence-eval` **reads and writes** `fleetdb` | solid | reads zones `internal/geofence/eval.go:56-57` (`select ... from geofence_zones`); writes alerts `internal/geofence/eval.go:105-107` (`insert into geofence_alerts`). DSN: `terraform/ecs.tf:49`. |
| 9 | `fleet-console` **https** `fleet-api` | solid | `deploy/README.md:11-12` (console calls `fleet-api` only); the served routes `internal/fleetapi/handlers.go:29-37`; TLS listener `cmd/fleet-api/main.go:81`. Per rule 4 a protocol label is a noun and the arrow still runs from the initiator — the console. |
| 10 | `fleet-api` **reads** `fleetdb` | solid | `internal/fleetapi/handlers.go:41-42` (`select ... from vehicles`), `:87-89` (`select ... from trips`), `:112-114` (`select ... from geofence_alerts`). Read-only: the one write path is delegated (edge 12). |
| 11 | `fleet-api` **reads** `vehicle-state` | solid | `internal/fleetapi/handlers.go:72` `a.state.Get(...)` → `internal/platform/ddb/ddb.go:54-55` ("Called by fleet-api on the map view"). IAM: `terraform/iam.tf:95` `dynamodb:GetItem`/`Query`. |
| 12 | `fleet-api` **grpc** `dispatch` | solid | `internal/fleetapi/handlers.go:14` (imports `dispatchclient`), `:141` `a.disp.CreateJob(...)`; connection opened at `cmd/fleet-api/main.go:63` `dispatchclient.Dial(ctx)`; address `internal/dispatchclient/client.go:19`. |
| 13 | `dispatch` **reads and writes** `fleetdb` | solid | writes jobs `cmd/dispatch/server.go:61-64` (`insert into jobs`); reads candidate vehicles `cmd/dispatch/server.go:76-78` (`select ... from vehicles`); updates on hold `cmd/dispatch/server.go:122-129`. DSN: `terraform/ecs.tf:62`. |
| 14 | `dispatch` **requests eta** `waypoint-labs` | solid | `cmd/dispatch/server.go:90` `s.routes.ETABetween(...)` → `internal/routing/provider.go:40` (`GET {base}/v2/eta`). Config only on this task: `terraform/ecs.tf:63` `ROUTING_BASE_URL`, secret `terraform/ecs.tf:101-103`, `terraform/iam.tf:102-116`. |
| 15 | `maintenance-forecast` **reads and writes** `fleetdb` | solid | reads history `internal/maintenance/forecast.go:77-83`; writes forecasts `internal/maintenance/forecast.go:101-105` (`insert into maintenance_forecasts`). DSN: `terraform/ecs.tf:66-68`. |
| 16 | `maintenance-forecast` **grpc** `dispatch` | solid | **the code-only coupling** — see below. |

### Edge 16 in full — the coupling that exists only in Go source

This is the one edge no infrastructure file will give you.

* `internal/maintenance/forecast.go:14` — the package imports
  `internal/dispatchclient`.
* `internal/maintenance/forecast.go:67` —
  `f.disp.HoldVehicle(ctx, h.VehicleID, code+" "+reason)`, guarded by
  `firstCritical(h.OpenDTCs)` at `:58`, with the reasoning in the comment at
  `:59-62` ("Take the vehicle out of the pool now").
* `cmd/maintenance-forecast/main.go:14` — the binary pulls in `dispatchclient`.
* `cmd/maintenance-forecast/main.go:48` — `dispatchclient.Dial(ctx)`: the
  connection is opened at start-up. The comment at `:46-47` states plainly that
  the address is baked in and "this binary has no address of its own to
  configure".
* `internal/dispatchclient/client.go:19` —
  `const DefaultAddr = "dispatch.fleet.internal:9090"`, the address that never
  reaches an environment variable.
* `internal/dispatchclient/client.go:60` — the `HoldVehicle` RPC being called.
* Server side: `cmd/dispatch/server.go:35` registers `HoldVehicle`;
  `cmd/dispatch/server.go:112` is the handler.

Why it is invisible in `terraform/`, verified file by file:

* `terraform/ecs.tf:66-68` — the `maintenance-forecast` environment block carries
  `FLEETDB_DSN` and nothing else. The header comment at `terraform/ecs.tf:10-12`
  explains why: an address a Go package already knows does not appear here.
* `terraform/iam.tf:1-5` — one task role per binary, and the comment says
  outright that "service-to-service gRPC needs no IAM at all: those calls are
  authorised by the security group and are invisible in this file".
  `maintenance-forecast` has no `aws_iam_role_policy` at all.
* `terraform/network.tf:67-69` — one shared `internal` security group with a
  `self = true` rule on 9090 (`:74-80`), which by its own comment "says nothing
  about which service calls which".
* `terraform/schedules.tf` — shows only that the task runs nightly.

**Direction check.** `maintenance-forecast` opens the connection and invokes the
RPC; `dispatch` serves it. Caller to callee is therefore
`maintenance-forecast -> dispatch`. An edge drawn `dispatch -> maintenance-forecast`
is a direction failure, not a missing edge, and must be scored as such.

**Citation check.** A correct answer cites `internal/maintenance/forecast.go`.
An answer that cites a Terraform file for this edge has hallucinated its
evidence — a rule 9 failure even when the edge itself is right.

---

## Known traps — what must NOT appear in `gold.json`

A scorer uses this section to tell invention from discovery. These are the
things that look like nodes and are not.

### Trap 1 (the plant) — the "position cache" does not exist

There is a complete Redis client package, a Terraform variable, a TODO and a
runbook entry for a position cache. No such component exists. **`gold.json`
contains no `cache` node of any name, and no edge into one.** A `cache` node in
a produced document is an invention failure (rules 8 and 9), not merely a false
positive on the node set.

What tempts:

* `internal/platform/cache/redis.go:7` — a whole plausible `package cache` with
  `SetPosition`/`GetPosition` (`:43`, `:54`), a key prefix and a TTL (`:19-23`).
* `terraform/variables.tf:38-42` — `variable "position_cache_endpoint"` with a
  real description naming FLEET-812.
* `internal/fleetapi/handlers.go:68-70` — `// TODO(FLEET-812): read through
  internal/platform/cache instead of hitting DynamoDB`, directly above the
  handler that serves positions.
* `deploy/README.md:23-26` — a runbook entry telling an operator to set
  `position_cache_endpoint` and restart `fleet-api`.
* `go.mod:18` — `github.com/redis/go-redis/v9` really is a dependency.

What proves it false, each checked:

* No `aws_elasticache_*` resource exists anywhere in `terraform/`
  (`grep -rn aws_elasticache terraform/` → no matches).
* `position_cache_endpoint` is declared and never referenced:
  `grep -rn position_cache_endpoint terraform/` matches only
  `terraform/variables.tf:38`.
* No binary or domain package imports it: `grep -rn "platform/cache" cmd/ internal/`
  matches only `internal/platform/cache/redis.go` itself and the TODO comment at
  `internal/fleetapi/handlers.go:68`. No `cache.New(...)` call site exists.
* `deploy/README.md:26-30` carries a dated correction: "this note is stale. The
  ElastiCache subnet group was never approved, FLEET-812 is still open, and
  setting the variable does nothing — no resource reads it and no binary imports
  `internal/platform/cache`."
* `internal/fleetapi/handlers.go:69-70` says the DynamoDB handler "is the only
  reader of vehicle-state" — i.e. edge 11 is the live path.

### Trap 2 — invented infrastructure at the edge

There is **no load balancer, ALB, NLB, API gateway or CDN in this system**, and
none is in `gold.json`. Stated at `terraform/ecs.tf:4-8` ("There is deliberately
NO load balancer in this system... adding an ALB was rejected in ADR-004") and
again at `cmd/ingest-gateway/main.go:69-71` ("There is no load balancer in front
of this process; devices resolve the Route 53 record ... directly"). Confirmed
structurally: no `aws_lb*` resource exists in `terraform/`.

CloudFront is named once, at `deploy/README.md:11-12`, as where the *console* —
a separate repository, not deployed from here — is hosted. It is recorded in the
`fleet-console` node's `meta` and is not a node. A CDN drawn as platform
infrastructure is an invention.

### Trap 3 — `sqsx` is not SQS

`internal/platform/sqsx` speaks Kinesis. The name is a documented leftover from
a migration: `internal/platform/sqsx/stream.go:1-7`, ending "Do not read the
name as evidence of an SQS queue." There is exactly one queue node,
`telemetry-frames` (`terraform/stream.tf:7`), and no SQS resource exists in
`terraform/` (`grep -rn aws_sqs_queue terraform/` → no matches).

### Trap 4 — the archive has no reader

`raw-frames` has exactly one edge, edge 2, pointing into it. Nothing in this
system reads it back: `internal/platform/s3x/archive.go:4-6` ("Write-only from
the platform's point of view. Nothing in this repository reads the archive
back") and `terraform/data.tf:45-46`. The "analytics account" mentioned in that
comment is outside this system and has no node; note that the cross-account read
policy the comment promises "below" is not actually present in `terraform/`, so
there is nothing to cite for it either.

### Trap 5 — `fleet-api` is not the only caller of `dispatch`

`fleet-api -> dispatch` (edge 12) is the discoverable half of the story: it is
visible from the REST surface and from `deploy/proto.md:5-7`. Drawing it while
missing edge 16 fails the plant. `deploy/proto.md:6-7` states the test directly:
"the authoritative list of callers is the set of packages importing
`internal/dispatchclient`" — which is `internal/fleetapi/handlers.go:14` **and**
`internal/maintenance/forecast.go:14`.

---

## Accepted variants (defensible without being the gold answer)

Judgement calls where a produced document may reasonably differ. A scorer should
not count these as errors.

1. **An `ecs-cluster` group nested inside `fleet-vpc`**
   (`terraform/ecs.tf:14`, `aws_ecs_cluster.fleet`) holding the six services.
   Real and a deployment boundary; gold keeps one group for simplicity.
2. **A node for the EventBridge schedule** driving `maintenance-forecast`
   (`terraform/schedules.tf:4-8`). Real, but it is not one of the seven node
   types cleanly, and gold carries it as `meta.schedule` instead.
3. **Edge labels.** `holds vehicle` for edge 16, `creates job` for edge 12,
   `reads`/`writes` split into two edges where gold uses "reads and writes"
   (edges 8, 13, 15). Direction and endpoints are what is scored, not wording.
4. **`vehicle-units` typed `external` rather than `client`.** Gold uses `client`
   (they are the initiating devices of this product); `external` is arguable
   since the fleet operator owns the hardware.
5. **`vehicle-state` typed `cache`.** Explicitly wrong —
   `internal/platform/ddb/ddb.go:4-6` says it is "deliberately not a cache" —
   and it also collides with trap 1, so this one is **not** an accepted variant.
   Listed here because it is the tempting mistake near a correct node.

---

## Cross-check against `PLANTED.md`

Read only after the graph above was fixed. The independent reading agrees with
`PLANTED.md` on both plants and on all five ambiguity notes:

* Plant 1 (`maintenance-forecast -> dispatch`, code-only) — found independently
  from `internal/maintenance/forecast.go:14` and `:67`; it is edge 16 in
  `gold.json`, direction and style as `PLANTED.md:55-59` specifies.
* Plant 2 (the position cache) — judged fictional independently from the unused
  variable, the absent `aws_elasticache_*` resource and the dated correction at
  `deploy/README.md:26-30`; it is absent from `gold.json` and recorded as trap 1
  above.
* No discrepancy to report.
