# PLANTED — reference system A

**What this is:** the answer key for the two things deliberately planted in
`fixtures/ref-a/`. Implements BUILD.md P3-02; scored by acceptance G12 and G13
(BUILD.md Part 5). Written for the agent that scores an eval run, not for the
agent under test.

Line numbers are against the files as committed. If you edit a source file,
re-run the greps at the bottom of each section and correct the numbers here —
a stale citation in this file silently breaks the score.

---

## Plant 1 — the hidden edge: `fulfilment-worker` → `auth`

**What it is.** The fulfilment worker calls the auth service twice: once at boot
to mint its own service token (`client_credentials`), and once per request to
its `/admin/replay` endpoint to validate the caller's bearer token. It is a real
runtime dependency — the worker refuses to start if auth does not answer.

**Why it is hidden.** The auth base URL is a hardcoded constant in the worker's
source, not configuration. Every other dependency in this system announces
itself in `docker-compose.yml`; this one does not.

**The revealing line — this is the only place it exists:**

    fixtures/ref-a/fulfilment-worker/src/auth-client.js:6
      const AUTH_BASE = 'http://auth:3001';

**The two call sites that make it a real edge:**

    fixtures/ref-a/fulfilment-worker/src/auth-client.js:15   fetch(`${AUTH_BASE}/token`)    — mint
    fixtures/ref-a/fulfilment-worker/src/auth-client.js:33   fetch(`${AUTH_BASE}/verify`)   — validate

**Where it is called from, which is what makes it live rather than dead code:**

    fixtures/ref-a/fulfilment-worker/src/index.js:20   await validateToken(bearer, 'fulfilment:replay')
    fixtures/ref-a/fulfilment-worker/src/index.js:37   await serviceToken()   — at boot, before the consumer starts

**Where it is deliberately absent.** An agent that reads only these will not
find it:

- `docker-compose.yml:78–92` — the `fulfilment-worker` block. `depends_on` lists
  `kafka` and `postgres` only (lines 88–90). There is no `auth` entry.
- `docker-compose.yml:81–87` — the worker's `environment`. There is no
  `AUTH_URL`, no auth hostname, no auth port. Compare `api-gateway`, whose call
  to auth *is* declared, at `docker-compose.yml:31` (`AUTH_URL: http://auth:3001`).
- `fulfilment-worker/package.json` — no dependency names or implies auth. The
  calls use the Node 20 global `fetch`, so there is not even an HTTP client in
  the manifest to raise an eyebrow.
- `README.md` — the topology sketch shows `web → api-gateway → auth` and
  `orders → kafka → fulfilment-worker`. The worker's call back to auth is not
  drawn.
- `ops/README.md` — describes the topic, the ports and the ingress. Silent on
  this edge.

**Near miss, not a reveal.** `docker-compose.yml:86–87` sets
`SERVICE_ACCOUNT_ID` and `SERVICE_ACCOUNT_SECRET` on the worker. These are
credentials for the call, so an agent could reason its way from them toward
"something issues service accounts". They name no service, no host and no port,
and they do not say the worker talks to auth rather than to, say, kafka SASL.
**Inferring the edge from these alone is a guess, and rule 9 forbids guessing.**
Score the edge as found only when the citation resolves to
`fulfilment-worker/src/auth-client.js` or `fulfilment-worker/src/index.js`. A
citation pointing at `docker-compose.yml` is a lucky guess, not a finding, and
scores as a miss.

**What a correct diagram does.** It contains an edge from `fulfilment-worker` to
`auth`.

- **Direction:** `from: fulfilment-worker`, `to: auth`. The worker initiates;
  rules.md rule 4 is caller-to-callee. `auth → fulfilment-worker` is wrong and
  must be scored as a direction failure, not as a missing edge.
- **Style:** `solid`. It is a synchronous HTTP request (rules.md rule 6).
- **Label:** something in the shape of "validates tokens", "verifies tokens" or
  "http". One to three words (rule 5).
- **Binding / citation:** `fulfilment-worker/src/auth-client.js`.

**Grep that proves it, and that regenerates the line numbers:**

    grep -rn "AUTH_BASE" fixtures/ref-a/fulfilment-worker/
    grep -n "auth" fixtures/ref-a/docker-compose.yml     # no hit inside the worker block

---

