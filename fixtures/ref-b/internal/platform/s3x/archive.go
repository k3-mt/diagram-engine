// Package s3x writes raw telemetry frames to the archive bucket
// (terraform/data.tf, bucket "northwind-fleet-raw-frames-<env>").
//
// Write-only from the platform's point of view. Nothing in this repository
// reads the archive back; it exists for the analytics team, who query it from
// outside this system.
package s3x

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Archive struct {
	api    *s3.Client
	bucket string
}

func New(api *s3.Client, bucket string) *Archive { return &Archive{api: api, bucket: bucket} }

// Put stores one raw frame under day/vehicle/timestamp, gzipped.
func (a *Archive) Put(ctx context.Context, vehicleID string, at time.Time, raw []byte) error {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		return fmt.Errorf("gzip frame: %w", err)
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("close gzip: %w", err)
	}
	key := fmt.Sprintf("frames/dt=%s/vehicle=%s/%d.json.gz",
		at.UTC().Format("2006-01-02"), vehicleID, at.UTC().UnixNano())
	_, err := a.api.PutObject(ctx, &s3.PutObjectInput{
		Bucket:          aws.String(a.bucket),
		Key:             aws.String(key),
		Body:            bytes.NewReader(buf.Bytes()),
		ContentEncoding: aws.String("gzip"),
		ContentType:     aws.String("application/json"),
	})
	if err != nil {
		return fmt.Errorf("archive frame %s: %w", key, err)
	}
	return nil
}
