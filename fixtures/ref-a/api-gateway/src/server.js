// Sparrow API gateway. It owns three things and nothing else: rate limiting,
// session introspection, and routing. All business logic is downstream.

import express from 'express';
import pino from 'pino';
import { config } from './config.js';
import { rateLimit, closeRateLimiter } from './ratelimit.js';
import { authProxy } from './routes/auth.js';
import { ordersProxy, requireSession } from './routes/orders.js';

const log = pino({ name: 'api-gateway' });
const app = express();

app.disable('x-powered-by');
app.use((req, _res, next) => {
  req.log = log;
  next();
});

// The edge tier polls this. Keep it above the rate limiter or a burst of real
// traffic will make us look unhealthy and get us pulled out of rotation.
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.use(rateLimit());
app.use('/auth', authProxy);
app.use('/orders', requireSession, ordersProxy);

app.use((_req, res) => res.status(404).json({ error: 'no such route' }));

const server = app.listen(config.port, () => {
  log.info({ port: config.port, auth: config.authUrl, orders: config.ordersUrl }, 'listening');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await closeRateLimiter();
    process.exit(0);
  });
}
