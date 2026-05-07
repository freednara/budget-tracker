/**
 * Data & Settings Actions
 * Persistent data mutations: settings, allocations, savings goals,
 * contributions, debts, categories, templates, and currency.
 *
 * @module actions/data-actions
 */
import * as signals from '../signals.js';
import { Events } from '../event-bus.js';
import { dataSdk } from '../../data/data-manager.js';
import { generateSecureId } from '../utils-dom.js';
import { addAmounts, getTodayStr, syncCurrencyFormat } from '../utils-pure.js';
import { isTheme } from '../theme-allowlist.js';
import { trackError } from '../error-tracker.js';
import {
  SAVINGS_TRANSFER_CATEGORY_ID,
  SAVINGS_TRANSFER_NOTE_MARKER,
  SAVINGS_TRANSFER_TAG
} from '../transaction-classification.js';
import { batchUpdates, queueEvent } from './action-utils.js';
import type {
  InsightPersonality,
  FilterPreset,
  TxTemplate,
  SavingsGoal,
  SavingsContribution,
  AlertPrefs,
  MonthlyAllocation,
  RolloverSettings,
  Theme,
  Debt,
  CurrencySettings,
  SectionsConfig,
  StreakData,
  EarnedAchievement
} from '../../../types/index.js';

// ==========================================
// SETTINGS ACTIONS
// ==========================================

export const settings = {
  setCurrency(currencyCode: string, symbol: string): void {
    const next: CurrencySettings = { home: currencyCode, symbol };
    syncCurrencyFormat(next);          // update cached formatter BEFORE signal fires effects
    signals.currency.value = next;
    // CR-Apr24-I finding 74: emit event so imperative UI surfaces (month-comparison,
    // template list, locale-service) can rerender / rebuild formatters on currency change.
    queueEvent(Events.CURRENCY_CHANGED, next);
  },

  setRolloverSettings(settings: Partial<RolloverSettings>): void {
    signals.rolloverSettings.value = {
      ...(signals.rolloverSettings.value || {
        enabled: false,
        mode: 'all',
        categories: [],
        maxRollover: null,
        negativeHandling: 'zero'
      }),
      ...settings,
      // Fixes L43 (Inline-Behavior-Review rev 12): half of this merge used
      // `??` (falsy-safe) and half used `||` (truthy-only). For `mode` and
      // `negativeHandling` that mismatch is mostly cosmetic today because
      // both are non-empty string unions, but if either union ever grows a
      // legitimate empty/falsy member the `||` path would silently clobber
      // it with the default. Standardize on `??` to match `enabled` /
      // `maxRollover` and the rest of the codebase.
      enabled: settings.enabled ?? signals.rolloverSettings.value.enabled ?? false,
      mode: settings.mode ?? signals.rolloverSettings.value.mode ?? 'all',
      categories: Array.isArray(settings.categories)
        ? settings.categories
        : (signals.rolloverSettings.value.categories ?? []),
      maxRollover: settings.maxRollover ?? signals.rolloverSettings.value.maxRollover ?? null,
      negativeHandling: settings.negativeHandling ?? signals.rolloverSettings.value.negativeHandling ?? 'zero'
    };
    queueEvent(Events.ROLLOVER_SETTINGS_CHANGED, signals.rolloverSettings.value);
  },

  setPin(value: string): void {
    signals.pin.value = value;
  },

  clearPin(): void {
    signals.pin.value = '';
  },

  setInsightPersonality(personality: InsightPersonality): void {
    signals.insightPers.value = personality;
  },

  setAlerts(nextAlerts: AlertPrefs): void {
    signals.alerts.value = nextAlerts;
  },

  setTheme(theme: Theme): void {
    // Fixes M3 (Inline-Behavior-Review rev 12): this setter is the single
    // node every theme-write path terminates at:
    //   - theme.ts:setTheme          → settings.setTheme
    //   - sync-state applyKeyUpdate  → isTheme gate → settings.setTheme
    //   - modal-events dataset click → feature-event bus → theme.ts → settings.setTheme
    //   - modal-events cancel revert → settings.setTheme (direct)
    //   - import-export-events       → theme.ts:setTheme → settings.setTheme
    //   - auto-backup restore        → theme.ts:setTheme → settings.setTheme
    // Upstream validators (hydration normalizer, sync-state isTheme reject,
    // auto-backup normalizeBackupTheme) guard their boundaries, but direct
    // callers and cast-through bypasses (`theme as Theme`) land here
    // unchecked. Guarding here is the backstop that keeps the signal
    // invariant "theme.value is always 'dark' | 'light' | 'system'"
    // enforced no matter how the caller arrived.
    //
    // Clamp (not reject) so the signal stays valid — a no-op would leave
    // the caller's UI desynced from reality. trackError surfaces the bypass
    // in telemetry so the guilty call site can be fixed.
    let safeTheme: Theme = theme;
    if (!isTheme(theme)) {
      try {
        // Include the rejected payload in the error message for telemetry
        // visibility — the bad value is almost always a debugging
        // breadcrumb (e.g. "system-light" from a drifted button dataset,
        // or a number from a corrupted import).
        trackError(
          new Error(`settings.setTheme received invalid theme payload: ${JSON.stringify(theme)}`),
          { module: 'data-actions', action: 'setTheme.clamp' }
        );
      } catch {
        // Telemetry failure must never break the setter path.
      }
      safeTheme = 'dark';
    }
    signals.theme.value = safeTheme;
    queueEvent(Events.THEME_CHANGED, safeTheme);
  },

  setSections(nextSections: SectionsConfig): void {
    signals.sections.value = { ...nextSections };
  },

  setAchievements(achievements: Record<string, EarnedAchievement>): void {
    // CR-Apr24-I finding 219: runtime guard against legacy boolean-shaped
    // data that may arrive from storage hydration or cross-tab sync.
    // Coerce `{ key: true }` → `{ key: { earned: true, date: '' } }`
    // and drop non-object/non-boolean entries entirely.
    const safe: Record<string, EarnedAchievement> = {};
    for (const [key, val] of Object.entries(achievements)) {
      if (val && typeof val === 'object' && 'earned' in val) {
        safe[key] = val as EarnedAchievement;
      } else if (val === true) {
        safe[key] = { earned: true, date: '' };
      }
      // Drop false / null / other invalid entries
    }
    signals.achievements.value = safe;
  },

  setStreak(streak: StreakData): void {
    signals.streak.value = { ...streak };
  }
};

