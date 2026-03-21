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
  tabsContainer.innerHTML = categories.map(cat => {
    const firstEmoji = EMOJI_PICKER_CATEGORIES[cat][0];
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    return `<button type="button" class="emoji-tab ${cat === currentCategory ? 'active' : ''}" data-category="${cat}">
      ${firstEmoji} ${label}
    </button>`;
  }).join('');
}

function renderGrid(): void {
  refreshRefs();
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
  const tab = target.closest('.emoji-tab') as HTMLElement | null;
  if (!tab) return;
  currentCategory = tab.dataset.category || 'money';
  renderTabs();
  renderGrid();
}

function handleEmojiSelect(e: MouseEvent): void {
  refreshRefs();
  const target = e.target as HTMLElement;
  const cell = target.closest('.emoji-cell') as HTMLElement | null;
  if (!cell) return;
  selectedEmoji = cell.dataset.emoji || '🎨';
  if (preview) preview.textContent = selectedEmoji;
  if (hiddenInput) hiddenInput.value = selectedEmoji;
  closeDropdown();
  renderGrid();
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
  if (e.key === 'Escape' && dropdown && !dropdown.classList.contains('hidden')) {
    closeDropdown();
    trigger?.focus();
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
  if (isInitialized) return;
  refreshRefs();

  // Set ARIA attributes
  trigger?.setAttribute('aria-haspopup', 'listbox');
  trigger?.setAttribute('aria-expanded', 'false');
  dropdown?.setAttribute('role', 'listbox');
  dropdown?.setAttribute('aria-label', 'Emoji picker');

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
