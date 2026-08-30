// Package routing talks to Waypoint Labs, the third-party routing provider
// (https://api.waypointlabs.io). It is the only outbound call this platform
// makes to anything it does not own.
//
// Base URL and key come from ROUTING_BASE_URL / ROUTING_API_KEY, which
// terraform sets on the dispatch task definition only.
package routing

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type Provider struct {
	base   string
	key    string
	client *http.Client
}

func New(base, key string) *Provider {
	return &Provider{base: base, key: key, client: &http.Client{Timeout: 4 * time.Second}}
}

type ETA struct {
	Seconds  int     `json:"duration_s"`
	Distance float64 `json:"distance_m"`
}

// ETABetween asks the provider how long the vehicle needs to reach the drop.
func (p *Provider) ETABetween(ctx context.Context, fromLat, fromLon, toLat, toLon float64) (ETA, error) {
	q := url.Values{}
	q.Set("from", coord(fromLat, fromLon))
	q.Set("to", coord(toLat, toLon))
	q.Set("profile", "truck")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.base+"/v2/eta?"+q.Encode(), nil)
	if err != nil {
		return ETA{}, fmt.Errorf("build eta request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+p.key)
	resp, err := p.client.Do(req)
	if err != nil {
		return ETA{}, fmt.Errorf("routing provider: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ETA{}, fmt.Errorf("routing provider: status %d", resp.StatusCode)
	}
	var out ETA
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ETA{}, fmt.Errorf("decode eta: %w", err)
	}
	return out, nil
}

func coord(lat, lon float64) string {
	return strconv.FormatFloat(lat, 'f', 6, 64) + "," + strconv.FormatFloat(lon, 'f', 6, 64)
}
