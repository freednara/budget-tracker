/**
 * Tests for the one-time budget_tracker_* → harbor_* key migration.
 *
 * Verifies that `migrateStorageKeyNames()`:
 *   - Copies old keys to new names and removes the originals
 *   - Preserves the 2 migration-era flags under their legacy names
 *   - Renames the unified rollback-failure marker to the harbor_* name
 *   - Is idempotent (no-op on second run)
 *   - Handles an empty localStorage gracefully
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { migrateStorageKeyNames } from '../js/modules/data/key-migration.js';

describe('migrateStorageKeyNames', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renames budget_tracker_* keys to harbor_*', () => {
    localStorage.setItem('budget_tracker_transactions', '[]');
    localStorage.setItem('budget_tracker_theme', '"dark"');
    localStorage.setItem('budget_tracker_pin', '""');

    migrateStorageKeyNames();

    expect(localStorage.getItem('harbor_transactions')).toBe('[]');
    expect(localStorage.getItem('harbor_theme')).toBe('"dark"');
    expect(localStorage.getItem('harbor_pin')).toBe('""');

    // Old keys should be gone
    expect(localStorage.getItem('budget_tracker_transactions')).toBeNull();
    expect(localStorage.getItem('budget_tracker_theme')).toBeNull();
    expect(localStorage.getItem('budget_tracker_pin')).toBeNull();
  });

  it('preserves the 2 migration-era flags under their legacy names', () => {
    localStorage.setItem('budget_tracker_idb_migration', '{"completed":true}');
    localStorage.setItem('budget_tracker_migrated_to_idb', '1700000000000');
    localStorage.setItem('budget_tracker_theme', '"light"');

    migrateStorageKeyNames();

    // Preserved keys must still exist under their OLD names — renaming
    // either would cause migration.ts to conclude "migration hasn't run"
    // and re-run it against already-migrated IDB data (ADR-001 §9.4).
    expect(localStorage.getItem('budget_tracker_idb_migration')).toBe('{"completed":true}');
    expect(localStorage.getItem('budget_tracker_migrated_to_idb')).toBe('1700000000000');

    // Non-preserved key was renamed
    expect(localStorage.getItem('harbor_theme')).toBe('"light"');
    expect(localStorage.getItem('budget_tracker_theme')).toBeNull();
  });

  it('renames a legacy rollback-failure marker onto the unified harbor_ name', () => {
    // Before the unification fix this key was in the PRESERVE set, which
    // stranded legacy markers away from the storage-manager reader that
    // only looks at harbor_storage_rollback_failed. Now it should rename
    // like any other user-data key so the failsafe LS fallback kicks in.
    localStorage.setItem('budget_tracker_storage_rollback_failed', '{"reason":"test"}');

    migrateStorageKeyNames();

    expect(localStorage.getItem('budget_tracker_storage_rollback_failed')).toBeNull();
    expect(localStorage.getItem('harbor_storage_rollback_failed')).toBe('{"reason":"test"}');
  });

  it('is idempotent — second run is a no-op', () => {
    localStorage.setItem('budget_tracker_transactions', '[]');

    migrateStorageKeyNames();
    expect(localStorage.getItem('harbor_transactions')).toBe('[]');

    // Tamper: add a new old-prefix key after migration
    localStorage.setItem('budget_tracker_new_key', '"surprise"');

    // Second call should be a no-op because the done marker is set
    migrateStorageKeyNames();
    expect(localStorage.getItem('budget_tracker_new_key')).toBe('"surprise"');
    expect(localStorage.getItem('harbor_new_key')).toBeNull();
  });

  it('handles empty localStorage without error', () => {
    migrateStorageKeyNames();
    expect(localStorage.getItem('harbor_key_migration_done')).not.toBeNull();
  });

  it('does not touch non-budget_tracker_ keys', () => {
    localStorage.setItem('some_other_app_key', 'value');
    localStorage.setItem('budget_tracker_theme', '"dark"');

    migrateStorageKeyNames();

    expect(localStorage.getItem('some_other_app_key')).toBe('value');
    expect(localStorage.getItem('harbor_theme')).toBe('"dark"');
  });

  it('keeps the new key value when both old and new keys exist (collision guard)', () => {
    // Simulate a partial prior migration or manual edit: both keys exist
    localStorage.setItem('budget_tracker_transactions', '[{"id":"old"}]');
    localStorage.setItem('harbor_transactions', '[{"id":"new"}]');
    localStorage.setItem('budget_tracker_theme', '"dark"');
    localStorage.setItem('harbor_theme', '"light"');

    // Also add one key with no collision for baseline
    localStorage.setItem('budget_tracker_pin', '"1234"');

    migrateStorageKeyNames();

    // Collisions: new key value wins, old key is removed
    expect(localStorage.getItem('harbor_transactions')).toBe('[{"id":"new"}]');
    expect(localStorage.getItem('budget_tracker_transactions')).toBeNull();
    expect(localStorage.getItem('harbor_theme')).toBe('"light"');
    expect(localStorage.getItem('budget_tracker_theme')).toBeNull();

    // Non-collision: normal migration
    expect(localStorage.getItem('harbor_pin')).toBe('"1234"');
    expect(localStorage.getItem('budget_tracker_pin')).toBeNull();
  });
});
