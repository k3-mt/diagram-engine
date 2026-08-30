// Package maintenance forecasts service due dates from odometer history and
// diagnostic trouble codes.
//
// Runs once a night as a scheduled ECS task (terraform/schedules.tf). Reads
// vehicle and trip history from fleetdb, writes a forecast row per vehicle.
package maintenance

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/northwind-fleet/telemetry-platform/internal/dispatchclient"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
)

// criticalDTCs are codes that take a vehicle off the road immediately rather
// than scheduling it for the next service window.
var criticalDTCs = map[string]string{
	"P0217": "engine overheat",
	"C1201": "abs fault",
	"P0700": "transmission control fault",
}

type Forecaster struct {
	db   *pg.DB
	disp *dispatchclient.Client
	log  *slog.Logger
}

// New builds a forecaster. disp may be nil in tests; Run then only writes
// forecast rows and logs what it would have held.
func New(db *pg.DB, disp *dispatchclient.Client, log *slog.Logger) *Forecaster {
	return &Forecaster{db: db, disp: disp, log: log}
}

type vehicleHistory struct {
	VehicleID    string
	OdometerM    int64
	LastServiceM int64
	IntervalM    int64
	AvgDailyM    int64
	OpenDTCs     []string
}

// Run forecasts every active vehicle.
func (f *Forecaster) Run(ctx context.Context, now time.Time) error {
	hs, err := f.history(ctx)
	if err != nil {
		return err
	}
	for _, h := range hs {
		due := forecastDue(h, now)
		if err := f.writeForecast(ctx, h.VehicleID, due); err != nil {
			return err
		}
		if code, reason := firstCritical(h.OpenDTCs); code != "" {
			// A critical fault must not wait for the next service window, and
			// it must not stay assignable until a human notices the forecast.
			// Take the vehicle out of the pool now; dispatch reassigns any job
			// it was carrying.
			if f.disp == nil {
				f.log.Warn("would hold vehicle", "vehicle", h.VehicleID, "code", code)
				continue
			}
			if err := f.disp.HoldVehicle(ctx, h.VehicleID, code+" "+reason); err != nil {
				return fmt.Errorf("hold %s on %s: %w", h.VehicleID, code, err)
			}
			f.log.Info("vehicle held", "vehicle", h.VehicleID, "code", code)
		}
	}
	return nil
}

func (f *Forecaster) history(ctx context.Context) ([]vehicleHistory, error) {
	const q = `select v.vehicle_id, v.odometer_m, v.last_service_m, v.service_interval_m,
	                  coalesce(t.avg_daily_m, 0), coalesce(d.codes, '{}')
	           from vehicles v
	           left join vehicle_daily_distance t using (vehicle_id)
	           left join open_dtcs d using (vehicle_id)
	           where v.active`
	rows, err := f.db.Pool().Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("load vehicle history: %w", err)
	}
	defer rows.Close()
	var out []vehicleHistory
	for rows.Next() {
		var h vehicleHistory
		if err := rows.Scan(&h.VehicleID, &h.OdometerM, &h.LastServiceM,
			&h.IntervalM, &h.AvgDailyM, &h.OpenDTCs); err != nil {
			return nil, fmt.Errorf("scan vehicle history: %w", err)
		}
		out = append(out, h)
	}
	return out, nil
}

func (f *Forecaster) writeForecast(ctx context.Context, vehicleID string, due time.Time) error {
	_, err := f.db.Pool().Exec(ctx,
		`insert into maintenance_forecasts (vehicle_id, due_on, computed_at)
		 values ($1, $2, now())
		 on conflict (vehicle_id) do update set due_on = excluded.due_on, computed_at = now()`,
		vehicleID, due)
	if err != nil {
		return fmt.Errorf("write forecast for %s: %w", vehicleID, err)
	}
	return nil
}

func forecastDue(h vehicleHistory, now time.Time) time.Time {
	remaining := h.LastServiceM + h.IntervalM - h.OdometerM
	if remaining <= 0 || h.AvgDailyM <= 0 {
		return now
	}
	days := remaining / h.AvgDailyM
	return now.AddDate(0, 0, int(days))
}

func firstCritical(codes []string) (string, string) {
	for _, c := range codes {
		if reason, ok := criticalDTCs[c]; ok {
			return c, reason
		}
	}
	return "", ""
}
