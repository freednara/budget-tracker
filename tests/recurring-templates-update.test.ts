/**
 * Locking tests for `updateRecurringTemplate()` input sanitization.
 *
 * Design-Review-Apr21 (new batch, Commit C of 7k):
 *
 *   - [P2] blind `Object.assign(template, updates)` let callers mutate
 *     the template's `id`, silently desynchronizing the Map key from
 *     the stored template's own id and breaking later `.get(newId)`.
 *   - [P3] the same path accepted arbitrary writes to
 *     `lastGeneratedDate`, `originalDayOfMonth`, `active`, and
 *     `recurringType` with zero validation, which could rewind
 *     generation state, break month-end cadence, or land a
 *     `recurringType` outside the union that
 *     `calculateNextOccurrenceDate()` switches on (no default branch
 *     → template stranded on its last-known date forever).
 *
 * The fix sanitizes the update payload and silently drops fields that
 * don't pass validation. These tests pin that contract so a future
 * "just re-add Object.assign" regression surfaces immediately.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock safe-storage so the module-level loadRecurringTemplates() call
// during import doesn't poke real localStorage.
vi.mock('../js/modules/core/safe-storage.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/core/safe-storage.js')>(
    '../js/modules/core/safe-storage.js'
  );
  return {
    ...actual,
    safeStorage: {
      getJSON: vi.fn(() => ({})),
      setJSON: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
  };
});

// Stub data-manager so the create path never touches a real backend.
vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    create: vi.fn().mockResolvedValue({ isOk: true, data: null }),
    update: vi.fn().mockResolvedValue({ isOk: true, data: null }),
    delete: vi.fn().mockResolvedValue({ isOk: true }),
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

import {
  loadRecurringTemplates,
  updateRecurringTemplate,
  clearRecurringTemplates,
  type RecurringTemplate,
} from '../js/modules/data/recurring-templates.js';
import { safeStorage } from '../js/modules/core/safe-storage.js';

const SEED_ID = 'tpl_seed';

function makeSeed(): RecurringTemplate {
  return {
    id: SEED_ID,
    type: 'expense',
    category: 'groceries',
    amount: 100,
    description: 'Seed description',
    tags: 'weekly,grocery',
    notes: 'seed notes',
    startDate: '2025-01-01',
    endDate: '2099-12-31',
    recurringType: 'weekly',
    originalDayOfMonth: 1,
    lastGeneratedDate: '2025-06-01',
    active: true,
  };
}

function reseedTemplate(template: RecurringTemplate): void {
  (safeStorage.getJSON as ReturnType<typeof vi.fn>).mockReturnValue({
    [template.id]: template,
  });
  loadRecurringTemplates();
}

describe('updateRecurringTemplate — input sanitization', () => {
  beforeEach(() => {
    clearRecurringTemplates();
    vi.clearAllMocks();
  });

  it('strips attempts to mutate `id` so the Map key stays authoritative', () => {
    reseedTemplate(makeSeed());

    // Updates object claims the template's id is now 'tpl_hijack'.
    const ok = updateRecurringTemplate(SEED_ID, {
      id: 'tpl_hijack',
      description: 'renamed',
    } as Partial<RecurringTemplate>);

    expect(ok).toBe(true);

    // The write-through inspects what was persisted. The persisted map
    // must still be keyed by SEED_ID, and the template's own `id` must
    // match SEED_ID (not 'tpl_hijack').
    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    expect(setJsonMock).toHaveBeenCalledTimes(1);
    const [, persisted] = setJsonMock.mock.calls[0] as [string, Record<string, RecurringTemplate>];
    expect(Object.keys(persisted)).toEqual([SEED_ID]);
    expect(persisted[SEED_ID]?.id).toBe(SEED_ID);
    // The legitimate field (description) was applied.
    expect(persisted[SEED_ID]?.description).toBe('renamed');
  });

  it('drops `recurringType` values outside the RecurringType union', () => {
    reseedTemplate(makeSeed());

    updateRecurringTemplate(SEED_ID, {
      recurringType: 'hourly' as RecurringTemplate['recurringType'],
    });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const [, persisted] = setJsonMock.mock.calls[0] as [string, Record<string, RecurringTemplate>];
    // Must preserve the prior value ('weekly') rather than write junk.
    expect(persisted[SEED_ID]?.recurringType).toBe('weekly');
  });

  it('accepts a valid RecurringType update', () => {
    reseedTemplate(makeSeed());

    updateRecurringTemplate(SEED_ID, { recurringType: 'monthly' });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const [, persisted] = setJsonMock.mock.calls[0] as [string, Record<string, RecurringTemplate>];
    expect(persisted[SEED_ID]?.recurringType).toBe('monthly');
  });

  it('drops out-of-range `originalDayOfMonth` values', () => {
    reseedTemplate(makeSeed());

    updateRecurringTemplate(SEED_ID, { originalDayOfMonth: 0 });
    updateRecurringTemplate(SEED_ID, { originalDayOfMonth: 32 });
    updateRecurringTemplate(SEED_ID, { originalDayOfMonth: Number.NaN });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const lastCallIdx = setJsonMock.mock.calls.length - 1;
    const [, persisted] = setJsonMock.mock.calls[lastCallIdx] as [string, Record<string, RecurringTemplate>];
    // Prior value (1) survives every bad write.
    expect(persisted[SEED_ID]?.originalDayOfMonth).toBe(1);
  });

  it('accepts in-range `originalDayOfMonth` updates and truncates to integer', () => {
    reseedTemplate(makeSeed());

    updateRecurringTemplate(SEED_ID, { originalDayOfMonth: 15.7 });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const [, persisted] = setJsonMock.mock.calls[0] as [string, Record<string, RecurringTemplate>];
    expect(persisted[SEED_ID]?.originalDayOfMonth).toBe(15);
  });

  it('drops non-boolean `active` values', () => {
    reseedTemplate(makeSeed());

    // 'false' string used to flip active via the truthy-coerce path.
    updateRecurringTemplate(SEED_ID, {
      active: 'false' as unknown as boolean,
    });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const [, persisted] = setJsonMock.mock.calls[0] as [string, Record<string, RecurringTemplate>];
    expect(persisted[SEED_ID]?.active).toBe(true); // unchanged
  });

  it('accepts a strict-boolean `active` update', () => {
    reseedTemplate(makeSeed());

    updateRecurringTemplate(SEED_ID, { active: false });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const [, persisted] = setJsonMock.mock.calls[0] as [string, Record<string, RecurringTemplate>];
    expect(persisted[SEED_ID]?.active).toBe(false);
  });

  it('drops malformed `lastGeneratedDate` strings', () => {
    reseedTemplate(makeSeed());

    // Bad shapes: free-form, calendar-invalid, wrong type.
    updateRecurringTemplate(SEED_ID, {
      lastGeneratedDate: 'tomorrow' as unknown as string,
    });
    updateRecurringTemplate(SEED_ID, {
      lastGeneratedDate: '2026-02-30',
    });
    updateRecurringTemplate(SEED_ID, {
      lastGeneratedDate: 1234 as unknown as string,
    });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const lastCallIdx = setJsonMock.mock.calls.length - 1;
    const [, persisted] = setJsonMock.mock.calls[lastCallIdx] as [string, Record<string, RecurringTemplate>];
    // Prior seed value survives every bad rewind attempt.
    expect(persisted[SEED_ID]?.lastGeneratedDate).toBe('2025-06-01');
  });

  it('accepts a well-formed `lastGeneratedDate`', () => {
    reseedTemplate(makeSeed());

    updateRecurringTemplate(SEED_ID, { lastGeneratedDate: '2025-07-01' });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const [, persisted] = setJsonMock.mock.calls[0] as [string, Record<string, RecurringTemplate>];
    expect(persisted[SEED_ID]?.lastGeneratedDate).toBe('2025-07-01');
  });

  it('drops malformed `startDate` / `endDate` while allowing legitimate updates', () => {
    reseedTemplate(makeSeed());

    updateRecurringTemplate(SEED_ID, {
      startDate: 'not a date',
      endDate: '2099-13-40',
    });

    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    const [, persisted] = setJsonMock.mock.calls[0] as [string, Record<string, RecurringTemplate>];
    expect(persisted[SEED_ID]?.startDate).toBe('2025-01-01'); // unchanged
    expect(persisted[SEED_ID]?.endDate).toBe('2099-12-31');    // unchanged
  });

  it('returns false and does not write when template id is unknown', () => {
    reseedTemplate(makeSeed());

    const ok = updateRecurringTemplate('tpl_does_not_exist', {
      description: 'ignored',
    });

    expect(ok).toBe(false);
    const setJsonMock = safeStorage.setJSON as ReturnType<typeof vi.fn>;
    expect(setJsonMock).not.toHaveBeenCalled();
  });
});
