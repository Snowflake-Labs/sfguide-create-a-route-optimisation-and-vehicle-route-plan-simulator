import { useState } from 'react';
import ServiceManager from './components/ServiceManager';
import CityProvisioner from './components/CityProvisioner';
import MatrixBuilder from './components/MatrixBuilder';
import MatrixViewer from './components/MatrixViewer';
import FunctionTester from './components/FunctionTester';

type Tab = 'services' | 'cities' | 'matrix' | 'viewer' | 'functions';

export default function App() {
  const [tab, setTab] = useState<Tab>('services');

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <svg viewBox="0 0 24 24" fill="none" width="28" height="28">
            <path d="M12 2L3 7v10l9 5 9-5V7l-9-5z" stroke="#FF6B35" strokeWidth="1.5" fill="none" />
            <path d="M12 7l-5 3v6l5 3 5-3v-6l-5-3z" fill="#FF6B35" opacity="0.3" />
            <circle cx="12" cy="12" r="2" fill="#FF6B35" />
          </svg>
          <span>OpenRouteService Control</span>
        </div>
        <nav className="app-tabs">
          <button className={`tab ${tab === 'services' ? 'active' : ''}`} onClick={() => setTab('services')}>Services</button>
          <button className={`tab ${tab === 'cities' ? 'active' : ''}`} onClick={() => setTab('cities')}>Cities</button>
          <button className={`tab ${tab === 'matrix' ? 'active' : ''}`} onClick={() => setTab('matrix')}>Matrix Builder</button>
          <button className={`tab ${tab === 'viewer' ? 'active' : ''}`} onClick={() => setTab('viewer')}>Matrix Viewer</button>
          <button className={`tab ${tab === 'functions' ? 'active' : ''}`} onClick={() => setTab('functions')}>Functions</button>
        </nav>
      </header>
      <main className="app-main">
        {tab === 'services' && <ServiceManager />}
        {tab === 'cities' && <CityProvisioner />}
        {tab === 'matrix' && <MatrixBuilder />}
        {tab === 'viewer' && <MatrixViewer />}
        {tab === 'functions' && <FunctionTester />}
      </main>
    </div>
  );
}
