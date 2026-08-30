// Orders owns `orders` and `order_lines` (migrations/001_orders.sql). It reads
// no auth table: the caller's identity arrives on the x-sparrow-user header,
// already resolved by the gateway.

import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
});

export async function listOrders(userId) {
  const { rows } = await pool.query(
    `select id, reference, status, total_cents, created_at
       from orders
      where user_id = $1
      order by created_at desc
      limit 100`,
    [userId],
  );
  return rows;
}

export async function getOrder(userId, id) {
  const { rows } = await pool.query(
    `select o.id, o.reference, o.status, o.total_cents,
            coalesce(json_agg(l.*) filter (where l.id is not null), '[]') as lines
       from orders o
       left join order_lines l on l.order_id = o.id
      where o.id = $1 and o.user_id = $2
      group by o.id`,
    [id, userId],
  );
  return rows[0] || null;
}

// One transaction: the order and its lines are written together or not at all.
export async function insertOrder(userId, lines) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const total = lines.reduce((sum, l) => sum + l.unit_price_cents * l.quantity, 0);
    const { rows } = await client.query(
      `insert into orders (user_id, reference, status, total_cents)
       values ($1, 'SPW-' || upper(substr(md5(random()::text), 1, 8)), 'placed', $2)
       returning id, reference, status, total_cents`,
      [userId, total],
    );
    const order = rows[0];
    for (const line of lines) {
      await client.query(
        `insert into order_lines (order_id, sku, quantity, unit_price_cents)
         values ($1, $2, $3, $4)`,
        [order.id, line.sku, line.quantity, line.unit_price_cents],
      );
    }
    await client.query('commit');
    return order;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
