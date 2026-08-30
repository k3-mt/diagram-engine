// Package geofence evaluates zone rules against decoded frames and records
// entry/exit alerts.
//
// Zones are read from fleetdb once a minute and held in memory; the working
// set is small (a few thousand polygons) and the reload is cheap next to a
// per-frame query.
package geofence

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
	"github.com/northwind-fleet/telemetry-platform/internal/telemetry"
)

type Zone struct {
	ID      string
	Name    string
	Ring    [][2]float64 // closed polygon, lon/lat
	OnEnter bool
	OnExit  bool
}

type Evaluator struct {
	db *pg.DB

	mu     sync.RWMutex
	zones  []Zone
	inside map[string]map[string]bool // vehicle -> zone -> in
}

func NewEvaluator(db *pg.DB) *Evaluator {
	return &Evaluator{db: db, inside: map[string]map[string]bool{}}
}

// ReloadLoop refreshes the zone set from fleetdb until ctx is cancelled.
func (e *Evaluator) ReloadLoop(ctx context.Context, every time.Duration) error {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := e.reload(ctx); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (e *Evaluator) reload(ctx context.Context) error {
	rows, err := e.db.Pool().Query(ctx,
		`select zone_id, name, ring, on_enter, on_exit from geofence_zones where active`)
	if err != nil {
		return fmt.Errorf("load zones: %w", err)
	}
	defer rows.Close()
	var zs []Zone
	for rows.Next() {
		var z Zone
		if err := rows.Scan(&z.ID, &z.Name, &z.Ring, &z.OnEnter, &z.OnExit); err != nil {
			return fmt.Errorf("scan zone: %w", err)
		}
		zs = append(zs, z)
	}
	e.mu.Lock()
	e.zones = zs
	e.mu.Unlock()
	return nil
}

// Handle evaluates one frame and writes an alert row per crossing.
func (e *Evaluator) Handle(ctx context.Context, f telemetry.Frame) error {
	e.mu.RLock()
	zones := e.zones
	e.mu.RUnlock()
	for _, z := range zones {
		in := contains(z.Ring, f.Lon, f.Lat)
		was := e.inside[f.VehicleID][z.ID]
		if in == was {
			continue
		}
		if e.inside[f.VehicleID] == nil {
			e.inside[f.VehicleID] = map[string]bool{}
		}
		e.inside[f.VehicleID][z.ID] = in
		if (in && z.OnEnter) || (!in && z.OnExit) {
			if err := e.alert(ctx, f, z, in); err != nil {
				return err
			}
		}
	}
	return nil
}

func (e *Evaluator) alert(ctx context.Context, f telemetry.Frame, z Zone, entering bool) error {
	kind := "exit"
	if entering {
		kind = "enter"
	}
	_, err := e.db.Pool().Exec(ctx,
		`insert into geofence_alerts (vehicle_id, zone_id, kind, at) values ($1,$2,$3,$4)`,
		f.VehicleID, z.ID, kind, f.At)
	if err != nil {
		return fmt.Errorf("write %s alert for %s: %w", kind, f.VehicleID, err)
	}
	return nil
}

// contains is a ray-cast point-in-polygon test on a closed ring.
func contains(ring [][2]float64, lon, lat float64) bool {
	in := false
	for i, j := 0, len(ring)-1; i < len(ring); j, i = i, i+1 {
		xi, yi := ring[i][0], ring[i][1]
		xj, yj := ring[j][0], ring[j][1]
		if (yi > lat) != (yj > lat) && lon < (xj-xi)*(lat-yi)/(yj-yi)+xi {
			in = !in
		}
	}
	return in
}
