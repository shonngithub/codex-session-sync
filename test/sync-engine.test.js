// test/sync-engine.test.js
import { describe, test, expect } from '@jest/globals';
import { buildPlan } from '../src/sync-engine.js';

const BASE_CONFIG = {
  sync: { compare: 'mtime', time_tolerance_seconds: 2, equal_mtime_action: 'skip' },
  conflict: { policy: 'manual_abort' },
};

// helper: file entry
const f = (mtime, size = 100) => ({ mtime, size });

describe('buildPlan', () => {
  test('upload new local file', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/a.jsonl': f(1000) },
      remoteFiles: {},
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('sessions/a.jsonl');
    expect(plan.to_download).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test('download new remote file', () => {
    const plan = buildPlan({
      localFiles:  {},
      remoteFiles: { 'sessions/b.jsonl': f(2000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_download).toContain('sessions/b.jsonl');
    expect(plan.to_upload).toHaveLength(0);
  });

  test('unchanged file (same mtime+size)', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/c.jsonl': f(1000, 200) },
      remoteFiles: { 'sessions/c.jsonl': f(1000, 200) },
      config: BASE_CONFIG,
    });
    expect(plan.unchanged).toContain('sessions/c.jsonl');
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
  });

  test('local newer → upload', () => {
    // diff = 10000ms > tolerance 2000ms → should upload
    const plan = buildPlan({
      localFiles:  { 'sessions/d.jsonl': f(20000) },
      remoteFiles: { 'sessions/d.jsonl': f(10000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('sessions/d.jsonl');
  });

  test('remote newer → download', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/e.jsonl': f(1000) },
      remoteFiles: { 'sessions/e.jsonl': f(9000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_download).toContain('sessions/e.jsonl');
  });

  test('within tolerance → unchanged (equal_mtime_action=skip)', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/f.jsonl': f(1000) },
      remoteFiles: { 'sessions/f.jsonl': f(1001) }, // 1ms diff, tolerance 2s
      config: BASE_CONFIG,
    });
    expect(plan.unchanged).toContain('sessions/f.jsonl');
  });

  test('conflict: both sides changed, policy=manual_abort', () => {
    // simulate both sides different size at similar mtime
    const plan = buildPlan({
      localFiles:  { 'session_index.jsonl': { mtime: 5000, size: 300 } },
      remoteFiles: { 'session_index.jsonl': { mtime: 5000, size: 999 } },
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, equal_mtime_action: 'manual_abort' } },
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });

  test('multiple files mixed', () => {
    // Use mtime values clearly beyond 2000ms tolerance
    const plan = buildPlan({
      localFiles: {
        'a.jsonl': f(100000),
        'b.jsonl': f(200000),
        'c.jsonl': f(300000), // local mtime >> remote
      },
      remoteFiles: {
        'b.jsonl': f(200000),
        'c.jsonl': f(100000), // remote much older → local should upload
        'd.jsonl': f(400000), // only remote
      },
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('a.jsonl');
    expect(plan.to_upload).toContain('c.jsonl');
    expect(plan.to_download).toContain('d.jsonl');
    expect(plan.unchanged).toContain('b.jsonl');
  });
});

test('download preserves remote mtime, so the next preview does not re-upload', async () => {
  const { applyPlan } = await import('../src/sync-engine.js');
  const { mkdtempSync, statSync, rmSync, readFileSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const base = mkdtempSync(join(tmpdir(), 'cxsync-mtime-'));
  const rel = 'sessions/remote.jsonl';
  const content = Buffer.from('remote content');
  const mtime = Date.parse('2020-01-01T00:00:00Z');
  try {
    const remoteFiles = [{ rel, size: content.length, mtime }];
    const plan = buildPlan({ localFiles: [], remoteFiles, config: BASE_CONFIG });
    const result = await applyPlan({ plan, config: BASE_CONFIG, localBase: base,
      webdavClient: { stat: async () => ({ size: content.length, mtime }), getFile: async () => content } });
    expect(result.errors).toEqual([]);
    expect(result.downloaded).toBe(1);
    expect(readFileSync(join(base, rel))).toEqual(content);
    const st = statSync(join(base, rel));
    const next = buildPlan({ localFiles: [{ rel, size: st.size, mtime: st.mtimeMs }], remoteFiles, config: BASE_CONFIG });
    expect(next.to_upload).toEqual([]);
    expect(next.to_download).toEqual([]);
    expect(next.unchanged).toEqual([rel]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
