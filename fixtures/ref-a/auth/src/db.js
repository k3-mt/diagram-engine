// Postgres access for auth. Auth owns exactly two tables, `users` and
// `service_accounts` (see migrations/001_auth.sql); it reads no table another
// service writes.

import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000,
});

export async function findUserByEmail(email) {
  const { rows } = await pool.query(
    'select id, email, password_hash, disabled_at from users where lower(email) = lower($1)',
    [email],
  );
  return rows[0] || null;
}

export async function findUserById(id) {
  const { rows } = await pool.query('select id, email from users where id = $1', [id]);
  return rows[0] || null;
}

export async function findServiceAccount(clientId) {
  const { rows } = await pool.query(
    'select client_id, secret_hash, scopes from service_accounts where client_id = $1',
    [clientId],
  );
  return rows[0] || null;
}

export async function touchLastLogin(id) {
  await pool.query('update users set last_login_at = now() where id = $1', [id]);
}
