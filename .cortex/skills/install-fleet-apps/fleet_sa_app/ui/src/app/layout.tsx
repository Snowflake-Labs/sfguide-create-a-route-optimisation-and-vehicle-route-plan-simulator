import type { Metadata } from 'next';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import './globals.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const configPath = process.env.APP_CONFIG;
  if (configPath) {
    try {
      const fullPath = configPath.startsWith('/') ? configPath : resolve(process.cwd(), configPath);
      const raw = JSON.parse(readFileSync(fullPath, 'utf-8'));
      return {
        title: raw.name || 'Data App',
        description: raw.description || 'Snowflake Data App',
      };
    } catch {}
  }
  return { title: 'Data App', description: 'Snowflake Data App' };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
