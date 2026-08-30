// Command ingest-gateway terminates device TLS, decodes NF-1 frames, archives
// each raw frame to S3, writes the vehicle's latest state to DynamoDB, and
// publishes the decoded frame to the telemetry stream.
//
// It is the only writer of raw-frames and the only producer on the stream.
package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/kinesis"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/northwind-fleet/telemetry-platform/internal/platform/config"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/ddb"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/s3x"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/sqsx"
	"github.com/northwind-fleet/telemetry-platform/internal/telemetry"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("ingest-gateway exited", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	for _, check := range []func() error{cfg.RequireBucket, cfg.RequireState, cfg.RequireStream} {
		if err := check(); err != nil {
			return err
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	aws, err := awscfg.LoadDefaultConfig(ctx, awscfg.WithRegion(cfg.Region))
	if err != nil {
		return err
	}
	archive := s3x.New(s3.NewFromConfig(aws), cfg.FrameBucket)
	state := ddb.New(dynamodb.NewFromConfig(aws), cfg.StateTable)
	frames := sqsx.NewProducer(kinesis.NewFromConfig(aws), cfg.FrameStream)

	g := &gateway{archive: archive, state: state, frames: frames, log: log}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /nf1/frames", g.postFrame)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// TLS is terminated here, on the task's own public IP. There is no load
	// balancer in front of this process; devices resolve the Route 53 record
	// for ingest.northwindfleet.io directly. See terraform/ecs.tf.
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           mux,
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

type gateway struct {
	archive *s3x.Archive
	state   *ddb.Client
	frames  *sqsx.Producer
	log     *slog.Logger
}

func (g *gateway) postFrame(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	f, err := telemetry.Decode(raw)
	if err != nil {
		g.log.Warn("bad frame", "err", err)
		http.Error(w, "bad frame", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	if err := g.archive.Put(ctx, f.VehicleID, f.At, f.Raw); err != nil {
		http.Error(w, "archive", http.StatusBadGateway)
		return
	}
	if err := g.state.Put(ctx, ddb.State{
		VehicleID: f.VehicleID, Lat: f.Lat, Lon: f.Lon,
		SpeedKPH: f.SpeedKPH, OdometerM: f.OdometerM, At: f.At,
	}); err != nil {
		http.Error(w, "state", http.StatusBadGateway)
		return
	}
	if err := g.frames.Publish(ctx, f.VehicleID, f); err != nil {
		http.Error(w, "publish", http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}
