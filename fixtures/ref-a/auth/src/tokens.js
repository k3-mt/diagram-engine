// Sessions are opaque ids in redis, not self-describing cookies, so that
// revocation is immediate. Service-to-service callers get a short JWT instead
// because they cannot hold a cookie jar.

import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { SignJWT, jwtVerify } from 'jose';

const redis = new Redis(process.env.REDIS_URL);
const ttl = Number(process.env.TOKEN_TTL_SECONDS || 900);
const signingKey = new TextEncoder().encode(process.env.JWT_SIGNING_KEY);

export async function createSession(userId) {
  const sid = randomBytes(24).toString('base64url');
  await redis.setex(`session:${sid}`, ttl, userId);
  return { sid, expiresIn: ttl };
}

export async function resolveSession(sid) {
  if (!sid) return null;
  const userId = await redis.get(`session:${sid}`);
  if (!userId) return null;
  // Sliding window: an active session should not expire under someone.
  await redis.expire(`session:${sid}`, ttl);
  return userId;
}

export async function revokeSession(sid) {
  await redis.del(`session:${sid}`);
}

export async function issueServiceToken(clientId, scopes) {
  return new SignJWT({ scopes })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(clientId)
    .setIssuer('sparrow-auth')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey);
}

export async function verifyServiceToken(token) {
  const { payload } = await jwtVerify(token, signingKey, { issuer: 'sparrow-auth' });
  return payload;
}

export async function closeTokens() {
  await redis.quit();
}
