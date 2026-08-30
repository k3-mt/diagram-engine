// Package trips stitches decoded frames into trips and persists them.
//
// A trip opens on the first frame with speed > 0 and closes after
// idleTimeout with no movement. Open trips are held in memory per vehicle;
// a restart loses at most one open trip, which the product accepts.
package trips

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
	"github.com/northwind-fleet/telemetry-platform/internal/telemetry"
)

const idleTimeout = 5 * time.Minute

type open struct {
	StartedAt time.Time
	LastAt    time.Time
	StartOdo  int64
	LastOdo   int64
	Points    int
}

type Builder struct {
	db *pg.DB

	mu   sync.Mutex
	open map[string]*open
}

func NewBuilder(db *pg.DB) *Builder {
	return &Builder{db: db, open: map[string]*open{}}
}

// Handle folds one frame into the vehicle's open trip, closing and writing the
// previous trip to fleetdb when the vehicle has been idle past idleTimeout.
func (b *Builder) Handle(ctx context.Context, f telemetry.Frame) error {
	b.mu.Lock()
	cur, ok := b.open[f.VehicleID]
	if ok && f.At.Sub(cur.LastAt) > idleTimeout {
		delete(b.open, f.VehicleID)
		b.mu.Unlock()
		if err := b.write(ctx, f.VehicleID, cur); err != nil {
			return err
		}
		b.mu.Lock()
		ok = false
	}
	if !ok {
		if f.SpeedKPH == 0 {
			b.mu.Unlock()
			return nil
		}
		cur = &open{StartedAt: f.At, StartOdo: f.OdometerM}
		b.open[f.VehicleID] = cur
	}
	cur.LastAt = f.At
	cur.LastOdo = f.OdometerM
	cur.Points++
	b.mu.Unlock()
	return nil
}

func (b *Builder) write(ctx context.Context, vehicleID string, t *open) error {
	const q = `insert into trips
		(vehicle_id, started_at, ended_at, distance_m, point_count)
		values ($1, $2, $3, $4, $5)`
	_, err := b.db.Pool().Exec(ctx, q,
		vehicleID, t.StartedAt, t.LastAt, t.LastOdo-t.StartOdo, t.Points)
	if err != nil {
		return fmt.Errorf("write trip for %s: %w", vehicleID, err)
	}
	return nil
}