// ==========================================
// DATA ACTIONS
// ==========================================

export const data = {
  setMonthlyAllocations(allocations: Record<string, MonthlyAllocation>): void {
    signals.monthlyAlloc.value = allocations;
    queueEvent(Events.BUDGET_UPDATED, allocations);
  },

  setFilterPresets(presets: FilterPreset[]): void {
    signals.filterPresets.value = presets;
  },

  removeFilterPreset(presetId: string): void {
    signals.filterPresets.value = signals.filterPresets.value.filter(p => p.id !== presetId);
  },

  removeContributionsForGoal(goalId: string): void {
    signals.savingsContribs.value = signals.savingsContribs.value.filter(c => c.goalId !== goalId);
  },

  setTxTemplates(templates: TxTemplate[]): void {
    signals.txTemplates.value = templates;
  },

  removeTxTemplate(templateId: string): void {
    signals.txTemplates.value = signals.txTemplates.value.filter(t => t.id !== templateId);
  },

  setCurrencySettings(currency: CurrencySettings): void {
    syncCurrencyFormat(currency);      // update cached formatter BEFORE signal fires effects
    signals.currency.value = { ...currency };
    // CR-Apr24-I finding 74: same emission path as setCurrency().
    queueEvent(Events.CURRENCY_CHANGED, { ...currency });
  }
};

// ==========================================
// SAVINGS GOAL ACTIONS
// ==========================================

/**
 * Input shape for `savingsGoals.addGoal`.
 *
 * rev 12 #34 (SavingsGoal type unification — consumer-site cleanup).
 * Callers MUST use the modern `{target, saved}` naming, matching both the
 * stored `SavingsGoal` shape and the hydration-boundary normalizer in
 * `state-hydration.normalizeSavingsGoalsRecord` (landed with H7).
 *
 * Why this matters. Before this change the input layer accepted legacy
 * `{target_amount, saved_amount}` and did a silent field rename inside
 * `addGoal`. That mapping looked harmless, but it was the root cause of
 * H7 — two naming conventions coexisting across the data layer meant any
 * new consumer could legitimately pick either shape, and a mixed dataset
 * then needed the runtime `'target_amount' in goal` branch that H7 tore
 * out. By forcing the modern shape at the input boundary, we collapse
 * the split end-to-end: input → signal → persist → hydrate all speak
 * `{target, saved}`.
 */
interface SavingsGoalData {
  name: string;
  target: number;
  saved?: number;
  deadline?: string;
  /** Optional emoji icon for display. */
  icon?: string;
}

