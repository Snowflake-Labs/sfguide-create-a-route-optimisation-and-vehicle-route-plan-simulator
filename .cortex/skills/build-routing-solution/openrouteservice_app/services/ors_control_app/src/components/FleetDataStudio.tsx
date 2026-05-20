import { useEffect, useRef, useState } from 'react';
import MetricCard from '../shared/MetricCard';

import {
  Preset, ProfileTemplate, SKILL_MAP, VEHICLE_LABELS,
} from './fleet-data-studio/helpers';
import type { EditConfig } from './fleet-data-studio/types';
import { useStudioCatalog } from './fleet-data-studio/hooks/useStudioCatalog';
import { useStudioJobs } from './fleet-data-studio/hooks/useStudioJobs';
import { useStudioStream } from './fleet-data-studio/hooks/useStudioStream';
import { useJobDetail } from './fleet-data-studio/hooks/useJobDetail';

import ProfilePickerPanel from './fleet-data-studio/panels/ProfilePickerPanel';
import ConfigEditorPanel from './fleet-data-studio/panels/ConfigEditorPanel';
import GenerationDashboardPanel from './fleet-data-studio/panels/GenerationDashboardPanel';
import JobHistoryTable from './fleet-data-studio/panels/JobHistoryTable';
import JobDetailDrawer from './fleet-data-studio/panels/JobDetailDrawer';

