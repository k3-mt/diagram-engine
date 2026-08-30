# gold-citations — reference system A

**What this is:** the evidence behind every node and every edge in
`fixtures/ref-a/gold.json`. Implements BUILD.md P3-04; the answer key that
acceptance G11–G13 (BUILD.md Part 5) score an eval run against.

Written by reading `fixtures/ref-a/` as source only. The system was never
started (BUILD.md Part 1, R2) — no `docker compose up`, no container, no port.
Every claim below is a line someone can open.

Paths are relative to `fixtures/ref-a/`. Line numbers are against the files as
committed; if a source file moves, re-run the greps in the last section and
correct the numbers here, because a stale citation silently breaks the score.

`gold.json` validates: `diagram import < gold.json && diagram check` →
`ok — 8 nodes, 0 groups, 12 edges`.

---

## Nodes — 8

Eight containers, one node each. The count is stated in `README.md:9` ("Eight
containers, defined in `docker-compose.yml`") and confirmed by the service
blocks themselves.

| id | type | why that type | citation |
|----|------|---------------|----------|
| `web` | `client` | React bundle, the browser app the customer uses | `docker-compose.yml:12` (`web:`), `README.md:13`, `web/package.json:12–14` (react, react-dom, react-router-dom) |
| `api-gateway` | `service` | Node app we build and deploy | `docker-compose.yml:26` (`api-gateway:`), `api-gateway/src/server.js:1–2` |
| `auth` | `service` | Node app we build and deploy | `docker-compose.yml:47` (`auth:`), `auth/src/server.js:1` |
| `orders` | `service` | Node app we build and deploy | `docker-compose.yml:62` (`orders:`), `orders/src/server.js:1` |
| `fulfilment-worker` | `service` | Node app we build and deploy | `docker-compose.yml:78` (`fulfilment-worker:`), `fulfilment-worker/src/index.js:1` |
| `postgres` | `database` | relational store | `docker-compose.yml:94–95` (`postgres:` / `image: postgres:16-alpine`), `README.md:18` |
| `redis` | `cache` | key/value cache and counter store | `docker-compose.yml:107–108` (`redis:` / `image: redis:7-alpine`), `README.md:19` |
| `kafka` | `queue` | one topic, `order.events.v1` | `docker-compose.yml:115–116` (`kafka:` / `image: bitnami/kafka:3.7`), `README.md:20` |

### Accepted ambiguity: `web` as `client` vs `service`

`web` is a container we build and deploy (`docker-compose.yml:13`,
`web/Dockerfile`), which fits rules.md's `service` ("an application the user
owns and deploys"). It is also a React browser app, which fits `client`
("browser app, mobile app, cli"). Gold picks `client` because the artefact the
customer runs is the bundle in the browser and `README.md:6` puts `web` at the
left of the topology as the entry point.

**A scorer must accept `service` for this node as equally correct.** It is a
genuine two-way call in the source, not a mistake, and penalising it would
measure taste rather than truth.

### Accepted ambiguity: a browser / public-internet node

Gold does not add a separate node for the browser or the public internet. Only
the eight compose services are drawn. An agent that adds a `client` node in
front of `web` has not invented infrastructure — `PLANTED.md:132–133` says the
same — and a scorer should treat it as neither a hit nor a miss.

---

## Groups — 0, deliberately

`docker-compose.yml:132–137` defines two networks, `edge` and `internal`, and
`internal` is `internal: true` (line 137) — a real trust boundary, restated in
`docker-compose.yml:3–4` and `ops/README.md:8–10`.

Gold still contains no groups, because **the true structure is not expressible
in this schema**. `api-gateway` is on both networks at once
(`docker-compose.yml:43–45`), and `GNode.parent` in
`packages/core/src/schema/graph.ts` holds one group id, not a set. Any grouping
would therefore have to misstate the topology.

Which network each service sits on is recorded instead as a `network` meta key
on the node, which is a claim about an existing node rather than an invented
boundary.

**Scorer note.** An agent that adds one `internal` group (kind `vpc` or
`generic`) holding `auth`, `orders`, `fulfilment-worker`, `postgres`, `redis`
and `kafka`, leaving `web` and `api-gateway` outside, has read
`docker-compose.yml:132–137` correctly. Do not score that as an invention.
Grouping things by topic instead of by network would violate rules.md rule 7
and should be scored.

---

## Edges — 12

Direction follows rules.md rule 4: **the arrow points at the dependency, caller
to callee**, and `<from> <label> <to>` reads as a sentence. Each row below
states that sentence so a reviewer can check the direction without opening the
JSON. Style follows rule 6: dashed for asynchronous, solid for synchronous.

### 1. `web` → `api-gateway` — "proxies /api", solid
Reads: *web proxies /api api-gateway.* nginx in the web image forwards `/api/`
to the gateway; the browser never learns an internal hostname.
- `web/nginx.conf:22–23` — `location /api/ { proxy_pass http://api-gateway:8080/;`
- `web/nginx.conf:1–2` — "the only dynamic path is /api, which is proxied to the gateway"
- `web/src/api.js:5` — `const BASE = '/api';` — every call in the bundle goes there
- `docker-compose.yml:18` — `API_BASE_URL: http://api-gateway:8080`
- `docker-compose.yml:21–22` — `depends_on: - api-gateway`

### 2. `api-gateway` → `auth` — "proxies", solid
Reads: *api-gateway proxies auth.* Two distinct calls, one edge:
- **proxy** `api-gateway/src/routes/auth.js:8–9` — `createProxyMiddleware({ target: config.authUrl,`, mounted at `api-gateway/src/server.js:25` (`app.use('/auth', authProxy)`)
- **introspect** `api-gateway/src/routes/orders.js:12` — `await fetch(`${config.authUrl}/introspect`, {`, mounted at `api-gateway/src/server.js:26`; answered by `auth/src/server.js:68` (`app.post('/introspect', ...)`)
- URL source: `api-gateway/src/config.js:15` (`authUrl: required('AUTH_URL')`), set at `docker-compose.yml:31` (`AUTH_URL: http://auth:3001`)

Gold emits **one** edge per ordered pair. An agent that splits this into two
edges (`proxies` and `introspects`) has found the same coupling, not an extra
one; score the pair once.

### 3. `api-gateway` → `orders` — "proxies", solid
Reads: *api-gateway proxies orders.*
- `api-gateway/src/routes/orders.js:24–25` — `createProxyMiddleware({ target: config.ordersUrl,`
- `api-gateway/src/server.js:26` — `app.use('/orders', requireSession, ordersProxy);`
- `api-gateway/src/config.js:16` — `ordersUrl: required('ORDERS_URL')`; `docker-compose.yml:32` — `ORDERS_URL: http://orders:3002`
- Receiving side: `orders/src/server.js:18` reads the `x-sparrow-user` header the gateway sets at `api-gateway/src/routes/orders.js:29`

### 4. `api-gateway` → `redis` — "rate limit counters", solid
Reads: *api-gateway rate limit counters redis* — a noun label; rule 4 keeps the
arrow on the initiator, which is the gateway.
- `api-gateway/src/ratelimit.js:8` — `const redis = new Redis(config.redisUrl);`
- `api-gateway/src/ratelimit.js:20–21` — `await redis.incr(key)` / `await redis.expire(key, 90)`
- `api-gateway/src/config.js:19` — `redisUrl: required('REDIS_URL')`; `docker-compose.yml:33` — `REDIS_URL: redis://redis:6379/0`

### 5. `auth` → `postgres` — "reads users", solid
Reads: *auth reads users postgres.*
- `auth/src/db.js:7–8` — `new pg.Pool({ connectionString: process.env.DATABASE_URL`
- `auth/src/db.js:14–16` — `select id, email, password_hash, disabled_at from users`
- `auth/src/db.js:28` — `select client_id, secret_hash, scopes from service_accounts`
- `auth/src/db.js:35` — `update users set last_login_at = now()` (auth writes too; label kept short per rule 5)
- Tables: `auth/migrations/001_auth.sql:3` (`users`), `:15` (`service_accounts`)
- `docker-compose.yml:52` — `DATABASE_URL: postgres://sparrow:sparrow@postgres:5432/sparrow`

### 6. `auth` → `redis` — "stores sessions", solid
Reads: *auth stores sessions redis.*
- `auth/src/tokens.js:9` — `const redis = new Redis(process.env.REDIS_URL);`
- `auth/src/tokens.js:15` — `await redis.setex(`session:${sid}`, ttl, userId);`
- `auth/src/tokens.js:21` — `await redis.get(`session:${sid}`)`
- `docker-compose.yml:53` — `REDIS_URL: redis://redis:6379/1`

### 7. `orders` → `postgres` — "reads and writes", solid
Reads: *orders reads and writes postgres.*
- `orders/src/db.js:7–8` — the pool
- `orders/src/db.js:13–19` — `select ... from orders where user_id = $1`
- `orders/src/db.js:44–48` — `insert into orders (...)`; `:52` — `insert into order_lines (...)`
- Tables: `orders/migrations/001_orders.sql:5` (`orders`), `:18` (`order_lines`), `:29` (`fulfilments`)
- `docker-compose.yml:67` — `DATABASE_URL: ...@postgres:5432/sparrow`

### 8. `orders` → `redis` — "caches list", solid
Reads: *orders caches list redis.*
- `orders/src/cache.js:7` — `const redis = new Redis(process.env.REDIS_URL);`
- `orders/src/cache.js:13` / `:18` / `:22` — `get` / `setex` / `del` on `orders:list:<user>`
- Call sites: `orders/src/server.js:32` (`readList`), `:36` (`writeList`), `:59` (`bust`)
- `docker-compose.yml:68` — `REDIS_URL: redis://redis:6379/2`

### 9. `orders` → `kafka` — "publishes", **dashed**
Reads: *orders publishes kafka.* Asynchronous, so dashed per rules.md rule 6.
- `orders/src/events.js:13` — `const producer = kafka.producer({ allowAutoTopicCreation: false });`
- `orders/src/events.js:27–28` — `await producer.send({ topic,`
- `orders/src/events.js:14` — `const topic = process.env.ORDER_EVENTS_TOPIC || 'order.events.v1';`
- `orders/src/server.js:60` — `await publishOrderPlaced(...)`
- `docker-compose.yml:69–70` — `KAFKA_BROKERS: kafka:9092` / `ORDER_EVENTS_TOPIC: order.events.v1`

### 10. `fulfilment-worker` → `kafka` — "consumes", **dashed**
Reads: *fulfilment-worker consumes kafka.* **Direction trap.** The messages
travel kafka → worker, but the worker is the caller: it connects and
subscribes. Rule 4 puts the arrow on the dependency, so it points at kafka.
`kafka → fulfilment-worker` is a direction failure, not a missing edge.
- `fulfilment-worker/src/consumer.js:13–16` — `kafka.consumer({ groupId: ... })`
- `fulfilment-worker/src/consumer.js:35–36` — `await consumer.connect();` / `await consumer.subscribe({ topic, ...})`
- `docker-compose.yml:83–85` — `KAFKA_BROKERS` / `ORDER_EVENTS_TOPIC` / `CONSUMER_GROUP`
- `ops/README.md:49–51` — "Orders publishes it, the fulfilment worker consumes it"

Note that `README.md:7` draws this leg as `orders -> kafka -> fulfilment-worker`,
which is message flow, not dependency direction. An agent that copies the README
arrow gets this edge backwards. That is the point of the row.

### 11. `fulfilment-worker` → `postgres` — "writes fulfilments", solid
Reads: *fulfilment-worker writes fulfilments postgres.*
- `fulfilment-worker/src/db.js:7–10` — the pool
- `fulfilment-worker/src/db.js:14–17` — `insert into fulfilments (order_id, warehouse, picked_at)`
- `fulfilment-worker/src/db.js:25` — `update orders set status = 'picking'`
- `docker-compose.yml:82` — `DATABASE_URL: ...@postgres:5432/sparrow`

### 12. `fulfilment-worker` → `auth` — "verifies tokens", solid — **the hidden edge**
Reads: *fulfilment-worker verifies tokens auth.* Synchronous HTTP, so solid.

This edge appears in **no manifest**. It exists only in the worker's source,
where the auth hostname is a hardcoded constant rather than configuration:
- `fulfilment-worker/src/auth-client.js:6` — `const AUTH_BASE = 'http://auth:3001';` — the only place the coupling exists
- `fulfilment-worker/src/auth-client.js:15` — `await fetch(`${AUTH_BASE}/token`, {` — mints the worker's own service token
- `fulfilment-worker/src/auth-client.js:33` — `await fetch(`${AUTH_BASE}/verify`, {` — validates a caller's bearer token
- `fulfilment-worker/src/index.js:37` — `await serviceToken();` at boot, before the consumer starts, so the worker will not start without auth
- `fulfilment-worker/src/index.js:20` — `await validateToken(bearer, 'fulfilment:replay');` on every `/admin/replay` call
- Answered by `auth/src/server.js:76` (`app.post('/token', ...)`) and `auth/src/server.js:90` (`app.post('/verify', ...)`)

Where it is **not** visible, which is what makes it the test:
- `docker-compose.yml:88–90` — the worker's `depends_on` lists `kafka` and `postgres` only
- `docker-compose.yml:81–87` — the worker's `environment` has no `AUTH_URL`, hostname or port
- `fulfilment-worker/package.json:11–15` — no HTTP client; the calls use the Node global `fetch`
- `README.md:6–7` — the topology sketch does not draw it

`docker-compose.yml:86–87` (`SERVICE_ACCOUNT_ID`, `SERVICE_ACCOUNT_SECRET`) is a
near miss, not a reveal: it names no host and no service. A citation pointing at
`docker-compose.yml` is a guess, and rule 9 forbids guessing — score it as a
miss. Score the edge as found only when the citation resolves to
`fulfilment-worker/src/auth-client.js` or `fulfilment-worker/src/index.js`.

---

## Known trap — the load balancer that must NOT appear

The system is written as if it sits behind an edge load balancer. **It does
not, and no node for one may appear in a correct diagram.** A node whose id or
label carries *lb*, *load balancer*, *ingress*, *edge tier*, *edge-lb*, *proxy*,
*reverse proxy*, *CDN*, *TLS terminator*, *nginx*, *traefik*, *envoy*, *alb* or
*elb* is an **invention** and fails, however it is justified.

The bait, all of which an agent will find:
- `ops/README.md:24–25` — a hostname, `edge-lb.sparrow.internal`. The strongest lure: it reads exactly like a component id waiting to be created.
- `docker-compose.yml:6–7` — "the `edge` network sits behind the platform team's shared TLS terminator"
- `docker-compose.yml:34–35` — "Requests arrive with X-Forwarded-For already set by the edge tier", then `TRUST_PROXY_HEADER: "X-Forwarded-For"`
- `api-gateway/src/config.js:22–25` — the same header read as real configuration
- `api-gateway/src/server.js:20–21` — "The edge tier polls this ... get us pulled out of rotation": a health check plus a rotation, the two words that most imply a balancer
- `web/nginx.conf:4–6` — "this container sits behind the platform edge tier"

The disproof, in the same files:
- `ops/README.md:26–28` — "That box is not in this repository, it is not in this compose file, and we do not deploy it — we file a ticket against the platform team when a route changes."
- `docker-compose.yml:11–130` defines eight services and not one of them is a proxy, balancer, ingress or terminator.
- The only nginx in the stack is inside the `web` image and serves the static bundle (`web/nginx.conf:27–30`); `web/nginx.conf:4` says TLS is deliberately not terminated there.

**The legitimate way to record it** is a `note` or `meta` entry on an existing
node — gold carries `note_edge: "behind the platform edge tier, not deployed
here"` on `api-gateway`. That is a claim about a node that exists, not a new
component, and it does not count as an invention.

---

## Couplings that are real but are deliberately NOT edges

Recorded so a scorer knows they were considered and rejected on evidence, not
missed.

- **`fulfilment-worker` writes tables owned by `orders`.** `fulfilment-worker/src/db.js:1–3` says so outright, and `fulfilments` and `orders` are defined in `orders/migrations/001_orders.sql:29` and `:5`. This is a real coupling, but it runs through the shared database and is already carried by edges 7 and 11. There is no call from the worker to the orders service: `orders/src/server.js:2–3` — "It never calls another service." A direct `fulfilment-worker → orders` edge would assert an HTTP dependency that does not exist. **Do not score its absence as a miss; do not score its presence as an invention either** — it is defensible as a dashed "shares tables" edge, so treat it as neutral.
- **`orders.user_id` points at auth's `users` table.** `orders/migrations/001_orders.sql:1–3` — "by value only; there is deliberately no foreign key across service boundaries". No constraint exists to draw, and no service call either. Not an edge.
- **`postgres` mounts both services' migration directories.** `docker-compose.yml:102–103`. That is first-boot seeding (`ops/README.md:42–43`), not a runtime dependency between containers.
- **Compose `depends_on` for `web` → `api-gateway`, `api-gateway` → `auth`/`orders`/`redis`.** These agree with the code and are already covered by edges 1–4. `fulfilment-worker`'s `depends_on` (`docker-compose.yml:88–90`) is *incomplete* — see edge 12.

---

## Greps that regenerate every line number here

    cd fixtures/ref-a
    grep -n "^  [a-z-]*:" docker-compose.yml          # the eight service blocks
    grep -rn "AUTH_BASE" fulfilment-worker/           # the hidden edge
    grep -rn "new Redis\|new pg.Pool" .               # every cache and database edge
    grep -rn "kafka.producer\|kafka.consumer" .       # both queue edges
    grep -rn "createProxyMiddleware\|proxy_pass" .    # every proxy edge
    grep -niE "load.?balanc|ingress|edge-lb" .        # the trap: comments and one README only
