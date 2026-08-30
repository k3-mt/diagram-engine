// Sparrow fulfilment worker.
//
// Mostly a kafka consumer. It also exposes a tiny admin surface on :3003 for
// on-call replay, which is why it needs to check bearer tokens.

import express from 'express';
import pino from 'pino';
import { start as startConsumer, stop as stopConsumer, handleEvent } from './consumer.js';
import { serviceToken, validateToken } from './auth-client.js';
import { replayableOrders } from './db.js';

const log = pino({ name: 'fulfilment-worker' });
const app = express();
app.use(express.json());

// Ops hits this by hand. Anything that can re-drive fulfilments has to be
// authenticated, so the token goes to auth and auth decides.
app.post('/admin/replay', async (req, res) => {
  const bearer = (req.get('authorization') || '').replace(/^Bearer /i, '');
  const check = await validateToken(bearer, 'fulfilment:replay');
  if (!check.active) return res.status(403).json({ error: 'forbidden' });

  const since = req.body?.since || new Date(Date.now() - 86_400_000).toISOString();
  const ids = await replayableOrders(since);
  for (const id of ids) {
    await handleEvent({ type: 'order.placed', orderId: id }, log);
  }
  log.warn({ by: check.sub, count: ids.length }, 'manual replay');
  return res.json({ replayed: ids.length });
});

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

async function main() {
  // Fail fast at boot if our own credentials are wrong, rather than at 3am on
  // the first outbound call.
  await serviceToken();
  await startConsumer(log);
  app.listen(3003, () => log.info('admin surface listening on 3003'));
}

main().catch((err) => {
  log.fatal({ err: err.message }, 'worker failed to start');
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await stopConsumer();
    process.exit(0);
  });
}
