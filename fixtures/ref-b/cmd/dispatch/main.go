// Command dispatch owns job assignment. It serves gRPC on 9090 and registers
// itself in the Cloud Map namespace fleet.internal as "dispatch".
//
// Callers are internal only; the service is not reachable from outside the
// VPC. It reads and writes fleetdb, and asks the routing provider for ETAs.
package main

import (
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"google.golang.org/grpc"

	"github.com/northwind-fleet/telemetry-platform/internal/platform/config"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
	"github.com/northwind-fleet/telemetry-platform/internal/routing"
	"context"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("dispatch exited", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := cfg.RequirePostgres(); err != nil {
		return err
	}
	if err := cfg.RequireRouting(); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	db, err := pg.Open(ctx, cfg.PostgresDSN)
	if err != nil {
		return err
	}
	defer db.Close()

	srv := &server{db: db, routes: routing.New(cfg.RoutingBaseURL, cfg.RoutingAPIKey), log: log}

	lis, err := net.Listen("tcp", ":9090")
	if err != nil {
		return err
	}
	g := grpc.NewServer()
	registerDispatch(g, srv)
	go func() {
		<-ctx.Done()
		g.GracefulStop()
	}()
	log.Info("grpc listening", "addr", ":9090")
	return g.Serve(lis)
}
