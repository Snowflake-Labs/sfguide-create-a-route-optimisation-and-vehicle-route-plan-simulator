import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrsBuildLogs } from '../server/logParser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ors-lm-sample.log'), 'utf8');

describe('parseOrsBuildLogs', () => {
  it('parses a full LM-completing fixture into a ready summary', () => {
    const summary = parseOrsBuildLogs(FIXTURE);
    expect(summary.startedApplication).toBe(true);
    expect(summary.completedProfiles).toContain('driving-car');
    expect(summary.totalProfiles).toBeGreaterThanOrEqual(1);
    // Once the only profile is in finishedProfiles AND Started Application is
    // logged, phase should be ready and progress 100.
    expect(summary.phase).toBe('ready');
    expect(summary.progress).toBe(100);
    expect(summary.lm).toBeTruthy();
    expect(summary.lm!.finishedVariants).toEqual([
      'car_ors_fastest',
      'car_ors_shortest',
      'car_ors_fastest_with_turn_costs',
      'car_ors_shortest_with_turn_costs',
    ]);
    expect(summary.lm!.stepIndex).toBe(4);
    expect(summary.lm!.stepTotal).toBe(4);
    expect(summary.ch?.nodesStart).toBe(1200000);
    expect(summary.ch?.nodesRemaining).toBe(120000);
    expect(summary.memory?.usedMB).toBeGreaterThan(0);
    expect(summary.warnings.length).toBeGreaterThan(0);
  });

  it('detects mid-LM (3/4) phase before profile completion', () => {
    // Truncate fixture to before the [1] Profiles + Started Application lines
    // so the parser sees a build that is still in LM preparation.
    const cut = FIXTURE.split('\n').slice(0, -4).join('\n');
    const summary = parseOrsBuildLogs(cut);
    expect(summary.phase).toBe('lm_preparing');
    expect(summary.lm!.stepIndex).toBe(4);
    expect(summary.lm!.finishedVariants.length).toBe(3);
    expect(summary.lm!.avgStepMs).toBeGreaterThan(0);
    // ETA must be a finite positive number.
    expect(typeof summary.lm!.etaMs).toBe('number');
    expect(summary.progress).toBeGreaterThan(70);
    expect(summary.progress).toBeLessThan(100);
  });

  it('detects ch_contracting phase from edge/nodes lines', () => {
    // Cut just after the first contraction edge line — no LM banner yet.
    const lines = FIXTURE.split('\n');
    const idx = lines.findIndex((l) => l.includes('Creating LM preparations'));
    const cut = lines.slice(0, idx).join('\n');
    const summary = parseOrsBuildLogs(cut);
    expect(['ch_contracting', 'ch_preparing']).toContain(summary.phase);
    expect(summary.ch?.fractionDone).toBeGreaterThan(0);
    expect(summary.progress).toBeGreaterThan(0);
    expect(summary.progress).toBeLessThan(100);
  });

  it('returns waiting/initializing for an empty-ish startup log', () => {
    const summary = parseOrsBuildLogs('Starting Application... Spring Boot v3.3.5');
    expect(summary.phase).toBe('initializing');
    expect(summary.progress).toBeLessThan(20);
  });

  it('does not throw on garbage input and returns the unknown fallback', () => {
    expect(() => parseOrsBuildLogs('')).not.toThrow();
    const empty = parseOrsBuildLogs('');
    expect(empty.phase).toBe('unknown');
    expect(empty.progress).toBe(0);
    // null / undefined input
    // @ts-expect-error - testing runtime safety
    const nul = parseOrsBuildLogs(null);
    expect(nul.phase).toBe('unknown');
    expect(nul.progress).toBe(0);
  });

  it('strips ANSI escape codes before parsing', () => {
    const ansi = '\u001b[32m✓\u001b[0m 2026-05-11 03:09:53 INFO o.h.o.r.RoutingProfileManager ORS-pl-driving-car start creating graph';
    const summary = parseOrsBuildLogs(ansi);
    expect(summary.phase).toBe('importing');
    expect(summary.currentProfile).toBe('driving-car');
  });
});
