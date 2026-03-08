import React from 'react';

export default function Header() {
  return (
    <div className="header">
      <div className="header-logo">
        <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="40" height="40" rx="6" fill="#FF6B35" />
          <path d="M10 28L14 12H20L24 20L28 12H34" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="14" cy="28" r="3" fill="white" />
          <circle cx="28" cy="28" r="3" fill="white" />
        </svg>
        <span className="header-title">SwiftBite Fleet Intelligence</span>
        <span className="header-subtitle">California Delivery Operations</span>
      </div>
      <div className="header-badge">
        <span>Powered by</span>
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="#29B5E8" />
          <path d="M2 17L12 22L22 17" stroke="#29B5E8" strokeWidth="2" />
          <path d="M2 12L12 17L22 12" stroke="#29B5E8" strokeWidth="2" />
        </svg>
        <span style={{ fontWeight: 700, color: '#29B5E8' }}>Snowflake</span>
      </div>
    </div>
  );
}
