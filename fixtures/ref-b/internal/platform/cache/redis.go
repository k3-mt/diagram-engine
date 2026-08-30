// Package cache holds the position cache client: a small Redis wrapper that
// keeps each vehicle's last known position hot, so the console map does not
// pay a DynamoDB read per vehicle per refresh.
//
// Key layout and TTL were agreed in FLEET-812. Endpoint comes from
// POSITION_CACHE_ENDPOINT.
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// positionKeyPrefix is the key layout agreed in FLEET-812.
	positionKeyPrefix = "veh:pos:"
	// defaultTTL keeps a position hot for two minutes after the last frame.
	defaultTTL = 2 * time.Minute
)

type Client struct {
	rdb *redis.Client
	ttl time.Duration
}

// New dials the endpoint from POSITION_CACHE_ENDPOINT.
func New(endpoint string) *Client {
	return &Client{
		rdb: redis.NewClient(&redis.Options{Addr: endpoint, DB: 0}),
		ttl: defaultTTL,
	}
}

type Position struct {
	Lat, Lon float64   `json:"lat"`
	At       time.Time `json:"at"`
}

func (c *Client) SetPosition(ctx context.Context, vehicleID string, p Position) error {
	body, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal position: %w", err)
	}
	if err := c.rdb.Set(ctx, positionKeyPrefix+vehicleID, body, c.ttl).Err(); err != nil {
		return fmt.Errorf("cache position %s: %w", vehicleID, err)
	}
	return nil
}

func (c *Client) GetPosition(ctx context.Context, vehicleID string) (Position, bool, error) {
	body, err := c.rdb.Get(ctx, positionKeyPrefix+vehicleID).Bytes()
	if err == redis.Nil {
		return Position{}, false, nil
	}
	if err != nil {
		return Position{}, false, fmt.Errorf("read cached position %s: %w", vehicleID, err)
	}
	var p Position
	if err := json.Unmarshal(body, &p); err != nil {
		return Position{}, false, fmt.Errorf("decode cached position %s: %w", vehicleID, err)
	}
	return p, true, nil
}