export default function FleetDataStudio() {
  const catalog = useStudioCatalog();
  const jobsHook = useStudioJobs();
  const stream = useStudioStream(
    { fetchJobs: jobsHook.fetchJobs, fetchStats: catalog.fetchStats, fetchCoverage: catalog.fetchCoverage },
    jobsHook.setActiveJobs,
  );
  const detail = useJobDetail();

  // Form state lives in the orchestrator so it can mutate from both
  // template + preset selection paths.
  const [selectedTemplate, setSelectedTemplate] = useState<ProfileTemplate | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [editConfig, setEditConfig] = useState<EditConfig>(null);
  const [editName, setEditName] = useState('');
  const [editRegion, setEditRegion] = useState('SanFrancisco');
  const [editProfile, setEditProfile] = useState('driving-car');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['fleet', 'time']));
  const [deletingJob, setDeletingJob] = useState<string | null>(null);
  const [cancellingJob, setCancellingJob] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const detailLogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [stream.logLines]);

  useEffect(() => {
    if (detailLogRef.current) detailLogRef.current.scrollTop = detailLogRef.current.scrollHeight;
  }, [detail.detailLines]);

  const selectTemplate = (t: ProfileTemplate) => {
    setSelectedTemplate(t);
    setSelectedPreset(null);
    setEditConfig(t.defaultConfig ? JSON.parse(JSON.stringify(t.defaultConfig)) : {});
    setEditName(t.name);
    setEditRegion(t.defaultConfig?.region || 'SanFrancisco');
    setEditProfile(t.orsProfile);
  };

  const selectPreset = (p: Preset) => {
    setSelectedPreset(p);
    setSelectedTemplate(null);
    setEditConfig(p.config ? JSON.parse(JSON.stringify(p.config)) : {});
    setEditName(p.name);
    setEditRegion(p.region);
    setEditProfile(p.ors_profile);
  };

  const toggleSection = (s: string) => {
    setExpandedSections((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  };

  const updateConfig = (path: string, value: any) => {
    setEditConfig((prev: any) => {
      const next = JSON.parse(JSON.stringify(prev || {}));
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const startGeneration = async () => {
    stream.setGenerating(true);
    stream.setLogLines(['Starting generation...']);
    stream.resetForStart();
    try {
      const body = selectedPreset
        ? { preset_id: selectedPreset.preset_id }
        : {
            config: {
              ...editConfig,
              region: editRegion,
              ors_profile: editProfile,
              vehicleType: selectedTemplate?.vehicleType || (editProfile === 'cycling-electric' ? 'ebike' : editProfile === 'driving-hgv' ? 'hgv' : 'car'),
              // bbox intentionally omitted: server resolves it from
              // REGION_REGISTRY/REGION_CATALOG by region name.
            },
            preset_name: editName,
          };
      const res = await fetch('/api/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        const err = await res.json();
        stream.setLogLines((prev) => [...prev, `Cannot start: ${err.error}`]);
        stream.setGenerating(false);
        return;
      }
      if (!res.ok) {
        const err = await res.json();
        stream.setLogLines((prev) => [...prev, `Error: ${err.error || res.statusText}`]);
        stream.setGenerating(false);
        return;
      }
      const { job_id } = await res.json();
      stream.setLogLines((prev) => [...prev, `Job started: ${job_id}`]);
      stream.connectSSE(job_id);
      jobsHook.fetchJobs();
    } catch (err: any) {
      stream.setLogLines((prev) => [...prev, `Error: ${err.message}`]);
      stream.setGenerating(false);
    }
  };

  const cancelActiveJob = async () => {
    const running = jobsHook.activeJobs.find((j) => j.status === 'RUNNING');
    if (running) {
      await fetch(`/api/studio/jobs/${running.jobId}/cancel`, { method: 'POST' });
    }
  };

  const cancelJobById = async (jobId: string) => {
    if (!confirm('Cancel this running generation job? Partial data will remain in tables until you delete it.')) return;
    setCancellingJob(jobId);
    try {
      const res = await fetch(`/api/studio/jobs/${jobId}/cancel`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Cancel failed (${body.mode || 'unknown'}): ${body.message || 'See server logs.'}`);
      }
      jobsHook.fetchJobs(); catalog.fetchStats();
    } catch (e: any) {
      alert(`Cancel failed: ${e.message}`);
    } finally {
      setCancellingJob(null);
    }
  };

  const deleteJobData = async (jobId: string) => {
    if (!confirm(`Delete all generated data for this job? This cannot be undone.`)) return;
    setDeletingJob(jobId);
    try {
      const res = await fetch(`/api/studio/jobs/${jobId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        alert(`Delete failed: ${err.error}`);
        return;
      }
      jobsHook.fetchJobs(); catalog.fetchStats(); catalog.fetchCoverage();
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    } finally {
      setDeletingJob(null);
    }
  };

  const savePreset = async () => {
    try {
      await fetch('/api/studio/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, ors_profile: editProfile, region: editRegion, config: editConfig }),
      });
      catalog.fetchPresets();
    } catch (e: any) {
      console.error('Failed to save preset:', e);
    }
  };

  // Derived stats for header + dashboard panel.
  const safeStats = Array.isArray(catalog.stats) ? catalog.stats : [];
  const totalPoints = safeStats.reduce((s: number, r: any) => s + Number(r.POINT_COUNT || 0), 0);
  const totalVehicles = safeStats.reduce((s: number, r: any) => s + Number(r.VEHICLES || 0), 0);
  const totalTrips = safeStats.reduce((s: number, r: any) => s + Number(r.TRIPS || 0), 0);
  const profileData = safeStats.map((r: any) => ({
    name: VEHICLE_LABELS[r.VEHICLE_TYPE] || r.ORS_PROFILE,
    value: Number(r.POINT_COUNT || 0),
    vehicleType: r.VEHICLE_TYPE,
  }));

  const hasAnyData = (catalog.coverage || []).some((c) => c.TELEMETRY_ROWS > 0);
  const skillsReady = hasAnyData
    ? Object.keys(SKILL_MAP).reduce((acc, id) => ({ ...acc, [id]: true }), {} as Record<string, boolean>)
    : ({} as Record<string, boolean>);

  return (
    <div className="page-dashboard data-studio">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Data Studio</h2>
      <p style={{ color: '#6E7681', fontSize: 13, marginBottom: 16 }}>Generate unified fleet telemetry and trip data for all movement-data skills</p>

      <div className="metric-grid">
        <MetricCard label="Total Points" value={totalPoints.toLocaleString()} />
        <MetricCard label="Total Trips" value={totalTrips.toLocaleString()} />
        <MetricCard label="Vehicles" value={totalVehicles} />
        <MetricCard label="Jobs Run" value={jobsHook.jobHistory.length} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginTop: 16 }}>
        <ProfilePickerPanel
          templates={catalog.templates}
          presets={catalog.presets}
          selectedTemplate={selectedTemplate}
          selectedPreset={selectedPreset}
          skillsReady={skillsReady}
          onSelectTemplate={selectTemplate}
          onSelectPreset={selectPreset}
        />

        <ConfigEditorPanel
          editConfig={editConfig}
          editName={editName}
          editRegion={editRegion}
          editProfile={editProfile}
          availableRegions={catalog.availableRegions}
          expandedSections={expandedSections}
          toggleSection={toggleSection}
          updateConfig={updateConfig}
          setEditName={setEditName}
          setEditRegion={setEditRegion}
          setEditProfile={setEditProfile}
          selectedTemplate={selectedTemplate}
          selectedPreset={selectedPreset}
          generating={stream.generating}
          onStart={startGeneration}
          onCancelActive={cancelActiveJob}
          onSave={savePreset}
        />

        <GenerationDashboardPanel
          activeJobs={jobsHook.activeJobs}
          logLines={stream.logLines}
          logRef={logRef}
          coverage={catalog.coverage}
          skillsReady={skillsReady}
          profileData={profileData}
        />
      </div>

      <JobHistoryTable
        jobHistory={jobsHook.jobHistory}
        cancellingJob={cancellingJob}
        deletingJob={deletingJob}
        onOpenDetail={detail.openJobDetail}
        onCancelJobById={cancelJobById}
        onDeleteJobData={deleteJobData}
      />

      <JobDetailDrawer
        selectedJobId={detail.selectedJobId}
        detailMeta={detail.detailMeta}
        detailLines={detail.detailLines}
        detailLoading={detail.detailLoading}
        detailLogRef={detailLogRef}
        onClose={detail.closeJobDetail}
      />
    </div>
  );
}
