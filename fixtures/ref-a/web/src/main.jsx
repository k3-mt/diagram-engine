import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { listOrders, whoami } from './api.js';

function OrderList() {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    listOrders().then(setOrders).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  return (
    <ul className="orders">
      {orders.map((o) => (
        <li key={o.id}>
          <Link to={`/orders/${o.id}`}>{o.reference}</Link>
          <span className="status">{o.status}</span>
        </li>
      ))}
    </ul>
  );
}

function App() {
  const [user, setUser] = useState(null);
  useEffect(() => {
    whoami().then(setUser).catch(() => setUser(null));
  }, []);

  return (
    <BrowserRouter>
      <header>Sparrow {user ? `— ${user.email}` : ''}</header>
      <Routes>
        <Route path="/" element={<OrderList />} />
        <Route path="/orders/:id" element={<OrderList />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(<App />);
