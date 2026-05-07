/**
 * Emoji Picker Module
 * Self-contained emoji picker for custom category creation
 *
 * @module emoji-picker
 * @requires dom-cache
 * @requires categories (EMOJI_PICKER_CATEGORIES)
 */
'use strict';

import { EMOJI_PICKER_CATEGORIES } from '../../core/categories.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Extend Window interface for global methods
declare global {
  interface Window {
    resetEmojiPicker?: () => void;
    setEmojiPickerValue?: (emoji: string) => void;
  }
}

// ==========================================
// MODULE STATE
// ==========================================

let currentCategory = 'money';
let selectedEmoji = '🎨';
let isInitialized = false;

// ==========================================
// DOM ELEMENTS
// ==========================================

let trigger: HTMLElement | null = null;
let dropdown: HTMLElement | null = null;
let preview: HTMLElement | null = null;
let hiddenInput: HTMLInputElement | null = null;
let tabsContainer: HTMLElement | null = null;
let grid: HTMLElement | null = null;

function refreshRefs(): void {
  trigger = document.getElementById('emoji-picker-trigger');
  dropdown = document.getElementById('emoji-picker-dropdown');
  preview = document.getElementById('selected-emoji-preview');
  hiddenInput = document.getElementById('custom-cat-emoji') as HTMLInputElement | null;
  tabsContainer = document.getElementById('emoji-category-tabs');
  grid = document.getElementById('emoji-grid');
}

// ==========================================
// RENDERING
// ==========================================

function renderTabs(): void {
  refreshRefs();
  if (!tabsContainer) return;
  const categories = Object.keys(EMOJI_PICKER_CATEGORIES);
  tabsContainer.replaceChildren(...categories.map((cat) => {
    // Phase 6 Slice 1i (rev 12 L6): two levels of index access are both
    // `T | undefined` under `noUncheckedIndexedAccess`. `cat` came from
    // `Object.keys` so the outer lookup always hits; the inner `[0]`
    // relies on every category list having at least one emoji — fall
    // back to a neutral glyph if that invariant is ever violated.
    const firstEmoji = EMOJI_PICKER_CATEGORIES[cat]?.[0] ?? '·';
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    const isActive = cat === currentCategory;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `emoji-tab${isActive ? ' active' : ''}`;
    button.dataset.category = cat;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    button.setAttribute('tabindex', isActive ? '0' : '-1');
    button.setAttribute('aria-label', `${label} emojis`);
    button.textContent = `${firstEmoji} ${label}`;
    return button;
  }));
}

function renderGrid(): void {
  refreshRefs();
  if (!grid) return;
  const emojis = EMOJI_PICKER_CATEGORIES[currentCategory] || [];
  grid.replaceChildren(...emojis.map((emoji) => {
    const isSelected = emoji === selectedEmoji;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `emoji-cell${isSelected ? ' selected' : ''}`;
    button.dataset.emoji = emoji;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    button.setAttribute('tabindex', isSelected ? '0' : '-1');
    button.setAttribute('aria-label', `Choose ${emoji}`);
    button.textContent = emoji;
    return button;
  }));
}

function getTabButtons(): HTMLButtonElement[] {
  return tabsContainer ? Array.from(tabsContainer.querySelectorAll<HTMLButtonElement>('.emoji-tab')) : [];
}

function getEmojiButtons(): HTMLButtonElement[] {
  return grid ? Array.from(grid.querySelectorAll<HTMLButtonElement>('.emoji-cell')) : [];
}

/**
 * Phase 5g-2 (Inline-Behavior-Review rev 12, L33): derive the grid column
 * count at keypress time from the rendered grid's computed style instead of
 * the previously-hardcoded `EMOJI_GRID_COLUMNS = 8` constant. The markup in
 * `form-modals.ts` currently uses a static Tailwind `grid-cols-8` class, so
 * today the measurement returns 8 — but if the template ever adds
 * responsive variants (e.g. `sm:grid-cols-4 md:grid-cols-6 grid-cols-8`)
 * the hardcoded constant would silently break ArrowUp/ArrowDown navigation
 * on those viewports, moving focus by 8 cells while the user sees rows of
 * 4 or 6. Measuring `gridTemplateColumns` keeps keyboard navigation in
 * lockstep with the actual visible layout. Falls back to 8 if the grid
 * is detached or the computed style is empty (pre-open, etc.).
 */
function getGridColumnCount(): number {
  if (!grid) return 8;
  const template = getComputedStyle(grid).gridTemplateColumns;
  const columns = template.split(' ').filter((token) => token.trim().length > 0).length;
  return columns > 0 ? columns : 8;
}

function focusCurrentTab(): void {
  getTabButtons().find((button) => button.dataset.category === currentCategory)?.focus();
}

function focusSelectedEmoji(): void {
  const buttons = getEmojiButtons();
  const selected = buttons.find((button) => button.dataset.emoji === selectedEmoji);
  (selected || buttons[0])?.focus();
}

function setCurrentCategory(nextCategory: string): void {
  currentCategory = nextCategory;
  renderTabs();
  renderGrid();
}

function moveEmojiFocus(currentButton: HTMLButtonElement, offset: number): void {
  const buttons = getEmojiButtons();
  const currentIndex = buttons.indexOf(currentButton);
  if (currentIndex === -1) return;

  const nextIndex = Math.min(Math.max(currentIndex + offset, 0), buttons.length - 1);
  buttons[nextIndex]?.focus();
}

