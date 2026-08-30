// Command fleet-api serves the fleet console: vehicles and trips from fleetdb,
// live positions from the vehicle-state table, job creation forwarded to
// dispatch over gRPC.
//
// Like ingest-gateway it terminates TLS itself; there is no load balancer.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/northwind-fleet/telemetry-platform/internal/dispatchclient"
	"github.com/northwind-fleet/telemetry-platform/internal/fleetapi"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/config"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/ddb"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("fleet-api exited", "err", err)
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
	if err := cfg.RequireState(); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	db, err := pg.Open(ctx, cfg.PostgresDSN)
	if err != nil {
		return err
	}
	defer db.Close()

	aws, err := awscfg.LoadDefaultConfig(ctx, awscfg.WithRegion(cfg.Region))
	if err != nil {
		return err
	}
	state := ddb.New(dynamodb.NewFromConfig(aws), cfg.StateTable)

	disp, err := dispatchclient.Dial(ctx)
	if err != nil {
		return err
	}
	defer disp.Close()

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           fleetapi.New(db, state, disp).Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()
	log.Info("listening", "addr", cfg.ListenAddr)
	if err := srv.ListenAndServeTLS("/etc/fleet/tls.crt", "/etc/fleet/tls.key"); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
