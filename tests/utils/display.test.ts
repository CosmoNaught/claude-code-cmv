// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('chalk', () => {
  const passthrough = (s: string) => s;
  const obj: any = Object.assign(passthrough, {
    green: passthrough,
    yellow: passthrough,
    red: passthrough,
    blue: passthrough,
    dim: passthrough,
    bold: passthrough,
  });
  return { default: obj };
});

import {
  success,
  warn,
  error,
  info,
  dim,
  bold,
  formatDate,
  formatRelativeTime,
  truncate,
  formatTable,
} from '../../src/utils/display.js';

describe('display utilities', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // --- console output functions ---

  it('success() calls console.log with checkmark', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    success('done');
    expect(spy).toHaveBeenCalledWith('✓ done');
  });

  it('warn() calls console.log with warning symbol', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn('careful');
    expect(spy).toHaveBeenCalledWith('⚠ careful');
  });

  it('error() calls console.error with cross', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    error('bad');
    expect(spy).toHaveBeenCalledWith('✗ bad');
  });

  it('info() calls console.log with info symbol', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    info('note');
    expect(spy).toHaveBeenCalledWith('ℹ note');
  });

  // --- style helpers ---

  it('dim() returns the string (passthrough mock)', () => {
    expect(dim('faded')).toBe('faded');
  });

  it('bold() returns the string (passthrough mock)', () => {
    expect(bold('strong')).toBe('strong');
  });

  // --- formatDate ---

  it('formatDate() returns a formatted date string', () => {
    const result = formatDate('2025-06-15T12:00:00Z');
    // Should contain year and some numeric representation
    expect(result).toContain('2025');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  // --- formatRelativeTime ---

  it('formatRelativeTime() returns "just now" for < 1 min', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('formatRelativeTime() returns minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
  });

  it('formatRelativeTime() returns hours ago', () => {
    const twoHrsAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoHrsAgo)).toBe('2h ago');
  });

  it('formatRelativeTime() returns days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago');
  });

  it('formatRelativeTime() returns full date for > 30 days', () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeTime(old);
    // Should not end with "ago" — it falls back to formatDate
    expect(result).not.toMatch(/ago$/);
    expect(result.length).toBeGreaterThan(0);
  });

  // --- truncate ---

  it('truncate() returns original when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncate() adds ellipsis when over limit', () => {
    expect(truncate('hello world', 6)).toBe('hello…');
  });

  // --- formatTable ---

  it('formatTable() produces aligned output with separator', () => {
    const headers = ['Name', 'Age'];
    const rows = [
      ['Alice', '30'],
      ['Bob', '25'],
    ];
    const table = formatTable(headers, rows);
    const lines = table.split('\n');

    expect(lines.length).toBe(4); // header + separator + 2 data rows
    expect(lines[0]).toContain('Name');
    expect(lines[0]).toContain('Age');
    expect(lines[1]).toMatch(/─+/); // separator line
    expect(lines[2]).toContain('Alice');
    expect(lines[3]).toContain('Bob');
  });
});
