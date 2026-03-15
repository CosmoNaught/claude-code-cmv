// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { generateSnapshotId, generateUUID } from '../../src/utils/id.js';

describe('generateSnapshotId', () => {
  it('starts with "snap_"', () => {
    expect(generateSnapshotId()).toMatch(/^snap_/);
  });

  it('has correct length (5 prefix + 8 hex chars = 13)', () => {
    expect(generateSnapshotId()).toHaveLength(13);
  });

  it('contains only hex chars after prefix', () => {
    const id = generateSnapshotId();
    const hex = id.slice(5);
    expect(hex).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('generateUUID', () => {
  it('matches UUID v4 format', () => {
    const uuid = generateUUID();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('returns unique values on multiple calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateUUID()));
    expect(ids.size).toBe(20);
  });
});
