// Package config loads process configuration from the environment.
//
// Every binary calls Load once in main. Fields that are blank after Load are
// treated as "this binary does not use that dependency" — see the per-binary
// Require* helpers at the bottom of the file.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Env    string // "prod", "staging"
	Region string // AWS region, e.g. "eu-west-1"

	ListenAddr string // http/grpc listen address

	PostgresDSN  string // fleetdb
	StateTable   string // DynamoDB table holding latest vehicle state
	FrameBucket  string // S3 bucket for raw frames
	FrameStream  string // Kinesis stream name
	StreamConsumer string // enhanced fan-out consumer name

	RoutingBaseURL string // third-party routing provider
	RoutingAPIKey  string

	ShutdownGrace time.Duration
}

func Load() (Config, error) {
	c := Config{
		Env:            get("FLEET_ENV", "prod"),
		Region:         get("AWS_REGION", "eu-west-1"),
		ListenAddr:     get("LISTEN_ADDR", ":8080"),
		PostgresDSN:    os.Getenv("FLEETDB_DSN"),
		StateTable:     os.Getenv("VEHICLE_STATE_TABLE"),
		FrameBucket:    os.Getenv("RAW_FRAME_BUCKET"),
		FrameStream:    os.Getenv("TELEMETRY_STREAM"),
		StreamConsumer: os.Getenv("TELEMETRY_STREAM_CONSUMER"),
		RoutingBaseURL: os.Getenv("ROUTING_BASE_URL"),
		RoutingAPIKey:  os.Getenv("ROUTING_API_KEY"),
	}
	secs, err := strconv.Atoi(get("SHUTDOWN_GRACE_SECONDS", "20"))
	if err != nil {
		return Config{}, fmt.Errorf("SHUTDOWN_GRACE_SECONDS: %w", err)
	}
	c.ShutdownGrace = time.Duration(secs) * time.Second
	return c, nil
}

func get(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func (c Config) RequirePostgres() error { return req("FLEETDB_DSN", c.PostgresDSN) }
func (c Config) RequireState() error    { return req("VEHICLE_STATE_TABLE", c.StateTable) }
func (c Config) RequireBucket() error   { return req("RAW_FRAME_BUCKET", c.FrameBucket) }
func (c Config) RequireStream() error   { return req("TELEMETRY_STREAM", c.FrameStream) }
func (c Config) RequireRouting() error  { return req("ROUTING_BASE_URL", c.RoutingBaseURL) }

func req(name, v string) error {
	if v == "" {
		return fmt.Errorf("%s is required", name)
	}
	return nil
}
