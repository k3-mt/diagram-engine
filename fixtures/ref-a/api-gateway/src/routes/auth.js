// /auth/* is proxied straight through to the auth service. The gateway does
// not parse credentials and does not verify tokens itself; it forwards and
// lets auth answer.

import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from '../config.js';

export const authProxy = createProxyMiddleware({
  target: config.authUrl,
  changeOrigin: false,
  pathRewrite: { '^/auth': '' },
  on: {
    proxyReq: (proxyReq, req) => {
      const forwarded = req.get(config.trustProxyHeader);
      if (forwarded) proxyReq.setHeader(config.trustProxyHeader, forwarded);
    },
  },
});
