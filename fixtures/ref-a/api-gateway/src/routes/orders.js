// /orders/* requires a session. We ask auth to introspect the cookie, then
// forward to the orders service with the resolved user id attached, so orders
// never has to know how a session is represented.

import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from '../config.js';

export async function requireSession(req, res, next) {
  const cookie = req.get('cookie');
  if (!cookie) return res.status(401).json({ error: 'no session' });

  const introspect = await fetch(`${config.authUrl}/introspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookie }),
  });

  if (!introspect.ok) return res.status(401).json({ error: 'invalid session' });
  const { userId } = await introspect.json();
  req.userId = userId;
  return next();
}

export const ordersProxy = createProxyMiddleware({
  target: config.ordersUrl,
  changeOrigin: false,
  on: {
    proxyReq: (proxyReq, req) => {
      if (req.userId) proxyReq.setHeader('x-sparrow-user', req.userId);
    },
  },
});
