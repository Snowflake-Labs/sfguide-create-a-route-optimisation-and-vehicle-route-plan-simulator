export interface PageDef {
  id: string;
  path: string;
  title: string;
  parent?: string;
}

export interface DemoRegistration {
  demo_id: string;
  display_name: string;
  description: string;
  icon: string;
  sort_order: number;
  source_db: string;
  source_schema: string;
  pages: PageDef[];
  requires_ors: boolean;
  installed: boolean;
  installed_at: string;
  version: string;
  config: Record<string, any>;
}

export interface OrsStatus {
  installed: boolean;
  status: 'available' | 'not_installed' | 'unknown' | 'starting';
  region?: string;
  profiles?: string[];
  bounds?: {
    center: { lat: number; lng: number };
    min: { lat: number; lng: number };
    max: { lat: number; lng: number };
  };
  availableRegions?: string[];
}