export const savingsGoals = {
  setGoals(goals: Record<string, SavingsGoal>, options: { emitEvent?: boolean } = {}): void {
    signals.savingsGoals.value = { ...goals };
    if (options.emitEvent !== false) {
      queueEvent(Events.SAVINGS_UPDATED, goals);
    }
  },

  setContributions(contributions: SavingsContribution[]): void {
    signals.savingsContribs.value = [...contributions];
  },

  addGoal(goalData: SavingsGoalData): string {
    // rev 12 L42: reject bogus targets at the source. Prevents NaN/Infinity/
    // <=0 values from reaching persistence, and stops downstream consumers
    // (insights.ts, progress bars) from needing to mask the bad state with
    // silent fallbacks like `target || 1`. Callers either front-validate
    // (UI forms) or already wrap in try/catch (sample-data seeder).
    if (!Number.isFinite(goalData.target) || goalData.target <= 0) {
      trackError(
        `savingsGoals.addGoal: invalid target "${String(goalData.target)}"`,
        { module: 'data-actions', action: 'addGoal_invalid_target' },
        'error'
      );
      throw new RangeError(
        `Savings goal target must be a positive finite number (received: ${String(goalData.target)})`
      );
    }

    const id = `sg_${generateSecureId()}`;
    // rev 12 #34: no field rename here — `goalData` already uses the modern
    // `{target, saved}` naming enforced by `SavingsGoalData` above.
    //
    // CR-Apr22-G slice 3: stamp a `createdAt` wall-clock date on every new
    // goal so the transaction-detail drill-down's synthetic starting-balance
    // row can anchor at the goal's actual creation date instead of "today"
    // when no real contributions have landed yet. Stored as YYYY-MM-DD to
    // match the tx.date contract and survive backup roundtrips through
    // `normalizeSavingsGoal`.
    const newGoal: SavingsGoal = {
      id,
      name: goalData.name,
      target: goalData.target,
      saved: goalData.saved ?? 0,
      deadline: goalData.deadline || '',
      createdAt: getTodayStr(),
      ...(goalData.icon ? { icon: goalData.icon } : {})
    };

    signals.savingsGoals.value = { ...signals.savingsGoals.value, [id]: newGoal };
    queueEvent(Events.SAVINGS_GOAL_ADDED, { id, goal: newGoal });
    return id;
  },

  /**
   * Rename a savings goal in a rename-safe way.
   *
   * CR-Apr22-G slice 3: the transaction-detail drill-down's description
   * fallback used to match on `Savings Transfer: ${currentGoalName}`.
   * That broke any pre-id-marker legacy contribution row the moment the
   * goal was renamed — the description still carried the old name but
   * the filter was looking for the new one. This action unshifts the
   * *prior* name onto `historicalNames` before overwriting `name`, so
   * the description-fallback linker can match against the full history
   * and keep legacy rows visible after rename.
   *
   * Returns `false` when the goal doesn't exist or the new name is
   * empty/unchanged (no-op guard so historicalNames doesn't accumulate
   * duplicates on re-saves). The current production UI doesn't expose
   * rename yet; this action is in place so it's rename-ready when a
   * future slice wires the edit flow.
   */
  renameGoal(goalId: string, newName: string): boolean {
    const current = signals.savingsGoals.value[goalId];
    if (!current) return false;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === current.name) return false;

    const priorHistory = current.historicalNames ?? [];
    const updated: SavingsGoal = {
      ...current,
      name: trimmed,
      historicalNames: [current.name, ...priorHistory]
    };
    signals.savingsGoals.value = { ...signals.savingsGoals.value, [goalId]: updated };
    queueEvent(Events.SAVINGS_UPDATED, signals.savingsGoals.value);
    return true;
  },

  deleteGoal(goalId: string): boolean {
    const currentGoals = signals.savingsGoals.value;
    if (!currentGoals[goalId]) return false;

    // UX-03: Emit event inside batch so listeners see consistent state
    batchUpdates(() => {
      const { [goalId]: _removed, ...remaining } = currentGoals;
      signals.savingsGoals.value = remaining;
      data.removeContributionsForGoal(goalId);
      queueEvent(Events.SAVINGS_GOAL_DELETED, { id: goalId });
    });

    return true;
  },

  async addContribution(goalId: string, amount: number, date?: string): Promise<boolean> {
    if (amount <= 0) return false;
    const goal = signals.savingsGoals.value[goalId];
    if (!goal) return false;

    // Local-time default, not UTC toISOString — see ADR-001 §9.5 Step 8.
    const contribDate = date || getTodayStr();

    // Use atomic ledger for the transaction
    const txResult = await dataSdk.create({
      type: 'expense',
      category: SAVINGS_TRANSFER_CATEGORY_ID,
      amount: amount,
      description: `Savings Transfer: ${goal.name}`,
      notes: `${SAVINGS_TRANSFER_NOTE_MARKER} Contribution to goal: ${goal.name} [id:${goalId}]`,
      tags: `savings,goal,${SAVINGS_TRANSFER_TAG}`,
      date: contribDate
    });

    if (!txResult.isOk) return false;

    // Round 7 fix: Check if goal still exists before committing state.
    // If it was deleted during the await, rollback the transaction and abort.
    const currentGoal = signals.savingsGoals.value[goalId];
    if (!currentGoal) {
      // Race detected — goal deleted while ledger write was in-flight.
      // Delete the orphaned transaction to prevent corruption.
      if (txResult.data) {
        await dataSdk.delete(txResult.data);
      }
      return false;
    }

    batchUpdates(() => {
      // Re-read the goal from current signal state — not the snapshot captured
      // above the `await`. Two concurrent addContribution calls both see the
      // pre-await `goal.saved`; if we write `goal.saved + amount` from the
      // captured snapshot the second writer clobbers the first. Reading fresh
      // inside batchUpdates (which is synchronous and runs after the async
      // gap) means each writer adds to the currently-persisted balance.
      //
      // Amount accumulation uses addAmounts (cents math) so the displayed
      // running balance doesn't drift from the sum of contribution txns and
      // the saved >= target completion check stays byte-accurate.
      //
      // Fixes C8 + M7 (Inline-Behavior-Review rev 12).
      const updatedGoal = {
        ...currentGoal,
        saved: addAmounts(currentGoal.saved || 0, amount)
      };
      signals.savingsGoals.value = { ...signals.savingsGoals.value, [goalId]: updatedGoal };

      const newContrib: SavingsContribution = {
        id: `sc_${generateSecureId()}`,
        date: contribDate,
        // Always record wall-clock time so velocity math isn't distorted by backdated contributions.
        createdAt: new Date().toISOString(),
        goalId,
        amount,
        transactionId: txResult.data?.__backendId
      };
      signals.savingsContribs.value = [...signals.savingsContribs.value, newContrib];
    });

    queueEvent(Events.SAVINGS_CONTRIBUTION_ADDED, { goalId, amount });
    return true;
  }
};

