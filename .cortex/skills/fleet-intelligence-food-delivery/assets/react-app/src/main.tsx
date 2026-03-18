import React from 'react';
import ReactDOM from 'react-dom/client';
import { webgl2Adapter } from '@luma.gl/webgl';
import { luma } from '@luma.gl/core';
import App from './App';
import './styles/global.css';

luma.registerAdapters([webgl2Adapter]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
