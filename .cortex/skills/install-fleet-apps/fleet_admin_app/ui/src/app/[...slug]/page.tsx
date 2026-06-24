import { AppShell } from '@/components/app-shell';

// The admin app is a single-page shell whose sidebar pushes deep-link URLs
// (/regions, /studio, /matrix/builder, ...) via window.history.pushState. Only
// `/` is a real Next route, so a hard navigation or post-OAuth redirect to any
// sub-path would otherwise hit the standalone server with no matching route and
// return a 404. This catch-all serves the same shell for every non-API path;
// AppShell's pathToTab() then resolves the URL to the correct tab on mount.
// /api/* handlers and /_next/* assets take precedence over this catch-all.
export const dynamic = 'force-dynamic';

export default function CatchAllPage() {
  return <AppShell />;
}
