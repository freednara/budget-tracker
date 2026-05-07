import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as signals from '../js/modules/core/signals.js';

const {
  emitMock,
  hydrateFromImportMock,
  tryAtomicWriteMock,
  buildImportStateMock,
  sanitizeImportedTransactionsMock,
  reportImportValidationRejectionsMock,
  replaceAllTransactionsMock,
  getIndexedDbBackupMock,
  getAllBackupsMock,
  storeBackupMock,
  setThemeMock,
  safeStorageMock
} = vi.hoisted(() => ({
  emitMock: vi.fn(),
  // Phase 4a H18: hydrateFromImport now returns ImportHydrationResult —
  // default the mock to a clean "0 of 0, no failures" record.
  // L74 (post-rev-13): the `failed` array is typed explicitly so
  // `mockReturnValueOnce` can swap in a populated record without tripping
  // TS2322 ("Type ... is not assignable to type 'never'").
  hydrateFromImportMock: vi.fn((): { attempted: number; succeeded: number; failed: Array<{ propertyName: string; error: Error }> } => ({ attempted: 0, succeeded: 0, failed: [] })),
  tryAtomicWriteMock: vi.fn(async () => true),
  buildImportStateMock: vi.fn(() => ({ newS: {}, writes: [], theme: null })),
  // Prior-batch P2: restore path now runs transactions through the
  // sanitizer + rejection reporter the same way the JSON import path
  // does. The mock default passes everything through, returning an
  // `accepted` array equal to the input and an empty `rejected` array.
  sanitizeImportedTransactionsMock: vi.fn((incoming: unknown[]) => ({
    accepted: (incoming as Array<Record<string, unknown>>).map(t => ({ ...t })),
    rejected: []
  })),
  reportImportValidationRejectionsMock: vi.fn(),
  replaceAllTransactionsMock: vi.fn(async () => ({ isOk: true, data: [] })),
  getIndexedDbBackupMock: vi.fn(),
  // Prior-batch P2: `restoreBackup` reads the existing backup list to
  // compute a safety-backup retention override. Default to empty so
  // tests that don't populate the list still hit the safety path
  // without surprises.
  getAllBackupsMock: vi.fn(async () => [] as unknown[]),
  // L86: typed parameter so `storeBackupMock.mock.calls[0]?.[0]` is
  // indexable under the `noUncheckedIndexedAccess` tsconfig flag. The
  // default inference gave `[][]`, which TS rejects on tuple index 0.
  storeBackupMock: vi.fn(async (_backup: unknown, _retain?: number) => undefined),
  setThemeMock: vi.fn(),
  safeStorageMock: {
    getItem: vi.fn(() => null),
    removeItem: vi.fn(),
    getJSON: vi.fn((_: string, fallback: unknown) => fallback),
    setJSON: vi.fn()
  }
}));

vi.mock('../js/modules/core/event-bus.js', async () => {
  const actual = await vi.importActual('../js/modules/core/event-bus.js');
  return {
    ...actual,
    emit: emitMock
  };
});

vi.mock('../js/modules/core/state-hydration.js', () => ({
  hydrateFromImport: hydrateFromImportMock
}));

vi.mock('../js/modules/features/import-export/import-export.js', () => ({
  buildImportState: buildImportStateMock,
  tryAtomicWrite: tryAtomicWriteMock,
  sanitizeImportedTransactions: sanitizeImportedTransactionsMock,
  reportImportValidationRejections: reportImportValidationRejectionsMock
}));

vi.mock('../js/modules/features/personalization/theme.js', () => ({
  setTheme: setThemeMock
}));

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    replaceAllTransactions: replaceAllTransactionsMock
  }
}));

vi.mock('../js/modules/features/backup/indexeddb-backup-store.js', () => ({
  storeBackup: storeBackupMock,
  getAllBackups: getAllBackupsMock,
  getBackup: getIndexedDbBackupMock,
  deleteBackup: vi.fn()
}));

vi.mock('../js/modules/core/safe-storage.js', () => ({
  safeStorage: safeStorageMock
}));

// L86 (prior-batch P2 update): `importBackup` dynamically imports
// `async-modal` and awaits `asyncConfirm(...)`. Under the prior-batch P2
// reorder, `storeBackup` now runs ONLY when the user confirms — so the
// default must return `true` for tests that exercise the "store + restore"
// happy path. Individual tests that want to assert the cancel path
// override this per-test.
vi.mock('../js/modules/ui/components/async-modal.js', () => ({
  asyncConfirm: vi.fn(async () => true)
}));

