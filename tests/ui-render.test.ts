import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import DOM from '../js/modules/core/dom-cache.js';
import { renderCategories, renderQuickShortcuts } from '../js/modules/ui/core/ui-render.js';

describe('ui-render selection updates', () => {
  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <div id="category-chips"></div>
      <div id="quick-shortcuts"></div>
      <div id="category-error" class="hidden"></div>
    `;
    signals.currentType.value = 'expense';
    signals.selectedCategory.value = 'food';
  });

  afterEach(() => {
    DOM.clearAll();
    document.body.innerHTML = '';
    signals.selectedCategory.value = '';
  });

  it('updates the selected category chip state when selection changes', () => {
    renderCategories();
    const container = document.getElementById('category-chips') as HTMLElement;
    const foodChip = container.querySelector('[data-category="food"]') as HTMLButtonElement;
    const transportChip = container.querySelector('[data-category="transport"]') as HTMLButtonElement;

    expect(foodChip.getAttribute('aria-pressed')).toBe('true');

    signals.selectedCategory.value = 'transport';
    renderCategories();

    const foodChipAfter = container.querySelector('[data-category="food"]') as HTMLButtonElement;
    const transportChipAfter = container.querySelector('[data-category="transport"]') as HTMLButtonElement;

    expect(foodChipAfter.getAttribute('aria-pressed')).toBe('false');
    expect(transportChipAfter.getAttribute('aria-pressed')).toBe('true');
  });

  it('rerenders category chips when the transaction type changes', () => {
    renderCategories();
    const container = document.getElementById('category-chips') as HTMLElement;

    expect(container.querySelector('[data-category="food"]')).not.toBeNull();
    expect(container.querySelector('[data-category="salary"]')).toBeNull();

    signals.currentType.value = 'income';
    signals.selectedCategory.value = '';
    renderCategories();

    expect(container.querySelector('[data-category="salary"]')).not.toBeNull();
    expect(container.querySelector('[data-category="food"]')).toBeNull();
  });

  it('keeps quick shortcuts available after the selected category changes', () => {
    renderQuickShortcuts();
    const container = document.getElementById('quick-shortcuts') as HTMLElement;
    const foodShortcut = container.querySelector('[data-category="food"]') as HTMLButtonElement;
    const quickShortcutCount = container.querySelectorAll('.quick-shortcut').length;

    expect(foodShortcut).not.toBeNull();

    signals.selectedCategory.value = 'transport';
    renderQuickShortcuts();

    const foodShortcutAfter = container.querySelector('[data-category="food"]') as HTMLButtonElement;
    expect(foodShortcutAfter).not.toBeNull();
    expect(foodShortcutAfter.dataset.category).toBe('food');
    expect(container.querySelectorAll('.quick-shortcut')).toHaveLength(quickShortcutCount);

    foodShortcutAfter.click();
    expect(signals.selectedCategory.value).toBe('food');
  });

  it('rerenders quick shortcuts when the transaction type changes', () => {
    renderQuickShortcuts();
    const container = document.getElementById('quick-shortcuts') as HTMLElement;

    expect(container.querySelector('[data-category="food"]')).not.toBeNull();
    expect(container.querySelector('[data-category="salary"]')).toBeNull();

    signals.currentType.value = 'income';
    renderQuickShortcuts();

    expect(container.querySelector('[data-category="salary"]')).not.toBeNull();
    expect(container.querySelector('[data-category="food"]')).toBeNull();
  });
});
