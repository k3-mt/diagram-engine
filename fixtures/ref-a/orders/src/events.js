// Order events. One topic, keyed by order id so that all events for an order
// land on one partition and stay ordered.
//
// This is the only thing orders publishes, and it publishes nothing else.

import { Kafka } from 'kafkajs';

const kafka = new Kafka({
  clientId: 'orders',
  brokers: (process.env.KAFKA_BROKERS || '').split(',').filter(Boolean),
});

const producer = kafka.producer({ allowAutoTopicCreation: false });
const topic = process.env.ORDER_EVENTS_TOPIC || 'order.events.v1';

let connected = false;

export async function connectProducer() {
  if (!connected) {
    await producer.connect();
    connected = true;
  }
}

export async function publishOrderPlaced(order, lines) {
  await connectProducer();
  await producer.send({
    topic,
    messages: [
      {
        key: order.id,
        headers: { 'event-type': 'order.placed', 'schema-version': '1' },
        value: JSON.stringify({
          type: 'order.placed',
          orderId: order.id,
          reference: order.reference,
          userId: order.user_id,
          totalCents: order.total_cents,
          lines,
          occurredAt: new Date().toISOString(),
        }),
      },
    ],
  });
}

export async function closeProducer() {
  if (connected) await producer.disconnect();
}