import { Events } from '../js/modules/core/event-bus.js';
import {
  createBackup,
  disableAutoBackup,
  importBackup,
  restoreBackup
} from '../js/modules/features/backup/auto-backup.js';
import { SK } from '../js/modules/core/state.js';

describe('restoreBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();

    signals.replaceTransactionLedger([]);
    signals.savingsGoals.value = {};
    signals.monthlyAlloc.value = {};
    signals.debts.value = [];
    signals.currency.value = { home: 'USD', symbol: '$' };
    signals.rolloverSettings.value = { enabled: false, mode: 'all', categories: [], maxRollover: 0, negativeHandling: 'carry' };
    signals.achievements.value = {} as any;
    signals.streak.value = { current: 0, longest: 0, lastDate: '' } as any;
    signals.sections.value = {} as any;
    signals.insightPers.value = 'balanced' as any;
    signals.lastBackup.value = 0;
    signals.lastBackupTxCount.value = 0;

    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer)
      }
    });

    getIndexedDbBackupMock.mockResolvedValue({
      metadata: {
        id: 'backup-1',
        timestamp: Date.now(),
        version: '2.0',
        deviceId: 'device-1',
        transactionCount: 1,

        size: 128,
        checksum: '01020304'
      },
      data: {
        transactions: [{
          __backendId: 'tx_restore',
          type: 'expense',
          amount: 12,
          description: 'Restored',
          date: '2026-03-20',
          category: 'food',
          currency: 'USD',
          recurring: false
        }],
        savingsGoals: {},
        monthlyAllocations: {},
        userCategories: null,
        debts: [],
        settings: {
          lastBackupTxCount: 1
        }
      }
    });
  });

  afterEach(() => {
    disableAutoBackup();
    vi.useRealTimers();
  });

  it('emits DATA_IMPORTED after a successful restore', async () => {
    const result = await restoreBackup('backup-1');

    expect(result).toBe(true);
    expect(replaceAllTransactionsMock).toHaveBeenCalledTimes(1);
    expect(hydrateFromImportMock).toHaveBeenCalledTimes(1);
    expect(hydrateFromImportMock).toHaveBeenCalledWith(
      buildImportStateMock.mock.results[0]?.value?.newS ?? {},
      expect.arrayContaining([
        expect.objectContaining({ __backendId: 'tx_restore' })
      ])
    );
    expect(emitMock).toHaveBeenCalledWith(Events.DATA_IMPORTED);
    expect(emitMock).toHaveBeenCalledWith(Events.SHOW_TOAST, { message: 'Backup restored successfully', type: 'success' });
  });

  it('aborts restore when the safety backup cannot be created', async () => {
    storeBackupMock.mockRejectedValueOnce(new Error('quota exceeded'));

    const result = await restoreBackup('backup-1');

    expect(result).toBe(false);
    expect(replaceAllTransactionsMock).not.toHaveBeenCalled();
    expect(hydrateFromImportMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith(Events.SHOW_TOAST, {
      message: 'Restore couldn\u2019t complete \u2014 the backup file may be damaged. Try a different backup.',
      type: 'error'
    });
  });

  it('rejects oversized backup imports before reading the file', async () => {
    const oversizedFile = {
      size: 25 * 1024 * 1024 + 1,
      text: vi.fn()
    } as unknown as File;

    const result = await importBackup(oversizedFile);

    expect(result).toBe(false);
    expect(oversizedFile.text).not.toHaveBeenCalled();
    expect(storeBackupMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith(Events.SHOW_TOAST, {
      message: 'Import couldn\u2019t complete \u2014 make sure the file is a valid Harbor Ledger backup.',
      type: 'error'
    });
  });

  it('forwards legacy customCategories through to buildImportState on restore', async () => {
    // Rev 13 L71 regression guard: `normalizeBackupForImport` used to read
    // only `backup.data.userCategories` and additionally coerced an absent
    // value to `null`. Older auto-backups that stored cats under
    // `data.customCategories` therefore (a) had the legacy field stripped
    // before `buildImportState` ever saw it, and (b) hit the modern branch
    // with `null`, which — in the restore flow's hard-coded 'overwrite'
    // mode — reset SK.USER_CATS to null and stranded any transaction or
    // budget that referenced a user-defined category ID. This test feeds
    // the legacy shape in and asserts both fields land intact.
    getIndexedDbBackupMock.mockResolvedValue({
      metadata: {
        id: 'backup-legacy-cats',
        timestamp: Date.now(),
        version: '1.0',
        deviceId: 'device-1',
        transactionCount: 1,

        size: 128,
        checksum: '01020304'
      },
      data: {
        transactions: [{
          __backendId: 'tx_legacy',
          type: 'expense',
          amount: 10,
          description: 'Latte',
          date: '2026-03-20',
          category: 'leg_cat_coffee',
          currency: 'USD',
          recurring: false
        }],
        savingsGoals: {},
        monthlyAllocations: {},
        // No userCategories field — this is the legacy shape.
        customCategories: [
          { id: 'leg_cat_coffee', name: 'Coffee', type: 'expense', emoji: '☕', color: '#7c3aed' }
        ],
        debts: [],
        settings: {}
      }
    });

    const result = await restoreBackup('backup-legacy-cats');

    expect(result).toBe(true);
    expect(buildImportStateMock).toHaveBeenCalledTimes(1);
    const importDataArg = (buildImportStateMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    // Absent userCategories must NOT be coerced to null; otherwise the
    // buildImportState modern branch pre-empts the compat branch.
    expect(importDataArg.userCategories).toBeUndefined();
    // Legacy field passes through for the compat branch to consume.
    expect(importDataArg.customCategories).toEqual([
      { id: 'leg_cat_coffee', name: 'Coffee', type: 'expense', emoji: '☕', color: '#7c3aed' }
    ]);
  });

  it('reads alertPrefs from settings.alerts when data.alerts is absent', async () => {
    // Rev 13 L71 regression guard: prior code read only `backup.data.alerts`,
    // despite `BackupSettings.alerts` being a declared field that
    // `normalizeBackupSettings` preserves. Backup variants that nested
    // alert prefs under `settings.alerts` therefore restored every other
    // setting but silently reset alerts to defaults.
    const legacyAlerts = {
      budgetThreshold: 0.9,
      browserNotificationsEnabled: true,
      lastNotifiedAlertKeys: ['food:2026-03']
    };
    getIndexedDbBackupMock.mockResolvedValue({
      metadata: {
        id: 'backup-settings-alerts',
        timestamp: Date.now(),
        version: '1.5',
        deviceId: 'device-1',
        transactionCount: 0,

        size: 128,
        checksum: '01020304'
      },
      data: {
        transactions: [],
        savingsGoals: {},
        monthlyAllocations: {},
        userCategories: null,
        debts: [],
        // No top-level data.alerts; alerts nested under settings.
        settings: {
          alerts: legacyAlerts
        }
      }
    });

    const result = await restoreBackup('backup-settings-alerts');

    expect(result).toBe(true);
    expect(buildImportStateMock).toHaveBeenCalledTimes(1);
    const importDataArg = (buildImportStateMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(importDataArg.alertPrefs).toEqual(legacyAlerts);
  });

  it('prefers data.alerts over settings.alerts when both are present', async () => {
    const modernAlerts = { budgetThreshold: 0.8, browserNotificationsEnabled: false, lastNotifiedAlertKeys: [] };
    const legacyAlerts = { budgetThreshold: 0.5, browserNotificationsEnabled: true, lastNotifiedAlertKeys: ['stale'] };
    getIndexedDbBackupMock.mockResolvedValue({
      metadata: {
        id: 'backup-alerts-both',
        timestamp: Date.now(),
        version: '2.0',
        deviceId: 'device-1',
        transactionCount: 0,

        size: 128,
        checksum: '01020304'
      },
      data: {
        transactions: [],
        savingsGoals: {},
        monthlyAllocations: {},
        userCategories: null,
        debts: [],
        alerts: modernAlerts,
        settings: { alerts: legacyAlerts }
      }
    });

    const result = await restoreBackup('backup-alerts-both');

    expect(result).toBe(true);
    const importDataArg = (buildImportStateMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(importDataArg.alertPrefs).toEqual(modernAlerts);
  });

  // Rev 13 L74: partial-failure toast contract.
  // Prior behavior emitted a warning ("Restored X of Y sections, skipped: ...")
  // and then *also* emitted "Backup restored successfully", which contradicted
  // the warning and misled users into thinking settings restored cleanly.
  describe('partial-hydration toast contract', () => {
    it('suppresses the success toast when hydration reports failures', async () => {
      hydrateFromImportMock.mockReturnValueOnce({
        attempted: 5,
        succeeded: 3,
        failed: [
          { propertyName: 'monthlyAllocations', error: new Error('bad shape') },
          { propertyName: 'savingsGoals', error: new Error('bad shape') }
        ]
      });

      const result = await restoreBackup('backup-1');

      expect(result).toBe(true);
      // Warning toast IS emitted with the partial-failure summary.
      const warningCall = emitMock.mock.calls.find(
        (call) => call[0] === Events.SHOW_TOAST && (call[1] as { type?: string })?.type === 'warning'
      );
      expect(warningCall).toBeDefined();
      expect((warningCall?.[1] as { message: string }).message).toContain('monthlyAllocations');
      expect((warningCall?.[1] as { message: string }).message).toContain('savingsGoals');

      // Success toast is SUPPRESSED.
      const successCall = emitMock.mock.calls.find(
        (call) =>
          call[0] === Events.SHOW_TOAST &&
          (call[1] as { message?: string })?.message === 'Backup restored successfully'
      );
      expect(successCall).toBeUndefined();

      // DATA_IMPORTED still fires — UI needs to re-render either way.
      expect(emitMock).toHaveBeenCalledWith(Events.DATA_IMPORTED);
    });

    it('still emits the success toast when hydration is clean', async () => {
      hydrateFromImportMock.mockReturnValueOnce({
        attempted: 5,
        succeeded: 5,
        failed: []
      });

      const result = await restoreBackup('backup-1');

      expect(result).toBe(true);
      expect(emitMock).toHaveBeenCalledWith(Events.SHOW_TOAST, {
        message: 'Backup restored successfully',
        type: 'success'
      });

      // No warning toast when nothing failed.
      const warningCall = emitMock.mock.calls.find(
        (call) => call[0] === Events.SHOW_TOAST && (call[1] as { type?: string })?.type === 'warning'
      );
      expect(warningCall).toBeUndefined();
    });
  });

  // L85/L86 (post-rev-13): checksum verification must run against the
  // ORIGINAL parsed payload, before any normalisation mutates it. Prior
  // behaviour ran `hasValidBackupShape()` first, which rewrote
  // `data.settings` via `normalizeBackupSettings` (which reorders fields,
  // drops unknowns, and rewrites theme tokens). A signed backup whose
  // settings required any of those tweaks would then fail checksum
  // verification even though the on-disk file was intact — turning a
  // valid import into "Backup integrity check failed".
  describe('checksum verification ordering (L85)', () => {
    // Compute a SHA-256 checksum identical to `generateChecksum` in
    // auto-backup.ts. Using crypto.subtle here matches production; if it's
    // unavailable in the JSDOM environment the test will surface that
    // environmental gap immediately rather than silently use a fallback.
    async function sha256Hex(text: string): Promise<string> {
      const encoder = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', encoder.encode(text));
      return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    it('accepts a signed legacy backup whose settings need normalisation', async () => {
      // Build a backup whose `settings` carries an unrecognised field that
      // `normalizeBackupSettings` will drop. Under the old ordering, the
      // drop mutated the payload before the checksum check, so the
      // downstream `verifyBackupChecksum(backup)` compared the original
      // signed bytes against the already-mutated in-memory object and
      // failed. The new ordering verifies the checksum first, THEN
      // normalises.
      const payload = {
        metadata: {
          id: 'imported-1',
          timestamp: 1713571200000,
          version: '1.5',
          deviceId: 'foreign-device',
          transactionCount: 0,
  
          size: 128,
          checksum: '' // set below
        },
        data: {
          transactions: [],
          savingsGoals: {},
          monthlyAllocations: {},
          userCategories: null,
          debts: [],
          settings: {
            theme: 'light',
            currency: { home: 'USD', symbol: '$' },
            // Extra legacy field — `normalizeBackupSettings` drops unknown
            // keys, so this is the mutation that historically broke the
            // checksum round-trip.
            legacyFieldThatNormalizerDrops: 'some-value'
          }
        }
      };

      // Compute checksum identically to generateChecksum: over the payload
      // with the `checksum` field removed.
      const verifyClone = JSON.parse(JSON.stringify(payload));
      delete verifyClone.metadata.checksum;
      const signedChecksum = await sha256Hex(JSON.stringify(verifyClone));
      payload.metadata.checksum = signedChecksum;

      const serialized = JSON.stringify(payload);
      const file = {
        size: serialized.length,
        text: vi.fn(async () => serialized)
      } as unknown as File;

      const result = await importBackup(file);

      // Pre-fix: this threw "Backup integrity check failed" because the
      // checksum verify ran after normalization dropped the legacy field.
      expect(result).toBe(true);
      // Prior-batch P2: under the reorder, `importBackup` now calls
      // `storeBackup` once for the imported payload and `restoreBackup`
      // is invoked on confirm — which in turn triggers another
      // `storeBackup` call for the safety backup. Asserting ">= 1"
      // keeps this test focused on "the imported backup landed in the
      // store" (verified below via mock.calls[0]) without coupling to
      // the downstream safety-backup write count.
      expect(storeBackupMock.mock.calls.length).toBeGreaterThanOrEqual(1);

      // Sanity: normalisation still runs (the stored payload should have
      // the extra field dropped). We assert on the first-arg of storeBackup.
      const stored = storeBackupMock.mock.calls[0]?.[0] as
        | { data: { settings: Record<string, unknown> } }
        | undefined;
      expect(stored).toBeDefined();
      expect(stored?.data.settings).toBeDefined();
      expect(stored?.data.settings?.legacyFieldThatNormalizerDrops).toBeUndefined();
      // The theme token survives (it's a valid Theme value).
      expect(stored?.data.settings?.theme).toBe('light');
      // The error toast for integrity failure is NOT emitted.
      const errorCall = emitMock.mock.calls.find(
        (call) =>
          call[0] === Events.SHOW_TOAST &&
          (call[1] as { type?: string })?.type === 'error'
      );
      expect(errorCall).toBeUndefined();
    });

    it('still rejects backups whose original signed checksum is invalid', async () => {
      // Defense-in-depth: the reorder must not weaken integrity. A backup
      // with a bad checksum still fails.
      const payload = {
        metadata: {
          id: 'tampered-1',
          timestamp: 1713571200000,
          version: '1.5',
          deviceId: 'foreign-device',
          transactionCount: 0,
  
          size: 128,
          checksum: 'deadbeef'.repeat(8) // bogus
        },
        data: {
          transactions: [],
          savingsGoals: {},
          monthlyAllocations: {},
          userCategories: null,
          debts: [],
          settings: { theme: 'light' }
        }
      };
      const serialized = JSON.stringify(payload);
      const file = {
        size: serialized.length,
        text: vi.fn(async () => serialized)
      } as unknown as File;

      const result = await importBackup(file);

      expect(result).toBe(false);
      expect(storeBackupMock).not.toHaveBeenCalled();
      expect(emitMock).toHaveBeenCalledWith(Events.SHOW_TOAST, {
        message: 'Import couldn\u2019t complete \u2014 make sure the file is a valid Harbor Ledger backup.',
        type: 'error'
      });
    });

    it('re-signs the stored payload so a later restore checksum verify still passes', async () => {
      // Once normalisation mutates the parsed payload, the stored bytes
      // differ from the original signed bytes. Without re-signing, the
      // NEXT call to verifyBackupChecksum (on restore) would now fail
      // against the mutated stored copy — reintroducing the same class of
      // false integrity rejection. The fix regenerates the checksum so
      // the stored payload remains self-consistent.
      const payload = {
        metadata: {
          id: 'resigned-1',
          timestamp: 1713571200000,
          version: '1.5',
          deviceId: 'foreign-device',
          transactionCount: 0,
  
          size: 128,
          checksum: ''
        },
        data: {
          transactions: [],
          savingsGoals: {},
          monthlyAllocations: {},
          userCategories: null,
          debts: [],
          settings: {
            theme: 'light',
            legacyFieldThatNormalizerDrops: 'x'
          }
        }
      };
      const verifyClone = JSON.parse(JSON.stringify(payload));
      delete verifyClone.metadata.checksum;
      payload.metadata.checksum = await sha256Hex(JSON.stringify(verifyClone));
      const signedChecksum = payload.metadata.checksum;
      const file = {
        size: JSON.stringify(payload).length,
        text: vi.fn(async () => JSON.stringify(payload))
      } as unknown as File;

      await importBackup(file);

      const stored = storeBackupMock.mock.calls[0]?.[0] as
        | { metadata: { checksum: string }; data: { settings: Record<string, unknown> } }
        | undefined;
      expect(stored).toBeDefined();
      // The stored payload was mutated by normalization (legacy field dropped).
      expect(stored?.data.settings?.legacyFieldThatNormalizerDrops).toBeUndefined();
      // The checksum on the stored payload must be a valid SHA-256 over
      // the NEW (normalized) bytes — i.e. the import path re-signed.
      // Without re-signing, the stored checksum would remain `signedChecksum`
      // (the pre-normalization hash), and a future `verifyBackupChecksum`
      // on restore would fail against the mutated stored bytes. This is
      // the contract: stored-payload + stored-checksum is self-consistent.
      expect(stored?.metadata.checksum).toBeTruthy();
      expect(typeof stored?.metadata.checksum).toBe('string');
      const storedClone = JSON.parse(JSON.stringify(stored));
      delete storedClone.metadata.checksum;
      const expectedNewChecksum = await sha256Hex(JSON.stringify(storedClone));
      expect(stored?.metadata.checksum).toBe(expectedNewChecksum);
      // Belt-and-braces: prior checksum value is still referenced to keep
      // the test intent explicit (pre-fix, stored checksum would be this).
      expect(signedChecksum).toBeTruthy();
    });
  });

  // L83/L84 (post-rev-13): `createBackup` must snapshot the four
  // debounced-batcher keys (filterPresets, txTemplates,
  // savingsContributions, alerts) from live signals, not from storage.
  // Prior behaviour read those via `lsGet(...)`, so a user change that
  // had not yet flushed through the 150 ms debounce (signals.ts:1098)
  // captured stale bytes even though the rest of the same payload used
  // live signals — an internally inconsistent snapshot boundary that
  // also disagreed with the manual `buildExportData` path.
  describe('createBackup live-signal snapshot contract (L83)', () => {
    it('snapshots filterPresets from the live signal, not stale localStorage', async () => {
      // Write a stale value to localStorage — mimics the state during
      // the 150 ms debounce window after the signal updates but before
      // the batcher flushes.
      const stalePreset = [{ id: 'stale', name: 'old' }];
      const freshPreset = [{ id: 'fresh', name: 'current' }];
      localStorage.setItem(SK.FILTER_PRESETS, JSON.stringify(stalePreset));
      signals.filterPresets.value = freshPreset as unknown as typeof signals.filterPresets.value;

      const result = await createBackup(true);

      expect(result).not.toBeNull();
      expect(result?.data.filterPresets).toEqual(freshPreset);
      // Belt-and-braces: assert the stale value is NOT what was captured.
      expect(result?.data.filterPresets).not.toEqual(stalePreset);
    });

    it('snapshots txTemplates from the live signal, not stale localStorage', async () => {
      const staleTemplate = [{ id: 'stale-t' }];
      const freshTemplate = [{ id: 'fresh-t' }];
      localStorage.setItem(SK.TX_TEMPLATES, JSON.stringify(staleTemplate));
      signals.txTemplates.value = freshTemplate as unknown as typeof signals.txTemplates.value;

      const result = await createBackup(true);

      expect(result?.data.txTemplates).toEqual(freshTemplate);
      expect(result?.data.txTemplates).not.toEqual(staleTemplate);
    });

    it('snapshots savingsContributions from the live signal, not stale localStorage', async () => {
      const staleContribs = [{ goalId: 'stale', amount: 1, date: '2026-01-01' }];
      const freshContribs = [{ goalId: 'fresh', amount: 99, date: '2026-04-20' }];
      localStorage.setItem(SK.SAVINGS_CONTRIB, JSON.stringify(staleContribs));
      signals.savingsContribs.value = freshContribs as unknown as typeof signals.savingsContribs.value;

      const result = await createBackup(true);

      expect(result?.data.savingsContributions).toEqual(freshContribs);
      expect(result?.data.savingsContributions).not.toEqual(staleContribs);
    });

    it('snapshots alerts from the live signal, not stale localStorage', async () => {
      const staleAlerts = { budgetThreshold: 0.5, browserNotificationsEnabled: false, lastNotifiedAlertKeys: [] };
      const freshAlerts = { budgetThreshold: 0.95, browserNotificationsEnabled: true, lastNotifiedAlertKeys: ['live'] };
      localStorage.setItem(SK.ALERTS, JSON.stringify(staleAlerts));
      signals.alerts.value = freshAlerts;

      const result = await createBackup(true);

      expect(result?.data.alerts).toEqual(freshAlerts);
      expect(result?.data.alerts).not.toEqual(staleAlerts);
    });
  });

  // New-batch P2: previously `createBackup` stored a fresh payload in
  // IndexedDB but left `signals.lastBackup` / `signals.lastBackupTxCount`
  // untouched — so the reactive backup-reminder banner continued
  // firing even though the user's data was safe. Pinned here so the
  // reminder signals move in lockstep with the real persistence.
  describe('createBackup backup-reminder sync (new-batch P2)', () => {
    it('updates lastBackup and lastBackupTxCount signals on a successful manual backup', async () => {
      signals.lastBackup.value = 0;
      signals.lastBackupTxCount.value = 0;
      signals.replaceTransactionLedger([
        { __backendId: 'tx_a', type: 'expense', amount: 1, category: 'food', description: '', date: '2026-04-01', currency: 'USD', recurring: false },
        { __backendId: 'tx_b', type: 'expense', amount: 2, category: 'food', description: '', date: '2026-04-01', currency: 'USD', recurring: false }
      ] as any);

      const result = await createBackup(true);
      expect(result).toBeTruthy();
      expect(signals.lastBackup.value).toBeGreaterThan(0);
      expect(signals.lastBackupTxCount.value).toBe(2);
    });

    it('updates the reminder signals on a scheduled (non-manual) backup too', async () => {
      signals.lastBackup.value = 0;
      signals.lastBackupTxCount.value = 0;
      signals.replaceTransactionLedger([
        { __backendId: 'tx_c', type: 'expense', amount: 5, category: 'food', description: '', date: '2026-04-01', currency: 'USD', recurring: false }
      ] as any);

      const result = await createBackup(false);
      expect(result).toBeTruthy();
      expect(signals.lastBackup.value).toBeGreaterThan(0);
      expect(signals.lastBackupTxCount.value).toBe(1);
    });

    it('persists lastBackupTxCount to storage via safeStorage.setJSON', async () => {
      signals.replaceTransactionLedger([
        { __backendId: 'tx_d', type: 'expense', amount: 7, category: 'food', description: '', date: '2026-04-01', currency: 'USD', recurring: false }
      ] as any);

      await createBackup(true);

      // `setJSON` is called with the BACKUP_REMINDER_TX_COUNT_KEY and the
      // current count; at minimum, the count value should appear in the
      // recorded call args.
      const recordedCounts = safeStorageMock.setJSON.mock.calls.map(call => call[1]);
      expect(recordedCounts).toContain(1);
    });

    it('stamps THIS backup\u2019s own metadata into settings.lastBackup / lastBackupTxCount (not the previous backup\u2019s)', async () => {
      // Simulate a prior backup: signals already carry a stale pointer
      // to "the backup we made yesterday" (different tx count than now).
      signals.lastBackup.value = 1_700_000_000_000;
      signals.lastBackupTxCount.value = 42;

      // Now the user has 3 transactions, and takes a new backup.
      signals.replaceTransactionLedger([
        { __backendId: 'tx_e', type: 'expense', amount: 1, category: 'food', description: '', date: '2026-04-20', currency: 'USD', recurring: false },
        { __backendId: 'tx_f', type: 'expense', amount: 2, category: 'food', description: '', date: '2026-04-20', currency: 'USD', recurring: false },
        { __backendId: 'tx_g', type: 'expense', amount: 3, category: 'food', description: '', date: '2026-04-20', currency: 'USD', recurring: false }
      ] as any);

      const result = await createBackup(true);
      expect(result).toBeTruthy();

      // The payload must describe THIS backup — 3 tx, timestamp >=
      // `metadata.timestamp`. If the payload resurrected the prior
      // reminder state (42 / 1_700_000_000_000), a restore would pin
      // the banner to "yesterday / 42 tx" instead of pointing at the
      // backup just loaded.
      expect(result!.data.settings.lastBackupTxCount).toBe(3);
      expect(result!.data.settings.lastBackup).toBe(result!.metadata.timestamp);
      expect(result!.data.settings.lastBackup).not.toBe(1_700_000_000_000);
    });
  });

  // CR-Apr22-F slice 1: auto-backups now snapshot SK.RECURRING and the
  // restore path (`normalizeBackupForImport`) forwards it through
  // `buildImportState` so recurring-series definitions round-trip
  // cleanly. Prior behavior dropped the series entirely, so a restore
  // resurrected historical transactions but stopped generating future
  // occurrences.
  //
  // Slice-1 addendum (Finding #10, [P2] "Auto-backup restore leaves
  // unrelated local recurring templates active"): the
  // `normalizeBackupForImport` step now coerces an absent field to
  // `{}` instead of forwarding `undefined`. Backup restore has full-
  // snapshot semantics (not partial-import semantics), so a legacy
  // backup — which predates recurring-template tracking — must wipe
  // any current local recurring templates rather than preserving
  // them alongside an otherwise fully-overwritten account. The tri-
  // state preserve-on-absent contract in `buildImportState` still
  // applies to JSON imports; the backup path opts out via the
  // normalizer.
  //
  // Placed BEFORE the `chunks monthly backup timers` test because that
  // test installs `vi.useFakeTimers()` + `vi.spyOn(window, 'setTimeout')`
  // without tearing them down. Running any test that writes to a
  // batched signal (savingsGoals, filterPresets, …) after that leaves
  // `setTimeout` in a broken state and the signal batcher's
  // `scheduleFlush` throws `ReferenceError: setTimeout is not defined`.
  describe('recurring-templates backup round-trip (CR-Apr22-F slice 1)', () => {
    const seededRecurring = {
      r1: {
        id: 'r1',
        type: 'expense' as const,
        category: 'food',
        amount: 12.5,
        description: 'Weekly coffee',
        tags: '',
        notes: '',
        startDate: '2026-01-01',
        endDate: '2099-12-31',
        recurringType: 'weekly' as const,
        originalDayOfMonth: 1,
        active: true
      }
    };

    it('snapshots SK.RECURRING from safeStorage into the backup payload during createBackup', async () => {
      safeStorageMock.getJSON.mockImplementation((key: string, fallback: unknown) =>
        key === SK.RECURRING ? seededRecurring : fallback
      );
      try {
        signals.replaceTransactionLedger([]);
        const result = await createBackup(true);

        expect(result).toBeTruthy();
        expect(result?.data.recurringTemplates).toEqual(seededRecurring);
      } finally {
        safeStorageMock.getJSON.mockImplementation((_key: string, fallback: unknown) => fallback);
      }
    });

    it('emits recurringTemplates as {} when the user has no recurring series (safeStorage default)', async () => {
      // Default mock behavior: getJSON returns the fallback (`{}`) supplied
      // at the call site. A "no series" backup carries the explicit empty
      // object so a later restore hits the present-but-empty wipe branch.
      const result = await createBackup(true);

      expect(result?.data.recurringTemplates).toEqual({});
    });

    it('forwards present recurringTemplates through normalizeBackupForImport into buildImportState', async () => {
      // Modern backup with SK.RECURRING populated → buildImportState sees
      // the field and hits the present-payload branch (writes SK.RECURRING).
      getIndexedDbBackupMock.mockResolvedValue({
        metadata: {
          id: 'backup-with-recurring',
          timestamp: Date.now(),
          version: '2.6',
          deviceId: 'device-1',
          transactionCount: 0,
  
          size: 128,
          checksum: '01020304'
        },
        data: {
          transactions: [],
          savingsGoals: {},
          monthlyAllocations: {},
          userCategories: null,
          debts: [],
          settings: {},
          recurringTemplates: seededRecurring
        }
      });

      const result = await restoreBackup('backup-with-recurring');

      expect(result).toBe(true);
      const importDataArg = (buildImportStateMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(importDataArg.recurringTemplates).toEqual(seededRecurring);
    });

    it('coerces a legacy backup\'s absent recurringTemplates to {} so restore wipes local templates (Finding #10)', async () => {
      // Slice-1 addendum: backup restore has full-snapshot semantics.
      // A legacy (pre-slice-1) backup predates SK.RECURRING tracking,
      // so at the moment the backup was captured there were effectively
      // zero persisted templates. Restoring it must leave the device in
      // that state — NOT preserve the user's interim local templates
      // that would otherwise survive an overwrite of every other key.
      // Forwarding `{}` drives buildImportState into its present-but-
      // empty wipe branch, which clears SK.RECURRING.
      getIndexedDbBackupMock.mockResolvedValue({
        metadata: {
          id: 'backup-legacy-no-recurring',
          timestamp: Date.now(),
          version: '1.5',
          deviceId: 'device-1',
          transactionCount: 0,
  
          size: 128,
          checksum: '01020304'
        },
        data: {
          transactions: [],
          savingsGoals: {},
          monthlyAllocations: {},
          userCategories: null,
          debts: [],
          settings: {}
          // NO recurringTemplates — this is the legacy shape.
        }
      });

      const result = await restoreBackup('backup-legacy-no-recurring');

      expect(result).toBe(true);
      const importDataArg = (buildImportStateMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(importDataArg.recurringTemplates).toEqual({});
    });

    it('forwards recurringTemplates: {} through so a modern "no series" backup wipes on restore', async () => {
      // Symmetric to the legacy case — a modern backup with an explicit
      // empty object signals "user has zero series," which the import
      // layer must propagate as a wipe write. Forwarding unchanged keeps
      // the tri-state distinction intact all the way to buildImportState.
      getIndexedDbBackupMock.mockResolvedValue({
        metadata: {
          id: 'backup-empty-recurring',
          timestamp: Date.now(),
          version: '2.6',
          deviceId: 'device-1',
          transactionCount: 0,
  
          size: 128,
          checksum: '01020304'
        },
        data: {
          transactions: [],
          savingsGoals: {},
          monthlyAllocations: {},
          userCategories: null,
          debts: [],
          settings: {},
          recurringTemplates: {}
        }
      });

      const result = await restoreBackup('backup-empty-recurring');

      expect(result).toBe(true);
      const importDataArg = (buildImportStateMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(importDataArg.recurringTemplates).toEqual({});
    });
  });
});
