// Thin fetch wrapper. Every call in the app goes through here, and every call
// goes to /api — nginx proxies that to the gateway. No service hostname is
// ever compiled into the bundle.

const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    window.location.assign('/login');
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export const login = (email, password) =>
  request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const whoami = () => request('/auth/me');

export const listOrders = () => request('/orders');

export const getOrder = (id) => request(`/orders/${id}`);

export const placeOrder = (lines) =>
  request('/orders', { method: 'POST', body: JSON.stringify({ lines }) });
