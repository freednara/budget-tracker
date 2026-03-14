/**
 * Emoji Picker Module
 * Self-contained emoji picker for custom category creation
 *
 * @module emoji-picker
 * @requires dom-cache
 * @requires categories (EMOJI_PICKER_CATEGORIES)
 */
'use strict';

import DOM from '../../core/dom-cache.js';
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

// ==========================================
// RENDERING
// ==========================================

function renderTabs(): void {
  if (!tabsContainer) return;
  const categories = Object.keys(EMOJI_PICKER_CATEGORIES);
  tabsContainer.innerHTML = categories.map(cat => {
    const firstEmoji = EMOJI_PICKER_CATEGORIES[cat][0];
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    return `<button type="button" class="emoji-tab ${cat === currentCategory ? 'active' : ''}" data-category="${cat}">
      ${firstEmoji} ${label}
    </button>`;
  }).join('');
}

function renderGrid(): void {
  if (!grid) return;
  const emojis = EMOJI_PICKER_CATEGORIES[currentCategory] || [];
  grid.innerHTML = emojis.map(emoji =>
    `<button type="button" class="emoji-cell ${emoji === selectedEmoji ? 'selected' : ''}" data-emoji="${emoji}">${emoji}</button>`
  ).join('');
}

// ==========================================
// EVENT HANDLERS
// ==========================================

function handleTriggerClick(): void {
  if (!dropdown) return;
  const isOpen = !dropdown.classList.contains('hidden');
  dropdown.classList.toggle('hidden');
  if (!isOpen) {
    renderTabs();
    renderGrid();
  }
}

function handleTabClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const tab = target.closest('.emoji-tab') as HTMLElement | null;
  if (!tab) return;
  currentCategory = tab.dataset.category || 'money';
  renderTabs();
  renderGrid();
}

function handleEmojiSelect(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const cell = target.closest('.emoji-cell') as HTMLElement | null;
  if (!cell) return;
  selectedEmoji = cell.dataset.emoji || '🎨';
  if (preview) preview.textContent = selectedEmoji;
  if (hiddenInput) hiddenInput.value = selectedEmoji;
  if (dropdown) dropdown.classList.add('hidden');
  renderGrid();
}

function handleOutsideClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (!target.closest('#emoji-picker-container') && dropdown) {
    dropdown.classList.add('hidden');
  }
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Reset emoji picker to default state
 */
export function resetEmojiPicker(): void {
  selectedEmoji = '🎨';
  if (preview) preview.textContent = selectedEmoji;
  if (hiddenInput) hiddenInput.value = selectedEmoji;
  currentCategory = 'money';
}

/**
 * Set emoji picker value programmatically
 */
export function setEmojiPickerValue(emoji: string): void {
  selectedEmoji = emoji;
  if (preview) preview.textContent = emoji;
  if (hiddenInput) hiddenInput.value = emoji;
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize emoji picker
 */
export function init(): void {
  if (isInitialized) return;

  trigger = DOM.get('emoji-picker-trigger');
  dropdown = DOM.get('emoji-picker-dropdown');
  preview = DOM.get('selected-emoji-preview');
  hiddenInput = DOM.get('custom-cat-emoji') as HTMLInputElement | null;
  tabsContainer = DOM.get('emoji-category-tabs');
  grid = DOM.get('emoji-grid');

  if (!trigger || !dropdown) return;

  trigger.addEventListener('click', handleTriggerClick);
  if (tabsContainer) tabsContainer.addEventListener('click', handleTabClick);
  if (grid) grid.addEventListener('click', handleEmojiSelect);
  document.addEventListener('click', handleOutsideClick);

  // Expose global methods for backwards compatibility
  window.resetEmojiPicker = resetEmojiPicker;
  window.setEmojiPickerValue = setEmojiPickerValue;

  isInitialized = true;
}

export function destroy(): void {
  if (!isInitialized) return;

  if (trigger) trigger.removeEventListener('click', handleTriggerClick);
  if (tabsContainer) tabsContainer.removeEventListener('click', handleTabClick);
  if (grid) grid.removeEventListener('click', handleEmojiSelect);
  document.removeEventListener('click', handleOutsideClick);

  delete window.resetEmojiPicker;
  delete window.setEmojiPickerValue;

  isInitialized = false;
}
