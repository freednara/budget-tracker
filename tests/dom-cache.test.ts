import { beforeEach, describe, expect, it } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';

describe('DOMCache', () => {
  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('drops detached cached elements and re-queries the current DOM node', () => {
    document.body.innerHTML = '<div id="toast-container">first</div>';
    const first = DOM.get('toast-container');

    document.body.innerHTML = '<div id="toast-container">second</div>';
    const second = DOM.get('toast-container');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second?.textContent).toBe('second');
  });
});
