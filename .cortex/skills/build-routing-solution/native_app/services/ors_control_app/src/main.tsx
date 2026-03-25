import React from 'react';
import ReactDOM from 'react-dom/client';
import { luma } from '@luma.gl/core';
import { webgl2Adapter } from '@luma.gl/webgl';
import App from './App';

luma.registerAdapters([webgl2Adapter]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
