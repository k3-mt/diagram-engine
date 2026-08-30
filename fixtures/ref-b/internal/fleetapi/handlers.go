// Package fleetapi is the REST surface the fleet console calls.
//
// Reads come from fleetdb (vehicles, trips, alerts) and from the vehicle-state
// DynamoDB table (live positions). Writes that schedule work are not done here:
// they go to dispatch over gRPC, which owns assignment.
package fleetapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/northwind-fleet/telemetry-platform/internal/dispatchclient"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/ddb"
	"github.com/northwind-fleet/telemetry-platform/internal/platform/pg"
)

type API struct {
	db    *pg.DB
	state *ddb.Client
	disp  *dispatchclient.Client
}

func New(db *pg.DB, state *ddb.Client, disp *dispatchclient.Client) *API {
	return &API{db: db, state: state, disp: disp}
}

func (a *API) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/vehicles", a.listVehicles)
	mux.HandleFunc("GET /v1/vehicles/{id}/position", a.vehiclePosition)
	mux.HandleFunc("GET /v1/vehicles/{id}/trips", a.vehicleTrips)
	mux.HandleFunc("GET /v1/alerts", a.listAlerts)
	mux.HandleFunc("POST /v1/jobs", a.createJob)
	mux.HandleFunc("GET /healthz", a.healthz)
	return mux
}

func (a *API) listVehicles(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Pool().Query(r.Context(),
		`select vehicle_id, plate, model, active from vehicles order by plate`)
	if err != nil {
		fail(w, http.StatusBadGateway, fmt.Errorf("list vehicles: %w", err))
		return
	}
	defer rows.Close()
	type vehicle struct {
		ID     string `json:"id"`
		Plate  string `json:"plate"`
		Model  string `json:"model"`
		Active bool   `json:"active"`
	}
	out := []vehicle{}
	for rows.Next() {
		var v vehicle
		if err := rows.Scan(&v.ID, &v.Plate, &v.Model, &v.Active); err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		out = append(out, v)
	}
	writeJSON(w, out)
}

// vehiclePosition serves the console map.
//
// TODO(FLEET-812): read through internal/platform/cache instead of hitting
// DynamoDB once per vehicle per refresh. Blocked on the ElastiCache subnet
// group; until that lands this handler is the only reader of vehicle-state.
func (a *API) vehiclePosition(w http.ResponseWriter, r *http.Request) {
	s, err := a.state.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, map[string]any{
		"vehicle_id": s.VehicleID,
		"lat":        s.Lat,
		"lon":        s.Lon,
		"speed_kph":  s.SpeedKPH,
		"at":         s.At.Format(time.RFC3339),
	})
}

func (a *API) vehicleTrips(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Pool().Query(r.Context(),
		`select started_at, ended_at, distance_m from trips
		 where vehicle_id = $1 order by started_at desc limit 100`,
		r.PathValue("id"))
	if err != nil {
		fail(w, http.StatusBadGateway, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var start, end time.Time
		var dist int64
		if err := rows.Scan(&start, &end, &dist); err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		out = append(out, map[string]any{
			"started_at": start, "ended_at": end, "distance_m": dist,
		})
	}
	writeJSON(w, out)
}

func (a *API) listAlerts(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Pool().Query(r.Context(),
		`select vehicle_id, zone_id, kind, at from geofence_alerts
		 order by at desc limit 200`)
	if err != nil {
		fail(w, http.StatusBadGateway, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var vehicleID, zoneID, kind string
		var at time.Time
		if err := rows.Scan(&vehicleID, &zoneID, &kind, &at); err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		out = append(out, map[string]any{
			"vehicle_id": vehicleID, "zone_id": zoneID, "kind": kind, "at": at,
		})
	}
	writeJSON(w, out)
}

func (a *API) createJob(w http.ResponseWriter, r *http.Request) {
	var body dispatchclient.Job
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	assigned, err := a.disp.CreateJob(r.Context(), body)
	if err != nil {
		fail(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]string{"job_id": assigned})
}

func (a *API) healthz(w http.ResponseWriter, r *http.Request) {
	if err := a.db.Ping(r.Context()); err != nil {
		fail(w, http.StatusServiceUnavailable, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
