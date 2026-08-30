-- Auth owns these two tables and nothing else in the sparrow database.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  last_login_at timestamptz,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists users_email_lower_idx on users (lower(email));

-- Machine callers. Secrets are argon2 hashes, same as user passwords.
create table if not exists service_accounts (
  client_id   text primary key,
  secret_hash text not null,
  scopes      text[] not null default '{}',
  created_at  timestamptz not null default now()
);
