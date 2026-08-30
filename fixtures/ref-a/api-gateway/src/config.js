// One place where the environment is read. Nothing else in the gateway
// touches process.env, so what this file lists is the whole contract with
// docker-compose.yml.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 8080),

  // Downstream services. Both are plain http inside the internal network.
  authUrl: required('AUTH_URL'),
  ordersUrl: required('ORDERS_URL'),

  // Rate limiter state.
  redisUrl: required('REDIS_URL'),
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN || 600),

  // The edge tier rewrites the client address into this header before the
  // request reaches us. Never trust it on a request that arrived on the
  // internal network.
  trustProxyHeader: process.env.TRUST_PROXY_HEADER || 'X-Forwarded-For',
};
