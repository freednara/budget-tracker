/**
 * Locking tests for `triggerJsonExport()` — Commit E of 7k (new batch P2).
 *
 * Contract:
 *   - On confirmed File System Access API write → mark backup completed,
 *     award achievement, return true.
 *   - On FSA AbortError (user cancelled native save dialog) → do NOT
 *     mark backup, do NOT award achievement, return false. This closes
 *     the defect where a cancelled save silently suppressed future
 *     backup reminders.
 *   - On FSA unavailable → fall through to legacy `downloadBlob` path,
 *     mark backup (best-effort, no browser confirmation available),
 *     return false.
 *   - On FSA non-abort failure (permissions, disk full) → fall through
 *     to legacy path (same as no-FSA case).
 *
 * The fix makes `markBackupCompleted` conditional on a *confirmed*
 * write, so this test pins that it is NOT called on AbortError.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Mock markBackupCompleted / awardAchievement / downloadBlob so we can
// observe what the export path actually calls. The module imports these
// eagerly, so these mocks must be set up before `triggerJsonExport` is
// imported below.
vi.mock('../js/modules/orchestration/backup-reminder.ts', () => ({
  markBackupCompleted: vi.fn(),
  // Satisfy any other imports from this module used elsewhere in the
  // import-export-events file's dependency graph.
  default: {},
}));

vi.mock('../js/modules/features/gamification/achievements.ts', () => ({
  awardAchievement: vi.fn(),
}));

vi.mock('../js/modules/core/utils-dom.ts', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/core/utils-dom.ts')>(
    '../js/modules/core/utils-dom.ts'
  );
  return {
    ...actual,
    downloadBlob: vi.fn(),
  };
});

import { triggerJsonExport } from '../js/modules/features/import-export/import-export-events.js';
import { markBackupCompleted } from '../js/modules/orchestration/backup-reminder.js';
import { awardAchievement } from '../js/modules/features/gamification/achievements.js';
import { downloadBlob } from '../js/modules/core/utils-dom.js';

type Writable = {
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type FSAHandle = {
  createWritable: ReturnType<typeof vi.fn>;
};

function installShowSaveFilePicker(handler: () => Promise<FSAHandle>): void {
  (window as unknown as {
    showSaveFilePicker: () => Promise<FSAHandle>;
  }).showSaveFilePicker = handler;
}

function removeShowSaveFilePicker(): void {
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
}

describe('triggerJsonExport — save-confirmation gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    removeShowSaveFilePicker();
  });

  it('marks backup completed and awards achievement on confirmed FSA write', async () => {
    const writable: Writable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const handle: FSAHandle = {
      createWritable: vi.fn().mockResolvedValue(writable),
    };
    installShowSaveFilePicker(() => Promise.resolve(handle));

    const result = await triggerJsonExport();

    expect(result).toBe(true);
    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(markBackupCompleted).toHaveBeenCalledTimes(1);
    expect(awardAchievement).toHaveBeenCalledWith('data_pro');
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('does NOT mark backup completed when user aborts the native save dialog (AbortError)', async () => {
    const abortErr = new Error('User cancelled');
    abortErr.name = 'AbortError';
    installShowSaveFilePicker(() => Promise.reject(abortErr));

    const result = await triggerJsonExport();

    expect(result).toBe(false);
    // Critical: the reminder must NOT be suppressed when the user
    // cancels — there's no snapshot on disk to restore from.
    expect(markBackupCompleted).not.toHaveBeenCalled();
    expect(awardAchievement).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('falls back to downloadBlob and marks backup when FSA is unavailable', async () => {
    // showSaveFilePicker absent — simulates Firefox / older Safari.
    removeShowSaveFilePicker();

    const result = await triggerJsonExport();

    expect(result).toBe(false);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    // Legacy path — no browser-level confirmation available, so
    // the current contract is to optimistically mark.
    expect(markBackupCompleted).toHaveBeenCalledTimes(1);
    expect(awardAchievement).toHaveBeenCalledWith('data_pro');
  });

  it('falls back to downloadBlob on FSA non-abort failure (e.g. permissions)', async () => {
    const permErr = new Error('Permission denied');
    permErr.name = 'NotAllowedError';
    installShowSaveFilePicker(() => Promise.reject(permErr));

    const result = await triggerJsonExport();

    expect(result).toBe(false);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(markBackupCompleted).toHaveBeenCalledTimes(1);
  });
});
