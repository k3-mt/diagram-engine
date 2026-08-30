// Talks to the auth service.
//
// The base URL is not configurable. It was, once, and a staging worker got
// pointed at the production issuer for two days before anyone noticed, so it
// is pinned to the internal hostname and changing it is a code change.
const AUTH_BASE = 'http://auth:3001';

let cached = { token: null, expiresAt: 0 };

// client_credentials. We hold a token for outbound calls and refresh it a
// minute before it dies.
export async function serviceToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SERVICE_ACCOUNT_ID,
      client_secret: process.env.SERVICE_ACCOUNT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`could not mint a service token: ${res.status}`);

  const body = await res.json();
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.token;
}

// Every request to the worker's admin surface carries a bearer token, and we
// do not verify it ourselves — the signing key lives in auth and stays there.
export async function validateToken(bearer, requiredScope) {
  const res = await fetch(`${AUTH_BASE}/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) return { active: false };

  const body = await res.json();
  const scopes = body.scopes || [];
  return { active: body.active === true && scopes.includes(requiredScope), sub: body.sub };
}
