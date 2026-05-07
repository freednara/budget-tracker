import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { destroy, init } from '../js/modules/ui/interactions/emoji-picker.js';

describe('emoji-picker accessibility', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="emoji-picker-container">
        <button type="button" id="emoji-picker-trigger">
          <span id="selected-emoji-preview">🎨</span>
        </button>
        <div id="emoji-picker-dropdown" class="hidden">
          <div id="emoji-category-tabs"></div>
          <div id="emoji-grid"></div>
        </div>
      </div>
      <input type="hidden" id="custom-cat-emoji" value="🎨">
    `;
    init();
  });

  afterEach(() => {
    destroy();
    document.body.innerHTML = '';
  });

  it('adds accessible roles to the trigger and popup content', () => {
    const trigger = document.getElementById('emoji-picker-trigger');
    const dropdown = document.getElementById('emoji-picker-dropdown');
    const tabs = document.getElementById('emoji-category-tabs');
    const grid = document.getElementById('emoji-grid');

    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger?.getAttribute('aria-controls')).toBe('emoji-picker-dropdown');
    expect(dropdown?.getAttribute('role')).toBe('dialog');
    expect(tabs?.getAttribute('role')).toBe('tablist');
    expect(grid?.getAttribute('role')).toBe('listbox');
  });

  it('supports keyboard navigation across categories and emoji selection', () => {
    const trigger = document.getElementById('emoji-picker-trigger') as HTMLButtonElement;
    trigger.click();

    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.emoji-tab'));
    expect(tabs.length).toBeGreaterThan(1);

    const firstTab = tabs[0];
    if (!firstTab) throw new Error('expected at least one emoji tab');
    firstTab.focus();
    firstTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    const selectedTab = document.querySelector<HTMLButtonElement>('.emoji-tab[aria-selected="true"]');
    expect(selectedTab).not.toBeNull();
    expect(selectedTab).not.toBe(firstTab);

    const emojiButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.emoji-cell'));
    expect(emojiButtons.length).toBeGreaterThan(1);

    const secondEmoji = emojiButtons[1];
    if (!secondEmoji) throw new Error('expected at least two emoji cells');
    secondEmoji.focus();
    secondEmoji.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const hiddenInput = document.getElementById('custom-cat-emoji') as HTMLInputElement;
    expect(hiddenInput.value).toBe(secondEmoji.dataset.emoji);
    expect(document.getElementById('emoji-picker-dropdown')?.classList.contains('hidden')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
