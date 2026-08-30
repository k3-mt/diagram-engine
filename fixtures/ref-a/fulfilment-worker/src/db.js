// The worker writes `fulfilments` and moves `orders.status` forward. Both
// tables belong to the orders service; the worker is allowed to write them
// because it is the same bounded context, running out of process.

import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
});

export async function recordFulfilment(orderId, warehouse) {
  const { rows } = await pool.query(
    `insert into fulfilments (order_id, warehouse, picked_at)
     values ($1, $2, now())
     on conflict (order_id) do nothing
     returning id`,
    [orderId, warehouse],
  );
  return rows[0] || null;
}

export async function markPicking(orderId) {
  await pool.query(
    `update orders set status = 'picking', updated_at = now()
      where id = $1 and status = 'placed'`,
    [orderId],
  );
}

export async function replayableOrders(sinceIso) {
  const { rows } = await pool.query(
    `select o.id from orders o
       left join fulfilments f on f.order_id = o.id
      where f.id is null and o.created_at >= $1`,
    [sinceIso],
  );
  return rows.map((r) => r.id);
}
