// Command maintenance-forecast runs the nightly service forecast.
//
// Scheduled by EventBridge as a one-shot ECS task (terraform/schedules.tf):
// it starts, forecasts every active vehicle, and exits. It is not a server and
// has no listener.
package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/northwind-fleet/telemetry-platform/internal/dispatchclient"
	"github.com/northwind-fleet/telemetry-platform/internal/maintenance"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/config"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("maintenance-forecast failed", "err", err)
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

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	db, err := pg.Open(ctx, cfg.PostgresDSN)
	if err != nil {
		return err
	}
	defer db.Close()

	// dispatch is resolved from the Cloud Map name baked into dispatchclient;
	// this binary has no address of its own to configure.
	disp, err := dispatchclient.Dial(ctx)
	if err != nil {
		return err
	}
	defer disp.Close()

	return maintenance.New(db, disp, log).Run(ctx, time.Now().UTC())
}
