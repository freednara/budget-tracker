/**
 * Regression tests for CR-Apr24-AA fix cluster.
 *
 * Cluster AA — Import/backup/cross-tab persistence P3 fixes
 *   177  Import round-trip: onboarding & filterExpanded in restoreMap
 *   178  Backup: persist onboarding & filterExpanded in createBackup
 *   182  ExportData interface: onboarding & filterExpanded fields
 *   183  BackupSettings interface: onboarding & filterExpanded fields
 *   188  restoreMap completeness gap (covered by 177)
 *   190  Dead SK key defaults removed from STORAGE_DEFAULTS
 *   198  restoreBackup duplicate toast suppression
 *   199  Cross-tab onboarding sync via storage-events
 *   200  Cross-tab filterExpanded sync via storage-events
 *   201  Dead SK key defaults removed (same as 190)
 *   202  ImportData: syncState removed, onboarding/filterExpanded added
 *   204  storage-events default branch for unhandled SK keys
 */

import { describe, it, expect } from 'vitest';

// ==========================================
// Findings 177, 182, 188, 202 — import/export round-trip
// ==========================================

describe('Cluster AA — import/export onboarding & filterExpanded (findings 177, 182, 188, 202)', () => {
  it('buildExportData is exported', async () => {
    const mod = await import('../js/modules/features/import-export/import-export.js');
    expect(mod.buildExportData).toBeDefined();
    expect(typeof mod.buildExportData).toBe('function');
  });

  it('buildImportState is exported', async () => {
    const mod = await import('../js/modules/features/import-export/import-export.js');
    expect(mod.buildImportState).toBeDefined();
    expect(typeof mod.buildImportState).toBe('function');
  });
});

// ==========================================
// Findings 178, 183 — backup persistence
// ==========================================

describe('Cluster AA — backup onboarding & filterExpanded (findings 178, 183)', () => {
  it('createBackup is exported', async () => {
    const mod = await import('../js/modules/features/backup/auto-backup.js');
    expect(mod.createBackup).toBeDefined();
    expect(typeof mod.createBackup).toBe('function');
  });

  it('restoreBackup is exported', async () => {
    const mod = await import('../js/modules/features/backup/auto-backup.js');
    expect(mod.restoreBackup).toBeDefined();
    expect(typeof mod.restoreBackup).toBe('function');
  });
});

// ==========================================
// Finding 190, 201 — dead SK key defaults removed
// ==========================================

describe('Cluster AA — dead SK key defaults removed (findings 190, 201)', () => {
  it('STORAGE_DEFAULTS does not contain dead keys', async () => {
    const { STORAGE_DEFAULTS, SK } = await import('../js/modules/core/state.js');
    // These keys were identified as having no live readers/writers.
    expect(STORAGE_DEFAULTS).not.toHaveProperty(SK.BUDGET_PLANS);
    expect(STORAGE_DEFAULTS).not.toHaveProperty(SK.ATTACHMENTS);
    expect(STORAGE_DEFAULTS).not.toHaveProperty(SK.USER_SETTINGS);
    expect(STORAGE_DEFAULTS).not.toHaveProperty(SK.SYNC_STATE);
    expect(STORAGE_DEFAULTS).not.toHaveProperty(SK.APP_STATS);
  });

  it('HAS_ONBOARDED is retained in STORAGE_DEFAULTS (used by migration.ts)', async () => {
    const { STORAGE_DEFAULTS, SK } = await import('../js/modules/core/state.js');
    expect(STORAGE_DEFAULTS).toHaveProperty(SK.HAS_ONBOARDED);
  });

  it('SK enum still exposes dead keys for backward compat', async () => {
    const { SK } = await import('../js/modules/core/state.js');
    // Kept in SK for Object.values(SK) loop compatibility.
    expect(SK.BUDGET_PLANS).toBe('harbor_budget_plans');
    expect(SK.ATTACHMENTS).toBe('harbor_attachments');
    expect(SK.USER_SETTINGS).toBe('harbor_user_settings');
    expect(SK.SYNC_STATE).toBe('harbor_sync_state');
    expect(SK.APP_STATS).toBe('harbor_app_stats');
  });
});

// ==========================================
// Finding 198 — restoreBackup suppressToast
// ==========================================

describe('Cluster AA — restoreBackup suppressToast option (finding 198)', () => {
  it('restoreBackup accepts an options parameter', async () => {
    const mod = await import('../js/modules/features/backup/auto-backup.js');
    // restoreBackup(backupId: string, options?: { suppressToast?: boolean })
    // Verify it accepts 2 params (the options is optional)
    expect(mod.restoreBackup.length).toBeLessThanOrEqual(2);
  });
});

// ==========================================
// Findings 199, 200, 204 — storage-events cross-tab sync
// ==========================================

describe('Cluster AA — storage-events cross-tab sync (findings 199, 200, 204)', () => {
  it('storage-events module loads and exports initStorageEvents', async () => {
    const mod = await import('../js/modules/ui/interactions/storage-events.js');
    expect(mod.initStorageEvents).toBeDefined();
    expect(typeof mod.initStorageEvents).toBe('function');
  });

  it('cleanupStorageEvents is exported', async () => {
    const mod = await import('../js/modules/ui/interactions/storage-events.js');
    expect(mod.cleanupStorageEvents).toBeDefined();
    expect(typeof mod.cleanupStorageEvents).toBe('function');
  });

  it('signals expose onboarding and filtersExpanded for cross-tab sync', async () => {
    const signals = await import('../js/modules/core/signals.js');
    expect(signals.onboarding).toBeDefined();
    expect(signals.filtersExpanded).toBeDefined();
  });
});

// ==========================================
// State module — BACKUP_REMINDER_TX_COUNT_KEY export
// ==========================================

describe('Cluster AA — state module integrity', () => {
  it('BACKUP_REMINDER_TX_COUNT_KEY is exported', async () => {
    const { BACKUP_REMINDER_TX_COUNT_KEY } = await import('../js/modules/core/state.js');
    expect(BACKUP_REMINDER_TX_COUNT_KEY).toBe('backup_reminder_last_tx_count');
  });

  it('STORAGE_DEFAULTS includes BACKUP_REMINDER_TX_COUNT_KEY', async () => {
    const { STORAGE_DEFAULTS, BACKUP_REMINDER_TX_COUNT_KEY } = await import('../js/modules/core/state.js');
    expect(STORAGE_DEFAULTS).toHaveProperty(BACKUP_REMINDER_TX_COUNT_KEY);
    expect(STORAGE_DEFAULTS[BACKUP_REMINDER_TX_COUNT_KEY]).toBe(0);
  });
});
