/**
 * Envelope Budget Component
 *
 * Reactive component that renders budget allocation cards (envelope budgeting)
 * with automatic updates when allocations or transactions change.
 *
 * @module components/envelope-budget
 */
'use strict';

import { effect, computed, signal } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { getMonthAlloc } from '../core/month-alloc.js';
import { html, render, nothing, styleMap } from '../core/lit-helpers.js';
import { fmtCur } from '../core/utils-pure.js';
import { getUnassigned } from '../features/financial/calculations.js';
import { getCatInfo } from '../core/categories.js';
import { expenseCategories } from '../core/category-store.js';
import { isRolloverEnabled, calculateMonthRollovers } from '../features/financial/rollover.js';
import DOM from '../core/dom-cache.js';

/** Currently selected category for detail panel */
export const selectedBudgetCategory = signal<string | null>(null);

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Envelope budget data with rollover support
 */
interface EnvelopeCardData {
  categoryId: string;
  emoji: string;
  name: string;
  spent: number;
  effectiveBudget: number;
  rollover: number;
  percentage: number;
  isOver: boolean;
  fillModifier: string;
}

const envelopeCards = computed((): EnvelopeCardData[] => {
  const currentMk = signals.currentMonth.value;
  // Rev 12 / #39 M4 (Inline-Behavior-Review): getMonthAlloc replaces
  // `signals.monthlyAlloc.value[mk] || {}` — emits once-per-session
  // trackError on a genuine miss (allocations exist for other months but
  // not currentMk); a fully-empty allocMap stays silent, since the
  // `Object.keys(alloc).length === 0` short-circuit on the next line is
  // the expected new-user / pre-hydration state.
  const alloc = getMonthAlloc(currentMk, signals.monthlyAlloc.value);

  // Track transaction changes via length + a content hash (avoids full array reference dependency
  // which would cause this expensive computed to refire on every unrelated signal batch)
  const _txLen = signals.transactions.value.length;
  const _txHash = signals.currentMonthTotals.value.expenses; // Changes when tx amounts change

  if (Object.keys(alloc).length === 0) return [];

  const rolloverEnabled = isRolloverEnabled();
  const rollovers = rolloverEnabled ? calculateMonthRollovers(currentMk) : {};
  // Use pre-computed per-category expenses (single O(N) pass) instead of per-category filter
  const expByCat = signals.expensesByCategory.value;

  // Build cards from allocation entries
  const cards = Object.entries(alloc).map(([catId, amt]) => {
    const cat = getCatInfo('expense', catId);
    const spent = expByCat[catId] || 0;
    const rollover = rollovers[catId] || 0;
    const effectiveBudget = rolloverEnabled ? (amt + rollover) : amt;
    const percentage = effectiveBudget > 0 ? Math.min((spent / effectiveBudget) * 100, 100) : 0;
    const isOver = spent > effectiveBudget;
    const fillModifier = isOver ? 'goal-fill--over' : percentage > 80 ? 'goal-fill--warning' : 'goal-fill--ok';

    return {
      categoryId: catId,
      emoji: cat.emoji,
      name: cat.name,
      spent,
      effectiveBudget,
      rollover,
      percentage,
      isOver,
      fillModifier
    };
  });

  // Sort to match preset category order (same order as Plan Budget modal)
  const catOrder = expenseCategories.value;
  const orderIndex = new Map(catOrder.map((c, i) => [c.id, i]));
  cards.sort((a, b) => {
    const ai = orderIndex.get(a.categoryId) ?? 999;
    const bi = orderIndex.get(b.categoryId) ?? 999;
    return ai - bi;
  });

  return cards;
});

/**
 * Unassigned budget amount
 */
const unassignedAmount = computed(() => {
  return getUnassigned(signals.currentMonth.value);
});

/**
 * Whether envelope section should be visible
 */
const isEnvelopeVisible = computed(() => {
  return signals.sections.value.envelope;
});

/**
 * Whether rollover feature is enabled
 */
const rolloverEnabled = computed(() => isRolloverEnabled());

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive envelope budget component
 * Returns cleanup function to dispose effects
 */