// ==========================================
// EVENT HANDLERS
// ==========================================

function handleTriggerClick(): void {
  refreshRefs();
  if (!dropdown) return;
  const isOpen = !dropdown.classList.contains('hidden');
  if (isOpen) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

function handleTabClick(e: MouseEvent): void {
  refreshRefs();
  const target = e.target as HTMLElement;
  const tab = target.closest<HTMLElement>('.emoji-tab');
  if (!tab) return;
  setCurrentCategory(tab.dataset.category || 'money');
  focusCurrentTab();
}

function handleEmojiSelect(e: MouseEvent): void {
  refreshRefs();
  const target = e.target as HTMLElement;
  const cell = target.closest<HTMLElement>('.emoji-cell');
  if (!cell) return;
  selectedEmoji = cell.dataset.emoji || '🎨';
  if (preview) preview.textContent = selectedEmoji;
  if (hiddenInput) hiddenInput.value = selectedEmoji;
  closeDropdown();
  renderGrid();
  trigger?.focus();
}

function handleOutsideClick(e: MouseEvent): void {
  refreshRefs();
  const target = e.target as HTMLElement;
  if (!target.closest('#emoji-picker-container') && dropdown) {
    closeDropdown();
  }
}

function handleKeydown(e: KeyboardEvent): void {
  refreshRefs();
  const target = e.target as HTMLElement | null;
  if (!dropdown || dropdown.classList.contains('hidden')) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeDropdown();
    trigger?.focus();
    return;
  }

  if (target?.classList.contains('emoji-tab')) {
    const tabs = getTabButtons();
    const currentIndex = tabs.findIndex((button) => button === target);
    if (currentIndex === -1) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const nextIndex =
        e.key === 'Home' ? 0 :
        e.key === 'End' ? tabs.length - 1 :
        (currentIndex + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setCurrentCategory(tabs[nextIndex]?.dataset.category || 'money');
      focusCurrentTab();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusSelectedEmoji();
      return;
    }
  }

  if (target?.classList.contains('emoji-cell')) {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveEmojiFocus(target as HTMLButtonElement, 1);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveEmojiFocus(target as HTMLButtonElement, -1);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveEmojiFocus(target as HTMLButtonElement, getGridColumnCount());
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveEmojiFocus(target as HTMLButtonElement, -getGridColumnCount());
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      getEmojiButtons()[0]?.focus();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      const buttons = getEmojiButtons();
      buttons[buttons.length - 1]?.focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      target.click();
    }
  }
}

function closeDropdown(): void {
  refreshRefs();
  if (!dropdown) return;
  dropdown.classList.add('hidden');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function openDropdown(): void {
  refreshRefs();
  if (!dropdown) return;
  dropdown.classList.remove('hidden');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  renderTabs();
  renderGrid();
  focusSelectedEmoji();
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Reset emoji picker to default state
 */
export function resetEmojiPicker(): void {
  selectedEmoji = '🎨';
  currentCategory = 'money';
  closeDropdown();
  refreshRefs();
  if (preview) preview.textContent = selectedEmoji;
  if (hiddenInput) hiddenInput.value = selectedEmoji;
  renderTabs();
  renderGrid();
}

/**
 * Set emoji picker value programmatically
 */
export function setEmojiPickerValue(emoji: string): void {
  selectedEmoji = emoji;
  currentCategory = Object.entries(EMOJI_PICKER_CATEGORIES).find(([, emojis]) => emojis.includes(emoji))?.[0] || 'money';
  refreshRefs();
  if (preview) preview.textContent = emoji;
  if (hiddenInput) hiddenInput.value = emoji;
  renderTabs();
  renderGrid();
}

function handleDocumentClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  if (target.closest('#emoji-picker-trigger')) {
    handleTriggerClick();
    return;
  }

  if (target.closest('.emoji-tab')) {
    handleTabClick(e);
    return;
  }

  if (target.closest('.emoji-cell')) {
    handleEmojiSelect(e);
    return;
  }

  handleOutsideClick(e);
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize emoji picker
 */
export function init(): void {
  // Round 7 fix: Singleton guard prevents duplicate document click/keydown listeners
  if (isInitialized) return;
  refreshRefs();

  // Set ARIA attributes
  trigger?.setAttribute('aria-haspopup', 'dialog');
  trigger?.setAttribute('aria-expanded', 'false');
  trigger?.setAttribute('aria-controls', 'emoji-picker-dropdown');
  dropdown?.setAttribute('role', 'dialog');
  dropdown?.setAttribute('aria-label', 'Emoji picker');
  tabsContainer?.setAttribute('role', 'tablist');
  tabsContainer?.setAttribute('aria-label', 'Emoji categories');
  grid?.setAttribute('role', 'listbox');
  grid?.setAttribute('aria-label', 'Available emojis');

  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleKeydown);

  // Expose global methods for backwards compatibility
  window.resetEmojiPicker = resetEmojiPicker;
  window.setEmojiPickerValue = setEmojiPickerValue;

  isInitialized = true;
}

export function destroy(): void {
  if (!isInitialized) return;
  document.removeEventListener('click', handleDocumentClick);
  document.removeEventListener('keydown', handleKeydown);

  delete window.resetEmojiPicker;
  delete window.setEmojiPickerValue;

  isInitialized = false;
}
