// main.tsx — viewer entry point. For M2/M3 it mounts the DEBUG renderer
// (grey boxes, fixture picker); M4 replaces this with the product renderer.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DebugCanvas } from './debug/DebugCanvas.js';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root element in index.html');

createRoot(el).render(
  <StrictMode>
    <DebugCanvas />
  </StrictMode>,
);
