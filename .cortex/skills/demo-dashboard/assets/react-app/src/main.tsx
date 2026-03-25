import React from 'react';
import ReactDOM from 'react-dom/client';
import { luma } from '@luma.gl/core';
import { webgl2Adapter } from '@luma.gl/webgl';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';

luma.registerAdapters([webgl2Adapter]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
