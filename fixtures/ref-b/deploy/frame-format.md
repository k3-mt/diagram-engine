# NF-1 frame format

The wire format the in-vehicle units speak. Decoded by
`internal/telemetry/decode.go`; the raw bytes are archived unchanged.

| offset | bytes | field |
|---|---|---|
| 0 | 2 | magic, `0x4E 0x46` ("NF") |
| 2 | 8 | vehicle id, big-endian |
| 10 | 4 | unix seconds |
| 14 | 4 | latitude, int32 micro-degrees |
| 18 | 4 | longitude, int32 micro-degrees |
| 22 | 2 | speed, uint16 tenths of km/h |
| 24 | 8 | odometer, uint64 metres (optional) |
| 32 | 5n | diagnostic trouble codes, 5 ASCII bytes each |

Units retry with exponential backoff and buffer up to 6 hours of frames
locally, so a gateway outage produces a burst of back-dated frames rather than
a gap.
