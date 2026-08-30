// Fixed-window rate limiter. The window counter lives in redis so that every
// gateway replica shares one budget; an in-process counter would let N
// replicas serve N times the limit.

import Redis from 'ioredis';
import { config } from './config.js';

const redis = new Redis(config.redisUrl);

function clientKey(req) {
  const forwarded = req.get(config.trustProxyHeader);
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  return `ratelimit:${ip}:${Math.floor(Date.now() / 60000)}`;
}

export function rateLimit() {
  return async (req, res, next) => {
    const key = clientKey(req);
    try {
      const hits = await redis.incr(key);
      if (hits === 1) await redis.expire(key, 90);
      if (hits > config.rateLimitPerMin) {
        res.set('retry-after', '60');
        return res.status(429).json({ error: 'rate limit exceeded' });
      }
    } catch (err) {
      // Fail open. A redis outage should not take the whole API down.
      req.log?.warn({ err }, 'rate limiter unavailable, allowing request');
    }
    return next();
  };
}

export async function closeRateLimiter() {
  await redis.quit();
}
