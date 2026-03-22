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
          <img src="/snowflake_h3.png" style={{ height: 36, objectFit: 'contain' }} alt="Snowflake" />
          <span>Routing Service</span>
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
