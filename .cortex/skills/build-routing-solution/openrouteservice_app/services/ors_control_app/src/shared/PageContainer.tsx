import React from 'react';

interface Props {
  children: React.ReactNode;
  width?: 'narrow' | 'wide' | 'full';
  padded?: boolean;
  className?: string;
}

export default function PageContainer({
  children,
  width = 'wide',
  padded = true,
  className = '',
}: Props) {
  const cls = [
    'page-scroll',
    padded && 'page-scroll--padded',
    width === 'narrow' && 'page-scroll--narrow',
    width === 'wide' && 'page-scroll--wide',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <div className={cls}>{children}</div>;
}
