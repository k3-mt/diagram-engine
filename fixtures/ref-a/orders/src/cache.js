// Read-through cache for the order list. Short TTL, and an explicit bust on
// write, because a customer who has just placed an order will reload the page
// within a second and must see it.

import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const TTL_SECONDS = 30;

const key = (userId) => `orders:list:${userId}`;

export async function readList(userId) {
  const hit = await redis.get(key(userId));
  return hit ? JSON.parse(hit) : null;
}

export async function writeList(userId, orders) {
  await redis.setex(key(userId), TTL_SECONDS, JSON.stringify(orders));
}

export async function bust(userId) {
  await redis.del(key(userId));
}

export async function closeCache() {
  await redis.quit();
}
