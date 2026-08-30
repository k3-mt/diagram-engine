// Command geofence-eval consumes decoded frames from the telemetry stream,
// evaluates zone rules loaded from fleetdb, and writes entry/exit alerts back
// to fleetdb.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kinesis"

	"github.com/northwind-fleet/telemetry-platform/internal/geofence"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/config"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/sqsx"
	"github.com/northwind-fleet/telemetry-platform/internal/telemetry"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("geofence-eval exited", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := cfg.RequireStream(); err != nil {
		return err
	}
	if err := cfg.RequirePostgres(); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	db, err := pg.Open(ctx, cfg.PostgresDSN)
	if err != nil {
		return err
	}
	defer db.Close()

	eval := geofence.NewEvaluator(db)
	go func() {
		if err := eval.ReloadLoop(ctx, time.Minute); err != nil && ctx.Err() == nil {
			log.Error("zone reload stopped", "err", err)
		}
	}()

	aws, err := awscfg.LoadDefaultConfig(ctx, awscfg.WithRegion(cfg.Region))
	if err != nil {
		return err
	}
	consumer := sqsx.NewConsumer(kinesis.NewFromConfig(aws), cfg.FrameStream, cfg.StreamConsumer)

	log.Info("consuming", "stream", cfg.FrameStream, "consumer", cfg.StreamConsumer)
	return consumer.Poll(ctx, os.Getenv("SHARD_ID"), func(ctx context.Context, r sqsx.Record) error {
		var f telemetry.Frame
		if err := json.Unmarshal(r.Data, &f); err != nil {
			log.Warn("undecodable record", "seq", r.SequenceNumber, "err", err)
			return nil
		}
		return eval.Handle(ctx, f)
	})
}
