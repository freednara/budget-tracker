import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { showToast, showUndoToast } from '../js/modules/ui/core/ui.js';

describe('toast rendering security', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="toast-container"></div>';
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('renders toast messages as text instead of HTML', () => {
    showToast('<img src=x onerror=alert(1)>', 'error');

    const container = document.getElementById('toast-container') as HTMLDivElement;
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders undo toast messages as text instead of HTML', () => {
    showUndoToast('<svg onload=alert(1)>', null);

    const container = document.getElementById('toast-container') as HTMLDivElement;
    expect(container.textContent).toContain('<svg onload=alert(1)>');
    expect(container.querySelector('svg')).toBeNull();
  });
});
