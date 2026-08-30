// server.go — the dispatch gRPC handlers.
//
// Two RPCs are exposed on /fleet.dispatch.v1.Dispatch:
//   CreateJob    — fleet-api calls this when a manager schedules work
//   HoldVehicle  — takes a vehicle out of the assignable pool
//
// Assignment picks the candidate with the shortest provider ETA to the drop.
package main

import (
	"context"
	"fmt"
	"log/slog"

	"google.golang.org/grpc"

	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
	"github.com/northwind-fleet/telemetry-platform/internal/routing"
)

type server struct {
	db     *pg.DB
	routes *routing.Provider
	log    *slog.Logger
}

// registerDispatch wires the handwritten codec (the proto toolchain is not run
// in CI; see deploy/proto.md) onto the grpc server.
func registerDispatch(g *grpc.Server, s *server) {
	g.RegisterService(&grpc.ServiceDesc{
		ServiceName: "fleet.dispatch.v1.Dispatch",
		HandlerType: (*any)(nil),
		Methods: []grpc.MethodDesc{
			{MethodName: "CreateJob", Handler: s.createJob},
			{MethodName: "HoldVehicle", Handler: s.holdVehicle},
		},
	}, s)
}

type jobReq struct {
	ID        string
	VehicleID string
	DropLat   float64
	DropLon   float64
}

func (s *server) createJob(_ any, ctx context.Context, dec func(any) error, _ grpc.UnaryServerInterceptor) (any, error) {
	var req jobReq
	if err := dec(&req); err != nil {
		return nil, err
	}
	vehicleID := req.VehicleID
	if vehicleID == "" {
		var err error
		vehicleID, err = s.pickVehicle(ctx, req.DropLat, req.DropLon)
		if err != nil {
			return nil, err
		}
	}
	var jobID string
	err := s.db.Pool().QueryRow(ctx,
		`insert into jobs (vehicle_id, drop_lat, drop_lon, state)
		 values ($1,$2,$3,'assigned') returning job_id`,
		vehicleID, req.DropLat, req.DropLon).Scan(&jobID)
	if err != nil {
		return nil, fmt.Errorf("insert job: %w", err)
	}
	s.log.Info("job assigned", "job", jobID, "vehicle", vehicleID)
	return jobID, nil
}

// pickVehicle asks the routing provider for an ETA per candidate and takes the
// smallest. Candidates come from fleetdb, which holds each vehicle's last
// reported position alongside its assignable flag.
func (s *server) pickVehicle(ctx context.Context, lat, lon float64) (string, error) {
	rows, err := s.db.Pool().Query(ctx,
		`select vehicle_id, last_lat, last_lon from vehicles
		 where active and assignable and last_seen_at > now() - interval '15 minutes'`)
	if err != nil {
		return "", fmt.Errorf("load candidates: %w", err)
	}
	defer rows.Close()
	best, bestETA := "", 1<<30
	for rows.Next() {
		var id string
		var vlat, vlon float64
		if err := rows.Scan(&id, &vlat, &vlon); err != nil {
			return "", err
		}
		eta, err := s.routes.ETABetween(ctx, vlat, vlon, lat, lon)
		if err != nil {
			s.log.Warn("eta failed, skipping candidate", "vehicle", id, "err", err)
			continue
		}
		if eta.Seconds < bestETA {
			best, bestETA = id, eta.Seconds
		}
	}
	if best == "" {
		return "", fmt.Errorf("no assignable vehicle near %f,%f", lat, lon)
	}
	return best, nil
}

type holdReq struct {
	VehicleID string
	Reason    string
}

// holdVehicle clears the assignable flag and releases any open job so the next
// CreateJob can place it elsewhere.
func (s *server) holdVehicle(_ any, ctx context.Context, dec func(any) error, _ grpc.UnaryServerInterceptor) (any, error) {
	var req holdReq
	if err := dec(&req); err != nil {
		return nil, err
	}
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`update vehicles set assignable = false, hold_reason = $2 where vehicle_id = $1`,
		req.VehicleID, req.Reason); err != nil {
		return nil, fmt.Errorf("hold %s: %w", req.VehicleID, err)
	}
	if _, err := tx.Exec(ctx,
		`update jobs set state = 'unassigned', vehicle_id = null
		 where vehicle_id = $1 and state = 'assigned'`, req.VehicleID); err != nil {
		return nil, fmt.Errorf("release jobs for %s: %w", req.VehicleID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.log.Info("vehicle held", "vehicle", req.VehicleID, "reason", req.Reason)
	return struct{}{}, nil
}
