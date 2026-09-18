import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Viewer } from './Viewer.js';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

createRoot(container).render(
  <StrictMode>
    <Viewer />
  </StrictMode>,
);
