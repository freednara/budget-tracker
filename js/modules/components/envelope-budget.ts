/**
 * Envelope Budget Component
 *
 * Reactive component that renders budget allocation cards (envelope budgeting)
 * with automatic updates when allocations or transactions change.
 *
 * @module components/envelope-budget
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render, nothing, styleMap } from '../core/lit-helpers.js';
import { fmtCur } from '../core/utils.js';
import { getUnassigned, getMonthExpByCat } from '../features/financial/calculations.js';
import { getCatInfo } from '../core/categories.js';
import { isRolloverEnabled, getEffectiveBudget, calculateMonthRollovers } from '../features/financial/rollover.js';
import DOM from '../core/dom-cache.js';

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
  fillColor: string;
}

const envelopeCards = computed((): EnvelopeCardData[] => {
  const currentMk = signals.currentMonth.value;
  const alloc = signals.monthlyAlloc.value[currentMk] || {};

  // Track transaction changes via length + a content hash (avoids full array reference dependency
  // which would cause this expensive computed to refire on every unrelated signal batch)
  const _txLen = signals.transactions.value.length;
  const _txHash = signals.currentMonthTotals.value.expenses; // Changes when tx amounts change

  if (Object.keys(alloc).length === 0) return [];

  const rolloverEnabled = isRolloverEnabled();
  const rollovers = rolloverEnabled ? calculateMonthRollovers(currentMk) : {};
  // Use pre-computed per-category expenses (single O(N) pass) instead of per-category filter
  const expByCat = signals.expensesByCategory.value;

  return Object.entries(alloc).map(([catId, amt]) => {
    const cat = getCatInfo('expense', catId);
    const spent = expByCat[catId] || 0;
    const rollover = rollovers[catId] || 0;
    const effectiveBudget = rolloverEnabled ? (amt + rollover) : amt;
    const percentage = effectiveBudget > 0 ? Math.min((spent / effectiveBudget) * 100, 100) : 0;
    const isOver = spent > effectiveBudget;
    const fillColor = isOver ? 'var(--color-expense)' : percentage > 80 ? 'var(--color-warning)' : 'var(--color-income)';

    return {
      categoryId: catId,
      emoji: cat.emoji,
      name: cat.name,
      spent,
      effectiveBudget,
      rollover,
      percentage,
      isOver,
      fillColor
    };
  });
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

  // Effect for section visibility
  const cleanupVisibility = effect(() => {
    if (isEnvelopeVisible.value) {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  });

  // Effect for unassigned amount
  const cleanupUnassigned = effect(() => {
    if (unassignedEl) {
      const amount = unassignedAmount.value;
      unassignedEl.textContent = fmtCur(amount);
      unassignedEl.classList.remove('text-accent', 'text-expense');
      unassignedEl.classList.add(amount >= 0 ? 'text-accent' : 'text-expense');
    }
  });

  // Effect for envelope cards rendering
  const cleanupCards = effect(() => {
    const cards = envelopeCards.value;
    const showRollover = rolloverEnabled.value;

    if (cards.length === 0) {
      render(
        html`
          <div class="budget-empty-panel budget-empty-panel--compact">
            <div>
              <p class="text-sm font-semibold mb-2" style="color: var(--text-primary);">No budget allocated yet</p>
              <p class="text-xs" style="color: var(--text-tertiary);">Create category targets when you want a real spending plan instead of a loose monthly estimate.</p>
            </div>
          </div>
        `,
        grid
      );
      return;
    }

    render(
      html`
        ${cards.map(card => html`
          <div class="flex items-center gap-3 p-3 rounded-lg" style="background: var(--bg-input);">
            <span class="text-lg">${card.emoji}</span>
            <div class="flex-1">
              <div class="flex justify-between text-xs mb-1">
                <span class="font-bold" style="color: var(--text-primary);">
                  ${card.name}
                  ${showRollover && card.rollover !== 0
                    ? html`<span class="text-xs ml-1" style=${styleMap({
                        color: card.rollover > 0 ? 'var(--color-income)' : 'var(--color-expense)'
                      })}>(${card.rollover > 0 ? '+' : ''}${fmtCur(card.rollover)} rollover)</span>`
                    : nothing}
                </span>
                <span class="font-bold" style=${styleMap({
                  color: card.isOver ? 'var(--color-expense)' : 'var(--color-income)'
                })}>${fmtCur(card.spent)} / ${fmtCur(card.effectiveBudget)}</span>
              </div>
              <div class="goal-bar">
                <div class="goal-fill" style=${styleMap({
                  width: `${card.percentage}%`,
                  background: card.fillColor
                })}></div>
              </div>
            </div>
          </div>
        `)}
      `,
      grid
    );
  });

  // Return cleanup function
  return () => {
    cleanupVisibility();
    cleanupUnassigned();
    cleanupCards();
  };
}
