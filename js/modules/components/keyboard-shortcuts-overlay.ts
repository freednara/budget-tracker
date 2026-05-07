/**
 * Keyboard Shortcuts Overlay Component
 *
 * A lightweight, accessible overlay that surfaces all available
 * keyboard shortcuts. Toggled by pressing `?`.
 *
 * @module components/keyboard-shortcuts-overlay
 */
'use strict';

import { html, render, type TemplateResult } from '../core/lit-helpers.js';
import DOM from '../core/dom-cache.js';

// ==========================================
// TYPES
// ==========================================

interface ShortcutEntry {
  key: string;
  label: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutEntry[];
}

// ==========================================
// DATA
// ==========================================

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { key: 'D', label: 'Dashboard' },
      { key: 'N', label: 'New transaction (+ focus amount)' },
      { key: 'B', label: 'Budget planner' },
    ]
  },
  {
    title: 'Transaction Entry',
    shortcuts: [
      { key: 'E', label: 'Switch to Expense tab' },
      { key: 'I', label: 'Switch to Income tab' },
      { key: '1–8', label: 'Select category by position' },
      { key: 'Esc', label: 'Cancel editing' },
    ]
  },
  {
    title: 'Tools',
    shortcuts: [
      { key: '⌘/Ctrl F', label: 'Focus search (Transactions)' },
      { key: '⌘/Ctrl E', label: 'Export data' },
      { key: ',', label: 'Open settings' },
      { key: '?', label: 'This help overlay' },
    ]
  }
];

// ==========================================
// STATE
// ==========================================

let overlayEl: HTMLElement | null = null;

// ==========================================
// RENDER
// ==========================================

function renderShortcutGroup(group: ShortcutGroup): TemplateResult {
  return html`
    <div class="kb-shortcuts__group">
      <h4 class="kb-shortcuts__group-title">${group.title}</h4>
      ${group.shortcuts.map(s => html`
        <div class="kb-shortcuts__row">
          <kbd class="kb-shortcuts__key">${s.key}</kbd>
          <span class="kb-shortcuts__label">${s.label}</span>
        </div>
      `)}
    </div>
  `;
}

function renderOverlayTemplate(): TemplateResult {
  return html`
    <div class="kb-shortcuts__backdrop" @click=${hideShortcutsOverlay}></div>
    <div class="kb-shortcuts__panel" role="document">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-lg font-black text-primary">Keyboard Shortcuts</h3>
        <button class="w-8 h-8 flex items-center justify-center rounded-lg text-lg form-input-secondary"
          @click=${hideShortcutsOverlay}
          aria-label="Close shortcuts">✕</button>
      </div>
      <div class="kb-shortcuts__grid">
        ${SHORTCUT_GROUPS.map(renderShortcutGroup)}
      </div>
      <p class="kb-shortcuts__footer">Press <kbd class="kb-shortcuts__key">?</kbd> or <kbd class="kb-shortcuts__key">Esc</kbd> to close</p>
    </div>
  `;
}

// ==========================================
// LIFECYCLE
// ==========================================

/**
 * Ensure the overlay container exists in the DOM
 */
function ensureOverlay(): HTMLElement {
  if (overlayEl) return overlayEl;

  overlayEl = document.createElement('div');
  overlayEl.id = 'keyboard-shortcuts-overlay';
  overlayEl.className = 'kb-shortcuts-overlay hidden';
  overlayEl.setAttribute('role', 'dialog');
  overlayEl.setAttribute('aria-modal', 'true');
  overlayEl.setAttribute('aria-label', 'Keyboard shortcuts');
  document.body.appendChild(overlayEl);
  return overlayEl;
}

/**
 * Show the keyboard shortcuts overlay
 */
export function showShortcutsOverlay(): void {
  const el = ensureOverlay();
  render(renderOverlayTemplate(), el);
  el.classList.remove('hidden');
  // Focus the panel for screen readers
  const panel = el.querySelector<HTMLElement>('.kb-shortcuts__panel');
  panel?.focus();
}

/**
 * Hide the keyboard shortcuts overlay
 */
export function hideShortcutsOverlay(): void {
  if (!overlayEl) return;
  overlayEl.classList.add('hidden');
}

/**
 * Toggle the overlay
 */
export function toggleShortcutsOverlay(): void {
  if (overlayEl && !overlayEl.classList.contains('hidden')) {
    hideShortcutsOverlay();
  } else {
    showShortcutsOverlay();
  }
}

/**
 * Check if the overlay is currently visible
 */
export function isShortcutsOverlayOpen(): boolean {
  return !!overlayEl && !overlayEl.classList.contains('hidden');
}
