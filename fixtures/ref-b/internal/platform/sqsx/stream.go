// Package sqsx is the Kinesis producer/consumer wrapper for the single
// telemetry stream (terraform/stream.tf, stream "telemetry-frames").
//
// The package name is a leftover: the platform used SQS until the December
// migration and the import path was never changed. It has spoken Kinesis
// since then. Do not read the name as evidence of an SQS queue.
package sqsx

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kinesis"
	"github.com/aws/aws-sdk-go-v2/service/kinesis/types"
)

// Producer publishes decoded frames. Only ingest-gateway holds one.
type Producer struct {
	api    *kinesis.Client
	stream string
}

func NewProducer(api *kinesis.Client, stream string) *Producer {
	return &Producer{api: api, stream: stream}
}

// Publish writes one decoded frame. The partition key is the vehicle id, so
// all frames for a vehicle land on one shard and stay ordered.
func (p *Producer) Publish(ctx context.Context, vehicleID string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal frame for %s: %w", vehicleID, err)
	}
	_, err = p.api.PutRecord(ctx, &kinesis.PutRecordInput{
		StreamName:   aws.String(p.stream),
		PartitionKey: aws.String(vehicleID),
		Data:         body,
	})
	if err != nil {
		return fmt.Errorf("publish frame for %s: %w", vehicleID, err)
	}
	return nil
}

// Consumer reads from one registered enhanced-fan-out consumer. Two processes
// hold one each: trip-builder and geofence-eval, with different consumer names
// so they receive every record independently.
type Consumer struct {
	api      *kinesis.Client
	stream   string
	consumer string
}

func NewConsumer(api *kinesis.Client, stream, consumer string) *Consumer {
	return &Consumer{api: api, stream: stream, consumer: consumer}
}

type Record struct {
	SequenceNumber string
	Data           []byte
	Arrived        time.Time
}

// Poll subscribes to a shard and hands each record to fn. It returns on ctx
// cancellation only; a handler error is logged by the caller and the record is
// not retried, because a poison frame must not stall a vehicle's shard.
func (c *Consumer) Poll(ctx context.Context, shardID string, fn func(context.Context, Record) error) error {
	sub, err := c.api.SubscribeToShard(ctx, &kinesis.SubscribeToShardInput{
		ConsumerARN:      aws.String(c.consumerARN()),
		ShardId:          aws.String(shardID),
		StartingPosition: &types.StartingPosition{Type: types.ShardIteratorTypeLatest},
	})
	if err != nil {
		return fmt.Errorf("subscribe %s/%s: %w", c.stream, shardID, err)
	}
	for ev := range sub.GetStream().Events() {
		e, ok := ev.(*types.SubscribeToShardEventStreamMemberSubscribeToShardEvent)
		if !ok {
			continue
		}
		for _, r := range e.Value.Records {
			rec := Record{
				SequenceNumber: aws.ToString(r.SequenceNumber),
				Data:           r.Data,
				Arrived:        aws.ToTime(r.ApproximateArrivalTimestamp),
			}
			if err := fn(ctx, rec); err != nil {
				return fmt.Errorf("handle %s: %w", rec.SequenceNumber, err)
			}
		}
	}
	return ctx.Err()
}

func (c *Consumer) consumerARN() string { return c.consumer }
