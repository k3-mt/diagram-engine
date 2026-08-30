// Package pg is the Postgres access layer for fleetdb (RDS, terraform/rds.tf).
//
// Schema lives in deploy/schema.sql. Five binaries touch this database; each
// one uses a narrow subset of the tables, listed on the constructor below.
package pg

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct{ pool *pgxpool.Pool }

// Open dials fleetdb. dsn comes from FLEETDB_DSN, which terraform writes into
// the task definition of every service that reads or writes the database.
func Open(ctx context.Context, dsn string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse fleetdb dsn: %w", err)
	}
	cfg.MaxConns = 8
	cfg.MaxConnLifetime = 30 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect fleetdb: %w", err)
	}
	return &DB{pool: pool}, nil
}

func (d *DB) Close() { d.pool.Close() }

func (d *DB) Pool() *pgxpool.Pool { return d.pool }

// Ping is used by every binary's /healthz. It asserts nothing about the rest
// of the platform, only that this process can reach fleetdb.
func (d *DB) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }
