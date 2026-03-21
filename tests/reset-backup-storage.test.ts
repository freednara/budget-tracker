import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clearAllBackupsMock } = vi.hoisted(() => ({
  clearAllBackupsMock: vi.fn(async () => true)
}));

vi.mock('../js/modules/features/backup/indexeddb-backup-store.js', () => ({
  clearAllBackups: clearAllBackupsMock
}));

import { clearBackupStorage } from '../js/modules/features/backup/reset-backup-storage.js';

describe('clearBackupStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllBackupsMock.mockClear();
  });

  it('keeps backup payloads while clearing backup metadata', async () => {
    localStorage.setItem('budget_tracker_auto_backups', JSON.stringify([{ id: 'backup-1' }]));
    localStorage.setItem('budget_tracker_backup_schedule', JSON.stringify({ enabled: true }));
    localStorage.setItem('budget_tracker_backup_status', JSON.stringify({ totalBackups: 1 }));
    localStorage.setItem('budget_tracker_backup_legacy_1', JSON.stringify({ id: 'legacy' }));

    const result = await clearBackupStorage({
      clearPayloads: false,
      clearMetadata: true
    });

    expect(result).toBe(true);
    expect(localStorage.getItem('budget_tracker_auto_backups')).not.toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_legacy_1')).not.toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_schedule')).toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_status')).toBeNull();
    expect(clearAllBackupsMock).not.toHaveBeenCalled();
  });

  it('clears backup payloads across localStorage and IndexedDB backup stores', async () => {
    localStorage.setItem('budget_tracker_auto_backups', JSON.stringify([{ id: 'backup-1' }]));
    localStorage.setItem('budget_tracker_backup_legacy_1', JSON.stringify({ id: 'legacy' }));
    localStorage.setItem('budget_tracker_backup_schedule', JSON.stringify({ enabled: true }));

    const result = await clearBackupStorage({
      clearPayloads: true,
      clearMetadata: true
    });

    expect(result).toBe(true);
    expect(localStorage.getItem('budget_tracker_auto_backups')).toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_legacy_1')).toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_schedule')).toBeNull();
    expect(clearAllBackupsMock).toHaveBeenCalledTimes(1);
  });
});