// ==========================================
// DEBT ACTIONS
// ==========================================

// ==========================================
// ACHIEVEMENT ACTIONS
// ==========================================

export const achievements = {
  /**
   * Award an achievement and persist it as part of the actions contract.
   *
   * Fixes M25a (Inline-Behavior-Review rev 12): this is the state-actions
   * routing layer for the gamification/ tree. Previously `awardAchievement`
   * in `features/gamification/achievements.ts` performed a direct
   * `signals.achievements.value = { ... }` write — the only signal
   * mutation in the entire gamification surface that bypassed the actions
   * layer. Callers (10 sites in `checkAchievements`, 3 sites in
   * `import-export-events.data_pro`, plus the feature-event dispatcher)
   * now go through this setter so any future cross-cutting concern (event
   * emission, telemetry, cross-module reactivity, test doubles) has one
   * place to land.
   *
   * Idempotent: re-awarding an existing key is a no-op. Returns `true`
   * when a new badge was awarded, `false` when the key was already earned
   * — lets callers gate side-effects (celebration animation, achievement
   * toast) on the award-was-new signal without an extra `has()` probe.
   */
  award(key: string, date?: string): boolean {
    const current = signals.achievements.value as Record<string, EarnedAchievement>;
    if (current[key]) return false;
    const awardedAt = date || new Date().toISOString();
    const next: EarnedAchievement = { earned: true, date: awardedAt };
    signals.achievements.value = { ...current, [key]: next };
    return true;
  }
};

// ==========================================
// DEBT ACTIONS
// ==========================================

export const debts = {
  setDebts(nextDebts: Debt[]): void {
    signals.debts.value = [...nextDebts];
  },

  addDebt(nextDebt: Debt): void {
    signals.debts.value = [...signals.debts.value, nextDebt];
  },

  replaceDebt(debtId: string, nextDebt: Debt): boolean {
    const exists = signals.debts.value.some((debt) => debt.id === debtId);
    if (!exists) return false;
    signals.debts.value = signals.debts.value.map((debt) => debt.id === debtId ? nextDebt : debt);
    return true;
  },

  removeDebt(debtId: string): boolean {
    const nextDebts = signals.debts.value.filter((debt) => debt.id !== debtId);
    if (nextDebts.length === signals.debts.value.length) return false;
    signals.debts.value = nextDebts;
    return true;
  }
};
