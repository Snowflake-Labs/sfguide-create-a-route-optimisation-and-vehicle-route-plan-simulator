// Types lifted from RegionBuilder.tsx so hooks and section components can
// share them without re-importing the whole orchestrator.

export type HealthStatus = {
  overall: string;
  status: Record<string, string>;
  errors?: Record<string, string>;
};

export type BuildHistoryRow = {
  BUILD_ID?: string;
  REGION?: string;
  INSTANCE_FAMILY?: string;
  COMPUTE_SIZE?: string;
  PROFILES?: string;
  JVM_XMX_GIB?: number;
  STARTED_AT?: string;
  FINISHED_AT?: string;
  ELAPSED_MINUTES?: number;
  EXIT_STATUS?: string;
  PEAK_RSS_GIB?: number | null;
  OUTPUT_GRAPH_GIB?: number | null;
};

export type BuildProgress = {
  phase: string;
  progress: number;
  profileProgress?: number;
  nodesRemaining?: number;
  nodesTotal?: number;
  currentProfile?: string | null;
  completedProfiles?: string[];
  totalProfiles?: number;
  detail?: string;
  // LM preparation progress in N/M form, parsed from "Calling LM prepare.doWork
  // on N/M landmark sets" (#40). Present only while phase is 'building' and the
  // current profile is mid-LM.
  lmCurrent?: number;
  lmTotal?: number;
};

export type DiagEntry = {
  loading: boolean;
  markdown?: string;
  error?: string;
  raw?: any;
  expanded: boolean;
};

export type DiagState = Record<string, DiagEntry>;
