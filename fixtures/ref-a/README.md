# Sparrow

A small order-taking system. A customer signs in, places an order, and a
background worker opens a fulfilment against it.

    web  ->  api-gateway  ->  auth
                          ->  orders  ->  kafka  ->  fulfilment-worker

Eight containers, defined in `docker-compose.yml`:

| service           | what it is | language |
|-------------------|------------|----------|
| web               | React bundle served by nginx | JS |
| api-gateway       | rate limiting, session check, routing | Node |
| auth              | logins, sessions, service tokens | Node |
| orders            | order read and write, publishes events | Node |
| fulfilment-worker | consumes order events, opens fulfilments | Node |
| postgres          | one database, two schemas' worth of tables | — |
| redis             | rate limit counters, sessions, order list cache | — |
| kafka             | one topic, `order.events.v1` | — |

Redis is shared but partitioned by logical database: `/0` gateway rate limits,
`/1` auth sessions, `/2` the orders cache. Postgres is likewise one instance
with each service owning its own tables and no cross-service foreign keys, so
the two can be pulled apart later without a data migration.

Start with `ops/README.md`.
