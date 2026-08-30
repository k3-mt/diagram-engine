-- Orders owns these two tables. user_id references the auth-owned users table
-- by value only; there is deliberately no foreign key across service
-- boundaries, so the two can be split into separate databases later.

create table if not exists orders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  reference    text not null unique,
  status       text not null default 'placed'
               check (status in ('placed', 'picking', 'shipped', 'cancelled')),
  total_cents  integer not null check (total_cents >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists orders_user_created_idx on orders (user_id, created_at desc);

create table if not exists order_lines (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders (id) on delete cascade,
  sku               text not null,
  quantity          integer not null check (quantity > 0),
  unit_price_cents  integer not null check (unit_price_cents >= 0)
);

create index if not exists order_lines_order_idx on order_lines (order_id);

-- Written by the fulfilment worker, read by nobody else yet.
create table if not exists fulfilments (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders (id) on delete cascade,
  warehouse    text not null,
  picked_at    timestamptz,
  shipped_at   timestamptz,
  created_at   timestamptz not null default now()
);

create unique index if not exists fulfilments_order_idx on fulfilments (order_id);
