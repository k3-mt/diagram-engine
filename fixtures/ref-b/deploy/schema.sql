-- schema.sql — fleetdb. Applied by CI before the ECS deploy.
-- Five binaries touch this database; every table below is written by exactly
-- one of them and read by one or two others.

create table vehicles (
  vehicle_id        text primary key,
  plate             text not null,
  model             text not null,
  active            boolean not null default true,
  assignable        boolean not null default true,
  hold_reason       text,
  odometer_m        bigint not null default 0,
  last_service_m    bigint not null default 0,
  service_interval_m bigint not null default 25000000,
  last_lat          double precision,
  last_lon          double precision,
  last_seen_at      timestamptz
);

create table trips (
  trip_id     bigserial primary key,
  vehicle_id  text not null references vehicles,
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  distance_m  bigint not null,
  point_count int not null
);
create index trips_vehicle_started on trips (vehicle_id, started_at desc);

create table geofence_zones (
  zone_id   text primary key,
  name      text not null,
  ring      double precision[][] not null,
  on_enter  boolean not null default true,
  on_exit   boolean not null default true,
  active    boolean not null default true
);

create table geofence_alerts (
  alert_id   bigserial primary key,
  vehicle_id text not null references vehicles,
  zone_id    text not null references geofence_zones,
  kind       text not null check (kind in ('enter', 'exit')),
  at         timestamptz not null
);
create index geofence_alerts_at on geofence_alerts (at desc);

create table jobs (
  job_id     uuid primary key default gen_random_uuid(),
  vehicle_id text references vehicles,
  drop_lat   double precision not null,
  drop_lon   double precision not null,
  due_by     timestamptz,
  state      text not null check (state in ('unassigned', 'assigned', 'done'))
);

create table maintenance_forecasts (
  vehicle_id  text primary key references vehicles,
  due_on      timestamptz not null,
  computed_at timestamptz not null
);

create table open_dtcs (
  vehicle_id text not null references vehicles,
  codes      text[] not null,
  primary key (vehicle_id)
);

create view vehicle_daily_distance as
  select vehicle_id, (sum(distance_m) / greatest(count(distinct date(started_at)), 1))::bigint as avg_daily_m
  from trips
  where started_at > now() - interval '90 days'
  group by vehicle_id;
