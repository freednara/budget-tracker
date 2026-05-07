// @vitest-environment node
/**
 * Migration Key Preservation Contract Test
 *
 * These keys track whether a user's LocalStorage→IndexedDB migration has
 * already run. Renaming them would cause the migration module to conclude
 * "migration hasn't happened" and re-run it — potentially overwriting live
 * IndexedDB data with stale LocalStorage snapshots.
 *
 * This test exists specifically to catch a future find-and-replace or
 * codemod that accidentally renames the preserved keys. If it fails, the
 * fix is to REVERT the rename on these specific literals, not to update
 * this test.
 *
 * See ADR-001 §9.4 for full rationale.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('migration key preservation', () => {
  const migrationSrc = readFileSync(
    resolve(process.cwd(), 'js/modules/data/migration.ts'),
    'utf8'
  );

  it('migration-complete flag keys must remain under their legacy names', () => {
    // These 2 literals MUST NOT be renamed to harbor_* — ever. They are
    // the markers migration.ts uses to detect "migration already ran";
    // renaming them makes the app re-run the LS → IDB migration against
    // already-migrated data.
    //
    // NOTE: `budget_tracker_storage_rollback_failed` used to be in this
    // contract but was dropped — it was a dead letter after the harbor_*
    // rename (no production reader looked at the legacy name) and has
    // been unified onto `harbor_storage_rollback_failed`, which the
    // storage-manager runtime path already writes and reads.
    expect(migrationSrc).toContain("'budget_tracker_idb_migration'");
    expect(migrationSrc).toContain("'budget_tracker_migrated_to_idb'");
    expect(migrationSrc).not.toContain("'budget_tracker_storage_rollback_failed'");
    expect(migrationSrc).toContain("'harbor_storage_rollback_failed'");
  });

  it('preservation comments are present above each legacy key', () => {
    expect(migrationSrc).toContain('PRESERVED ACROSS HARBOR LEDGER RENAME');
  });
});
