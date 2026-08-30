// Sparrow auth. Human logins produce a session cookie; machine callers
// exchange a client id and secret for a short-lived bearer token.
//
// Routes:
//   POST /login              email + password  -> session cookie
//   POST /logout             revoke the session
//   GET  /me                 the current user
//   POST /introspect         gateway asks: whose session is this cookie?
//   POST /token              client_credentials -> service JWT
//   POST /verify             is this service token good, and for what scopes?

import express from 'express';
import argon2 from 'argon2';
import pino from 'pino';
import { findUserByEmail, findUserById, findServiceAccount, touchLastLogin } from './db.js';
import {
  createSession,
  resolveSession,
  revokeSession,
  issueServiceToken,
  verifyServiceToken,
  closeTokens,
} from './tokens.js';

const log = pino({ name: 'auth' });
const app = express();
app.use(express.json());

const SESSION_COOKIE = 'sparrow_sid';

function readSid(req) {
  const header = req.get('cookie') || '';
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await findUserByEmail(email || '');
  if (!user || user.disabled_at) return res.status(401).json({ error: 'invalid credentials' });

  const ok = await argon2.verify(user.password_hash, password || '');
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });

  const { sid, expiresIn } = await createSession(user.id);
  await touchLastLogin(user.id);
  res.cookie(SESSION_COOKIE, sid, { httpOnly: true, sameSite: 'lax', maxAge: expiresIn * 1000 });
  return res.json({ id: user.id, email: user.email });
});

app.post('/logout', async (req, res) => {
  await revokeSession(readSid(req));
  res.clearCookie(SESSION_COOKIE);
  return res.status(204).end();
});

app.get('/me', async (req, res) => {
  const userId = await resolveSession(readSid(req));
  if (!userId) return res.status(401).json({ error: 'no session' });
  const user = await findUserById(userId);
  return user ? res.json(user) : res.status(401).json({ error: 'no session' });
});

// Called by the gateway on every authenticated request. Cheap on purpose:
// one redis GET, no database round trip.
app.post('/introspect', async (req, res) => {
  const header = req.body?.cookie || '';
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const userId = await resolveSession(match ? match[1] : null);
  return userId ? res.json({ userId }) : res.status(401).json({ error: 'invalid session' });
});

// client_credentials, for background jobs that have no user.
app.post('/token', async (req, res) => {
  const { client_id: clientId, client_secret: clientSecret } = req.body || {};
  const account = await findServiceAccount(clientId || '');
  if (!account) return res.status(401).json({ error: 'unknown client' });

  const ok = await argon2.verify(account.secret_hash, clientSecret || '');
  if (!ok) return res.status(401).json({ error: 'bad secret' });

  const token = await issueServiceToken(account.client_id, account.scopes);
  return res.json({ access_token: token, token_type: 'Bearer', expires_in: 600 });
});

// The other half of /token: whoever holds a service token asks us whether it
// is still good before acting on it.
app.post('/verify', async (req, res) => {
  const token = (req.get('authorization') || '').replace(/^Bearer /i, '');
  try {
    const payload = await verifyServiceToken(token);
    return res.json({ active: true, sub: payload.sub, scopes: payload.scopes });
  } catch (err) {
    log.warn({ err: err.message }, 'service token rejected');
    return res.status(401).json({ active: false });
  }
});

const server = app.listen(Number(process.env.PORT || 3001), () => log.info('auth listening'));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await closeTokens();
    process.exit(0);
  });
}
