import React from 'react';
import ReactDOM from 'react-dom/client';
import { luma } from '@luma.gl/core';
import { webgl2Adapter } from '@luma.gl/webgl';
import App from './App';

luma.registerAdapters([webgl2Adapter]);

const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.status === 401 || response.status === 403) {
    const cloned = response.clone();
    try {
      const body = await cloned.json();
      if (body?.detail?.includes('CSRF') || body?.responseType === 'ERROR') {
        console.warn('[Auth] CSRF/session expired — reloading');
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch {}
  }
  return response;
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