export function mountEnvelopeBudget(): () => void {
  const section = DOM.get('envelope-section');
  const grid = DOM.get('envelope-grid');
  const unassignedEl = DOM.get('unassigned-amount');

  if (!section || !grid) {
    return () => {}; // No cleanup needed
  }

  // Header elements to hide when empty
  const headerActions = section.querySelector('.app-panel__actions');
  const unassignedStat = DOM.get('envelope-unassigned-stat');

  // Effect for section visibility
  const cleanupVisibility = effect(() => {
    if (isEnvelopeVisible.value) {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  });

  // Effect for unassigned amount (re-runs on currency change for formatting)
  const cleanupUnassigned = effect(() => {
    const _cur = signals.currency.value;  // subscribe to currency changes
    if (unassignedEl) {
      const amount = unassignedAmount.value;
      unassignedEl.textContent = fmtCur(amount);
      unassignedEl.classList.remove('text-accent', 'text-expense');
      unassignedEl.classList.add(amount >= 0 ? 'text-accent' : 'text-expense');
    }
  });

  // Mobile toggle for collapsible envelope list
  const toggleBtn = DOM.get('envelope-toggle');
  const toggleText = DOM.get('envelope-toggle-text');
  const toggleIcon = DOM.get('envelope-toggle-icon');
  const COLLAPSE_THRESHOLD = 5;

  function updateToggleVisibility(count: number): void {
    if (!toggleBtn || !grid) return;
    if (count > COLLAPSE_THRESHOLD) {
      toggleBtn.style.removeProperty('display');
      const isCollapsed = grid.classList.contains('envelope-grid--collapsed');
      if (toggleText) toggleText.textContent = isCollapsed ? `Show all (${count})` : 'Show less';
      if (toggleIcon) toggleIcon.textContent = isCollapsed ? '▾' : '▴';
      toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    } else {
      toggleBtn.style.display = 'none';
      grid.classList.remove('envelope-grid--collapsed');
    }
  }

  if (toggleBtn && grid) {
    toggleBtn.addEventListener('click', () => {
      grid.classList.toggle('envelope-grid--collapsed');
      const count = envelopeCards.value.length;
      updateToggleVisibility(count);
    });
  }

  // Effect for envelope cards rendering (re-runs on currency change for formatting)
  const cleanupCards = effect(() => {
    const _cur = signals.currency.value;  // subscribe to currency changes
    const cards = envelopeCards.value;
    const showRollover = rolloverEnabled.value;

    if (cards.length === 0) {
      if (headerActions) headerActions.classList.add('hidden');
      if (unassignedStat) unassignedStat.classList.add('hidden');
      render(
        html`
          <div class="app-panel-empty">
            <div class="app-panel-empty__icon">📋</div>
            <p class="app-panel-empty__title">No budget allocated yet</p>
            <p class="app-panel-empty__copy">Give every dollar a job — set category targets so the dashboard can track your pace.</p>
            <button type="button"
                    class="empty-state-cta mt-3 px-4 py-2 rounded-lg text-sm font-bold"
                    data-action="plan-budget">
              ✏️ Plan Budget
            </button>
          </div>
        `,
        grid
      );
      updateToggleVisibility(0);
      return;
    }

    // Show header controls when cards exist
    if (headerActions) headerActions.classList.remove('hidden');
    if (unassignedStat) unassignedStat.classList.remove('hidden');

    const selected = selectedBudgetCategory.value;
    render(
      html`
        ${cards.map(card => html`
          <div class="envelope-card flex items-center gap-3 p-3 rounded-lg ${selected === card.categoryId ? 'envelope-card--selected' : ''}"
               data-cat-id=${card.categoryId}
               @click=${() => { selectedBudgetCategory.value = card.categoryId; }}
               @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedBudgetCategory.value = card.categoryId; } }}
               role="button" tabindex="0" aria-pressed=${selected === card.categoryId ? 'true' : 'false'}
               aria-label="${`Select ${card.name} budget category`}">
            <span class="text-lg">${card.emoji}</span>
            <div class="flex-1 min-w-0">
              <div class="flex justify-between items-baseline text-xs mb-1 gap-2">
                <span class="envelope-card__name font-bold truncate">
                  ${card.name}
                  ${showRollover && card.rollover !== 0
                    ? html`<span class="text-xs ml-1 ${card.rollover > 0 ? 'envelope-card__rollover--positive' : 'envelope-card__rollover--negative'}">(${card.rollover > 0 ? '+' : ''}${fmtCur(card.rollover)} rollover)</span>`
                    : nothing}
                </span>
                <span class="envelope-card__amounts flex-shrink-0">
                  <span class="font-bold ${card.isOver ? 'envelope-card__amount--over' : 'envelope-card__amount--ok'}">${fmtCur(card.spent)}</span>
                  <span class="envelope-card__budget-label"> of ${fmtCur(card.effectiveBudget)}</span>
                </span>
              </div>
              <div class="goal-bar" role="progressbar" aria-valuenow=${Math.round(card.percentage)} aria-valuemin="0" aria-valuemax="100" aria-label="${card.name} budget usage">
                <div class="goal-fill ${card.fillModifier}" style=${styleMap({ width: `${card.percentage}%` })}></div>
              </div>
            </div>
          </div>
        `)}
      `,
      grid
    );
    updateToggleVisibility(cards.length);
  });

  // Return cleanup function
  return () => {
    cleanupVisibility();
    cleanupUnassigned();
    cleanupCards();
  };
}
