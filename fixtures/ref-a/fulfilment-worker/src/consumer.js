// Consumes order.events.v1 and turns an order.placed event into a fulfilment
// row plus a status transition. Idempotent: the unique index on
// fulfilments.order_id means a redelivered event is a no-op.

import { Kafka } from 'kafkajs';
import { recordFulfilment, markPicking } from './db.js';

const kafka = new Kafka({
  clientId: 'fulfilment-worker',
  brokers: (process.env.KAFKA_BROKERS || '').split(',').filter(Boolean),
});

const consumer = kafka.consumer({
  groupId: process.env.CONSUMER_GROUP || 'fulfilment-worker',
  sessionTimeout: 30_000,
});

const topic = process.env.ORDER_EVENTS_TOPIC || 'order.events.v1';

// One warehouse for now. Routing by postcode is the next thing on the board.
const WAREHOUSE = 'wh-leeds-1';

export async function handleEvent(event, log) {
  if (event.type !== 'order.placed') return;
  const inserted = await recordFulfilment(event.orderId, WAREHOUSE);
  if (!inserted) {
    log.debug({ orderId: event.orderId }, 'already fulfilled, skipping');
    return;
  }
  await markPicking(event.orderId);
  log.info({ orderId: event.orderId, reference: event.reference }, 'fulfilment opened');
}

export async function start(log) {
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        await handleEvent(JSON.parse(message.value.toString()), log);
      } catch (err) {
        log.error({ err: err.message }, 'event handling failed');
        throw err;
      }
    },
  });
  log.info({ topic }, 'consuming');
}

export async function stop() {
  await consumer.disconnect();
}
