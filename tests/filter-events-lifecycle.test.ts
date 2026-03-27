import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { cleanupFilterEvents, initFilterEvents } from '../js/modules/ui/interactions/filter-events.js';

describe('filter-events lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="toggle-advanced-filters" aria-expanded="false"></button>';
    DOM.clearAll();
    signals.filtersExpanded.value = false;
  });

  afterEach(() => {
    cleanupFilterEvents();
    DOM.clearAll();
    document.body.innerHTML = '';
    signals.filtersExpanded.value = false;
  });

  it('does not double-toggle advanced filters after re-init', () => {
    initFilterEvents();
    initFilterEvents();

    const toggle = document.getElementById('toggle-advanced-filters') as HTMLButtonElement;
    toggle.click();

    expect(signals.filtersExpanded.value).toBe(true);
  });
});
