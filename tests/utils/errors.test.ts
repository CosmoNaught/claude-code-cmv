// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/display.js', () => ({
  error: vi.fn(),
}));

import { CmvError, handleError } from '../../src/utils/errors.js';
import { error as displayError } from '../../src/utils/display.js';

describe('CmvError', () => {
  it('stores userMessage', () => {
    const err = new CmvError('Something went wrong');
    expect(err.userMessage).toBe('Something went wrong');
  });

  it('uses userMessage as Error message when no message provided', () => {
    const err = new CmvError('User-facing message');
    expect(err.message).toBe('User-facing message');
  });

  it('uses explicit message when provided', () => {
    const err = new CmvError('User-facing', 'Internal detail');
    expect(err.userMessage).toBe('User-facing');
    expect(err.message).toBe('Internal detail');
  });
});

describe('handleError', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    delete process.env['CMV_DEBUG'];
  });

  it('shows userMessage for CmvError', () => {
    const err = new CmvError('bad input');
    try { handleError(err); } catch { /* mock exit throws */ }
    expect(displayError).toHaveBeenCalledWith('bad input');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('shows message for regular Error', () => {
    const err = new Error('generic failure');
    try { handleError(err); } catch { /* mock exit throws */ }
    expect(displayError).toHaveBeenCalledWith('generic failure');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('shows string for non-Error', () => {
    try { handleError('raw string error'); } catch { /* mock exit throws */ }
    expect(displayError).toHaveBeenCalledWith('raw string error');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints stack trace when CMV_DEBUG=1', () => {
    process.env['CMV_DEBUG'] = '1';
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('debug me');
    try { handleError(err); } catch { /* mock exit throws */ }
    expect(stderrSpy).toHaveBeenCalledWith('\nDebug stack trace:');
    expect(stderrSpy).toHaveBeenCalledWith(err.stack);
    stderrSpy.mockRestore();
  });
});
