/**
 * Empty State Module
 * Generates empty state UI with illustrations and CTAs
 *
 * @module empty-state
 * @requires utils (esc)
 * @requires dom-cache
 */
'use strict';

import DOM from '../../core/dom-cache.js';
import { html, render, nothing, type TemplateResult } from '../../core/lit-helpers.js';
import type { EmptyStateAction } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type SwitchMainTabFn = (tabName: string) => void;
type OpenModalFn = (modalId: string) => void;
type LoadSampleDataFn = () => void;
type OpenTransactionsForDateFn = (date: string) => void;

type IllustrationType = 'no-transactions' | 'no-results' | 'no-goals' | 'no-recurring';

// ==========================================
// CALLBACKS
// ==========================================

let switchMainTabFn: SwitchMainTabFn = () => {};
let openModalFn: OpenModalFn = () => {};
let loadSampleDataFn: LoadSampleDataFn = () => {};
let openTransactionsForDateFn: OpenTransactionsForDateFn | null = null;

export function setSwitchMainTabFn(fn: SwitchMainTabFn): void {
  switchMainTabFn = fn;
}

export function setOpenModalFn(fn: OpenModalFn): void {
  openModalFn = fn;
}

export function setLoadSampleDataFn(fn: LoadSampleDataFn): void {
  loadSampleDataFn = fn;
}

export function setOpenTransactionsForDateFn(fn: OpenTransactionsForDateFn): void {
  openTransactionsForDateFn = fn;
}

// ==========================================
// CONFIG
// ==========================================

const FOCUS_DELAY = 100;

const ILLUSTRATION_MAP: Record<string, IllustrationType> = {
  '📝': 'no-transactions',
  '🔍': 'no-results',
  '💚': 'no-goals',
  '↻': 'no-recurring'
};

// ==========================================
// ILLUSTRATIONS
// ==========================================

const ILLUSTRATIONS: Record<IllustrationType, TemplateResult> = {
  'no-transactions': html`<div class="empty-state-illustration illustration-no-transactions">
    <div class="coin"></div>
    <div class="coin"></div>
    <div class="coin"></div>
    <div class="wallet"></div>
  </div>`,

  'no-results': html`<div class="empty-state-illustration illustration-no-results">
    <div class="magnifier"></div>
    <div class="handle"></div>
  </div>`,

  'no-goals': html`<div class="empty-state-illustration illustration-no-goals">
    <div class="target-ring"></div>
    <div class="target-ring"></div>
    <div class="target-ring"></div>
    <div class="arrow"></div>
  </div>`,

  'no-recurring': html`<div class="empty-state-illustration illustration-no-recurring">
    <div class="calendar">
      <div class="calendar-header"></div>
      <div class="calendar-dots">
        <div class="calendar-dot"></div>
        <div class="calendar-dot"></div>
        <div class="calendar-dot"></div>
        <div class="calendar-dot"></div>
        <div class="calendar-dot"></div>
        <div class="calendar-dot"></div>
      </div>
    </div>
    <div class="repeat-icon">↻</div>
  </div>`
};

// ==========================================
// RENDERING
// ==========================================

/**
 * Generate empty state template
 */
export function emptyState(
  emoji: string,
  title: string,
  subtitle: string,
  action: EmptyStateAction | null = null
): TemplateResult {
  const illustrationType = ILLUSTRATION_MAP[emoji];
  const illustrationTemplate = illustrationType && ILLUSTRATIONS[illustrationType]
    ? ILLUSTRATIONS[illustrationType]
    : null;

  return html`
    <div class="text-center py-8">
      ${illustrationTemplate ?? html`<div class="text-4xl mb-2">${emoji}</div>`}
      <p class="font-bold" style="color: var(--text-primary);">${title}</p>
      <p class="text-xs mt-1" style="color: var(--text-tertiary);">${subtitle}</p>
      ${action ? html`
        <button class="empty-state-cta mt-4 px-4 py-2 rounded-lg text-sm font-bold transition-all"
                data-action=${action.id}
                data-action-date=${action.date || nothing}
                style="background: var(--color-accent); color: white;">
          ${action.label}
        </button>
      ` : nothing}
    </div>
  `;
}

/**
 * Render empty state into a container
 */
export function renderEmptyState(
  container: HTMLElement,
  emoji: string,
  title: string,
  subtitle: string,
  action: EmptyStateAction | null = null
): void {
  render(emptyState(emoji, title, subtitle, action), container);
}

// ==========================================
// CTA HANDLERS
// ==========================================

function handleCTAClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const btn = target.closest('.empty-state-cta') as HTMLElement | null;
  if (!btn) return;

  const action = btn.dataset.action;

  switch (action) {
    case 'add-transaction':
      switchMainTabFn('transactions');
      setTimeout(() => (DOM.get('amount') as HTMLElement | null)?.focus(), FOCUS_DELAY);
      break;

    case 'add-transaction-for-date': {
      const date = btn.dataset.actionDate;
      if (!date || !openTransactionsForDateFn) break;
      openTransactionsForDateFn(date);
      break;
    }

    case 'add-goal':
      openModalFn('savings-goal-modal');
      setTimeout(() => (DOM.get('savings-goal-name') as HTMLElement | null)?.focus(), FOCUS_DELAY);
      break;

    case 'clear-filters':
      (DOM.get('clear-filters-btn') as HTMLElement | null)?.click();
      break;

    case 'load-sample':
      loadSampleDataFn();
      break;
  }
}

// ==========================================
// INITIALIZATION
// ==========================================

let isInitialized = false;

/**
 * Initialize empty state CTA handlers
 */
export function init(): void {
  if (isInitialized) return;
  document.addEventListener('click', handleCTAClick);
  isInitialized = true;
}

export function destroy(): void {
  document.removeEventListener('click', handleCTAClick);
  isInitialized = false;
}
