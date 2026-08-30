// Package dispatchclient is the gRPC client for the dispatch service.
//
// The address is not configurable: dispatch registers itself in the Cloud Map
// namespace fleet.internal (terraform/discovery.tf) and every caller resolves
// the same name, so there is no per-caller environment variable to get wrong.
package dispatchclient

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// DefaultAddr is the Cloud Map name of the dispatch gRPC listener. Callers do
// not read this from the environment; see the package comment.
const DefaultAddr = "dispatch.fleet.internal:9090"

type Client struct{ conn *grpc.ClientConn }

func Dial(ctx context.Context) (*Client, error) { return DialAddr(ctx, DefaultAddr) }

func DialAddr(ctx context.Context, addr string) (*Client, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := grpc.DialContext(ctx, addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock())
	if err != nil {
		return nil, fmt.Errorf("dial dispatch at %s: %w", addr, err)
	}
	return &Client{conn: conn}, nil
}

func (c *Client) Close() error { return c.conn.Close() }

type Job struct {
	ID        string
	VehicleID string
	DropLat   float64
	DropLon   float64
	DueBy     time.Time
}

// CreateJob asks dispatch to assign a job to a vehicle. fleet-api calls this
// when a fleet manager schedules work from the console.
func (c *Client) CreateJob(ctx context.Context, j Job) (string, error) {
	var assigned string
	err := c.conn.Invoke(ctx, "/fleet.dispatch.v1.Dispatch/CreateJob", &j, &assigned)
	if err != nil {
		return "", fmt.Errorf("create job for %s: %w", j.VehicleID, err)
	}
	return assigned, nil
}

// HoldVehicle takes a vehicle out of the assignable pool and reassigns any
// job already on it. The reason string is surfaced in the console.
func (c *Client) HoldVehicle(ctx context.Context, vehicleID, reason string) error {
	var ack struct{}
	err := c.conn.Invoke(ctx, "/fleet.dispatch.v1.Dispatch/HoldVehicle",
		&struct {
			VehicleID string
			Reason    string
		}{vehicleID, reason}, &ack)
	if err != nil {
		return fmt.Errorf("hold vehicle %s: %w", vehicleID, err)
	}
	return nil
}
