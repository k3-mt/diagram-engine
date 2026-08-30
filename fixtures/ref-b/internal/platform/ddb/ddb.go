// Package ddb wraps the DynamoDB table that holds the latest known state of
// each vehicle (terraform/data.tf, table "vehicle-state").
//
// One item per vehicle, overwritten on every accepted frame. It is deliberately
// not a cache in front of Postgres: trips live in Postgres, current position
// lives only here, and the two are never reconciled.
package ddb

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

type State struct {
	VehicleID string
	Lat, Lon  float64
	SpeedKPH  float64
	OdometerM int64
	At        time.Time
}

type Client struct {
	api   *dynamodb.Client
	table string
}

func New(api *dynamodb.Client, table string) *Client { return &Client{api: api, table: table} }

// Put overwrites the vehicle's row. Called by ingest-gateway on every frame.
func (c *Client) Put(ctx context.Context, s State) error {
	_, err := c.api.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(c.table),
		Item: map[string]types.AttributeValue{
			"vehicle_id": &types.AttributeValueMemberS{Value: s.VehicleID},
			"lat":        num(s.Lat),
			"lon":        num(s.Lon),
			"speed_kph":  num(s.SpeedKPH),
			"odometer_m": &types.AttributeValueMemberN{Value: strconv.FormatInt(s.OdometerM, 10)},
			"at":         &types.AttributeValueMemberS{Value: s.At.UTC().Format(time.RFC3339)},
		},
	})
	if err != nil {
		return fmt.Errorf("put vehicle state %s: %w", s.VehicleID, err)
	}
	return nil
}

// Get reads one vehicle's latest state. Called by fleet-api on the map view.
func (c *Client) Get(ctx context.Context, vehicleID string) (State, error) {
	out, err := c.api.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(c.table),
		Key: map[string]types.AttributeValue{
			"vehicle_id": &types.AttributeValueMemberS{Value: vehicleID},
		},
	})
	if err != nil {
		return State{}, fmt.Errorf("get vehicle state %s: %w", vehicleID, err)
	}
	if out.Item == nil {
		return State{}, fmt.Errorf("vehicle %s has no state", vehicleID)
	}
	return decode(out.Item)
}

func num(f float64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatFloat(f, 'f', 6, 64)}
}

func decode(item map[string]types.AttributeValue) (State, error) {
	s := State{}
	if v, ok := item["vehicle_id"].(*types.AttributeValueMemberS); ok {
		s.VehicleID = v.Value
	}
	if v, ok := item["at"].(*types.AttributeValueMemberS); ok {
		t, err := time.Parse(time.RFC3339, v.Value)
		if err != nil {
			return State{}, fmt.Errorf("bad at on %s: %w", s.VehicleID, err)
		}
		s.At = t
	}
	return s, nil
}
