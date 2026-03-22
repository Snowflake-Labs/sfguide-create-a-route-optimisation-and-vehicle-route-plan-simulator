import React from 'react';

interface Props {
  onMatrixBuilder?: () => void;
  onDataBuilder?: () => void;
}

export default function Header({ onMatrixBuilder, onDataBuilder }: Props) {
  return (
    <div className="header">
      <div className="header-logo">
        <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="40" height="40" rx="6" fill="#FF6B35" />
          <circle cx="13" cy="30" r="3.5" stroke="white" strokeWidth="1.8" fill="none" />
          <circle cx="27" cy="30" r="3.5" stroke="white" strokeWidth="1.8" fill="none" />
          <path d="M16.5 30H23.5" stroke="white" strokeWidth="1.8" />
          <path d="M13 26.5V18L20 14V22" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M20 22L27 26.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
          <rect x="16" y="12" width="8" height="6" rx="1.5" stroke="white" strokeWidth="1.5" fill="none" />
          <path d="M18 15H22" stroke="white" strokeWidth="1" strokeLinecap="round" />
          <path d="M30 10L32 8M30 8L32 10" stroke="#FFD700" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M8 12L10 10M8 10L10 12" stroke="#FFD700" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="header-title">Yum Drop Online Food Deliveries</span>
      </div>
      <div className="header-actions">
        {onDataBuilder && (
          <button className="header-matrix-btn" onClick={onDataBuilder}>
            <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
              <path d="M3 3h14v14H3z" stroke="#FF6B35" strokeWidth="1.5" fill="none" />
              <path d="M7 10h6M10 7v6" stroke="#FF6B35" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Data Builder
          </button>
        )}
        {onMatrixBuilder && (
          <button className="header-matrix-btn" onClick={onMatrixBuilder}>
            <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
              <rect x="1" y="1" width="7" height="7" rx="1" fill="#FF6B35" opacity="0.8" />
              <rect x="12" y="1" width="7" height="7" rx="1" fill="#FF6B35" opacity="0.5" />
              <rect x="1" y="12" width="7" height="7" rx="1" fill="#FF6B35" opacity="0.5" />
              <rect x="12" y="12" width="7" height="7" rx="1" fill="#FF6B35" opacity="0.3" />
            </svg>
            Matrix Builder
          </button>
        )}
        <div className="header-badge">
          <img src="/snowflake-logo.png" alt="Snowflake" style={{ height: 22 }} />
        </div>
      </div>
    </div>
  );
}
