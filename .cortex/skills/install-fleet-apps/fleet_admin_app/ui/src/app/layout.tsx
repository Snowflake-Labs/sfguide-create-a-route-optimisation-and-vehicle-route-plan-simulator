import type { Metadata } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Fleet Admin — Routing Platform',
  description: 'Privileged build & operations console for the routing substrate (region builder, matrix builder, function tester, Data Studio, observability).',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
