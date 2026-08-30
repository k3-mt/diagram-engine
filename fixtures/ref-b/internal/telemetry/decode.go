// Package telemetry decodes the binary frame format the in-vehicle units
// speak (NF-1, documented in deploy/frame-format.md) into a Frame.
package telemetry

import (
	"encoding/binary"
	"errors"
	"fmt"
	"time"
)

// ErrShortFrame is returned for a truncated frame; the gateway drops those and
// counts them rather than closing the device connection.
var ErrShortFrame = errors.New("telemetry: short frame")

const headerLen = 24

type Frame struct {
	VehicleID string
	At        time.Time
	Lat, Lon  float64
	SpeedKPH  float64
	OdometerM int64
	DTCs      []string // diagnostic trouble codes, e.g. "P0420"
	Raw       []byte
}

// Decode parses one NF-1 frame. Raw is retained so ingest-gateway can archive
// exactly the bytes the unit sent.
func Decode(b []byte) (Frame, error) {
	if len(b) < headerLen {
		return Frame{}, ErrShortFrame
	}
	if b[0] != 0x4E || b[1] != 0x46 {
		return Frame{}, fmt.Errorf("telemetry: bad magic %x%x", b[0], b[1])
	}
	f := Frame{Raw: b}
	f.VehicleID = fmt.Sprintf("%X", b[2:10])
	f.At = time.Unix(int64(binary.BigEndian.Uint32(b[10:14])), 0).UTC()
	f.Lat = float64(int32(binary.BigEndian.Uint32(b[14:18]))) / 1e6
	f.Lon = float64(int32(binary.BigEndian.Uint32(b[18:22]))) / 1e6
	f.SpeedKPH = float64(binary.BigEndian.Uint16(b[22:24])) / 10
	rest := b[headerLen:]
	if len(rest) >= 8 {
		f.OdometerM = int64(binary.BigEndian.Uint64(rest[:8]))
		rest = rest[8:]
	}
	for len(rest) >= 5 {
		f.DTCs = append(f.DTCs, string(rest[:5]))
		rest = rest[5:]
	}
	return f, nil
}