## Plant 2 — the plausible absence: an edge load balancer that does not exist

**What it is.** The system is written as if it sits behind a load balancer, and
that load balancer is *not part of this system*. It belongs to another team, it
is not in the compose file, it is not built here, it is not deployed here. Five
separate traces tempt an agent to draw it anyway.

**The traces — these create the temptation and are all an agent will find:**

    fixtures/ref-a/docker-compose.yml:6–7        "the `edge` network sits behind the platform team's
                                                  shared TLS terminator"
    fixtures/ref-a/docker-compose.yml:34–35      comment "already set by the edge tier", then
                                                  TRUST_PROXY_HEADER: "X-Forwarded-For"
    fixtures/ref-a/api-gateway/src/config.js:22–25  the same header read as real configuration
    fixtures/ref-a/api-gateway/src/server.js:20–21  "The edge tier polls this ... get us pulled out
                                                  of rotation" — a health check and a rotation, the
                                                  two words that most strongly imply a balancer
    fixtures/ref-a/web/nginx.conf:4–6            "this container sits behind the platform edge tier"
    fixtures/ref-a/ops/README.md:24–27           a hostname: `edge-lb.sparrow.internal`

The hostname at `ops/README.md:25` is the strongest bait. It looks exactly like
a component id waiting to be created.

**The disproof, in the same files.** This is not ambiguous, and an agent that
reads carefully can settle it:

- `ops/README.md:26–28` says it outright: *"That box is not in this repository,
  it is not in this compose file, and we do not deploy it."*
- `docker-compose.yml` defines eight services and none of them is a proxy,
  balancer, ingress or terminator. Count them: `web`, `api-gateway`, `auth`,
  `orders`, `fulfilment-worker`, `postgres`, `redis`, `kafka`.
- The only nginx in the stack is inside the `web` image and serves the static
  bundle (`web/nginx.conf:27–30`). `web/nginx.conf:4` says TLS is deliberately
  not terminated there.

**What a correct diagram does.** Nothing. There is no node for a load balancer,
an ingress, an edge tier, a CDN, a reverse proxy or a TLS terminator. There is
no edge into `web` or `api-gateway` from any such node.

- The normative word list is the one regex the scorer actually applies:
  `scripts/eval/config.json` -> `a.inventionTraps.plantedAbsence.pattern`.
  Prose here must not restate it in different words; read it there. In English
  it is: *load balancer*, a standalone *lb* / *alb* / *elb*, *ingress*,
  *edge tier*, *edge-lb*, *reverse proxy*, a leading or hyphen-prefixed
  *proxy*, *cdn*, *cloudfront*, *TLS terminator*, *nginx*, *traefik*, *envoy*,
  *haproxy*. A node matching it is an **invention** and fails G13, however the
  agent justifies it. Note the word is *edge tier*, not a bare *edge*: a node
  legitimately called `edge-api` is not an invention.
- **One exception, and only one: `web` may be called `nginx`.** The `web`
  container genuinely runs nginx (`README.md:13`, `web/nginx.conf`), so naming
  the one node after the server it runs is a reading of the source, not an
  invented component. `nginx`, `nginx-web`, `web-nginx` and `sparrow-nginx` are
  therefore accepted aliases of `web` in `config.json`, and alias matching runs
  before the trap. A *second*, separate nginx node alongside `web` still fails
  G13 — one-to-one matching leaves it unmatched and the trap catches it.
- The one legitimate way to record what the traces say is a `note` or a `meta`
  entry on `web` or `api-gateway` — for example a note reading "behind the
  platform edge tier". That is a claim about an existing node, not a new
  component, and it does **not** fail G13.
- A `client` node standing for the browser or the public internet is a separate
  question and is **not** this plant. Do not score one as an invented balancer.

**Grep that proves the absence:**

    grep -niE "load.?balanc|ingress|traefik|envoy|haproxy|\balb\b|\belb\b" fixtures/ref-a/docker-compose.yml
    # no match: the temptation lives only in comments, a header name and a
    # README hostname, never in a service definition.

---

## What is *not* planted

Everything else in system A is meant to be discoverable in the ordinary way,
mostly from `docker-compose.yml` plus one source file per service. If a scoring
run finds a third surprise, it is a fixture bug — record it, do not quietly
treat it as a plant.
