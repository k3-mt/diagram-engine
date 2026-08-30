// Sparrow orders. Reads and writes the order tables, caches the list view, and
// publishes an event when an order is placed. It never calls another service:
// the user id it works with is resolved upstream and arrives on a header.

import express from 'express';
import pino from 'pino';
import { listOrders, getOrder, insertOrder } from './db.js';
import { readList, writeList, bust, closeCache } from './cache.js';
import { publishOrderPlaced, closeProducer } from './events.js';

const log = pino({ name: 'orders' });
const app = express();
app.use(express.json());

// The gateway sets this after introspecting the session. If it is absent the
// request did not come through the gateway, and we refuse it.
function userId(req) {
  const id = req.get('x-sparrow-user');
  if (!id) {
    const err = new Error('missing x-sparrow-user');
    err.status = 401;
    throw err;
  }
  return id;
}

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/', async (req, res, next) => {
  try {
    const uid = userId(req);
    const cached = await readList(uid);
    if (cached) return res.json(cached);

    const orders = await listOrders(uid);
    await writeList(uid, orders);
    return res.json(orders);
  } catch (err) {
    return next(err);
  }
});

app.get('/:id', async (req, res, next) => {
  try {
    const order = await getOrder(userId(req), req.params.id);
    return order ? res.json(order) : res.status(404).json({ error: 'no such order' });
  } catch (err) {
    return next(err);
  }
});

app.post('/', async (req, res, next) => {
  try {
    const uid = userId(req);
    const lines = req.body?.lines || [];
    if (lines.length === 0) return res.status(400).json({ error: 'an order needs lines' });

    const order = await insertOrder(uid, lines);
    await bust(uid);
    await publishOrderPlaced({ ...order, user_id: uid }, lines);
    log.info({ orderId: order.id }, 'order placed');
    return res.status(201).json(order);
  } catch (err) {
    return next(err);
  }
});

app.use((err, _req, res, _next) => {
  log.error({ err: err.message }, 'request failed');
  res.status(err.status || 500).json({ error: err.message });
});

const server = app.listen(Number(process.env.PORT || 3002), () => log.info('orders listening'));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await Promise.all([closeCache(), closeProducer()]);
    process.exit(0);
  });
}
