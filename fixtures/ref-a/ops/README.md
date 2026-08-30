# Running Sparrow

## Local

    docker compose up --build

Then http://localhost:8081 for the app and http://localhost:8080/healthz for
the gateway. The `internal` network is marked `internal: true`, so nothing
behind the gateway can reach the outside; if a service suddenly needs an
outbound call, that is a design conversation, not a compose edit.

## Ports

| service     | published | why |
|-------------|-----------|-----|
| web         | 8081      | the app |
| api-gateway | 8080      | direct API access for scripts and Postman |

Nothing else is published. `docker compose exec` is how you reach postgres,
redis and kafka.

## Staging and production

Sparrow does not run its own edge. Both published ports are registered with the
platform team's shared ingress, `edge-lb.sparrow.internal`, which terminates
TLS and sets `X-Forwarded-For` before anything reaches us. That box is not in
this repository, it is not in this compose file, and we do not deploy it — we
file a ticket against the platform team when a route changes.

What this means for us in practice:

- `TRUST_PROXY_HEADER` on the gateway must stay `X-Forwarded-For`. The rate
  limiter keys on it (api-gateway/src/ratelimit.js) and would otherwise see one
  client address for the entire internet.
- `/healthz` on the gateway is polled by the ingress every five seconds. Keep
  it above the rate limiter.
- Nothing in this stack should ever try to terminate TLS itself. The nginx in
  the web image serves the bundle on plain http and that is deliberate.

## Migrations

Postgres runs both services' SQL out of `docker-entrypoint-initdb.d` on first
boot only. For an existing volume, apply by hand:

    docker compose exec -T postgres psql -U sparrow sparrow < auth/migrations/001_auth.sql

## Topics

One topic, `order.events.v1`, created on demand
(`KAFKA_CFG_AUTO_CREATE_TOPICS_ENABLE`). Orders publishes it, the fulfilment
worker consumes it, and nothing else touches it.
