# gRPC surface

`fleet.dispatch.v1.Dispatch` is the only gRPC service in the platform. The
proto toolchain is not run in CI: the two methods are registered by hand in
`cmd/dispatch/server.go` and called through `internal/dispatchclient`, so the
authoritative list of callers is the set of packages importing
`internal/dispatchclient`.

| method | what it does |
|---|---|
| `CreateJob` | assign work to a vehicle, choosing one by provider ETA if none is named |
| `HoldVehicle` | clear `assignable`, release any open job |

`dispatch` listens on `:9090` and registers as `dispatch.fleet.internal`
(`terraform/discovery.tf`). The address is a constant in the client package,
not an environment variable.
