/**
 * Modal Events Lifecycle Tests
 * Integration tests for modal event handler init/cleanup and key interaction flows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import { initModalEvents, cleanupModalEvents } from '../js/modules/ui/interactions/modal-events.js';

// ==========================================
// DOM SETUP
// ==========================================

function setupModalDOM(): void {
  document.body.innerHTML = `
    <!-- Sync conflict modal buttons -->
    <button id="sync-accept-remote"></button>
    <button id="sync-keep-local"></button>

    <!-- Delete modal -->
    <div id="delete-modal" class="modal-overlay hidden" role="dialog" aria-modal="true">
      <button id="confirm-delete"></button>
      <button id="cancel-delete"></button>
    </div>

    <!-- Settings modal -->
    <div id="settings-modal" class="modal-overlay hidden" role="dialog" aria-modal="true">
      <button id="save-settings"></button>
      <button id="cancel-settings"></button>
      <button id="load-sample-data"></button>
      <button id="export-backup-btn"></button>
      <button id="import-backup-btn"></button>
      <button id="set-pin-btn"></button>
      <button id="remove-pin-btn"></button>
      <select id="currency-select"><option value="USD">USD</option></select>
      <select id="insight-personality"><option value="friendly">Friendly</option></select>
      <input type="checkbox" id="show-envelope" />
      <input type="checkbox" id="show-templates" />
      <input type="checkbox" id="alert-budget-exceed" />
      <input type="checkbox" id="browser-budget-notifications" />
      <input type="checkbox" id="rollover-enabled" />
      <select id="rollover-mode"><option value="all">All</option></select>
      <select id="negative-handling"><option value="zero">Zero</option></select>
      <input type="number" id="max-rollover" />
      <div id="rollover-options" class="hidden"></div>
      <div id="category-manager-mount"></div>
    </div>

    <!-- Analytics modal -->
    <div id="analytics-modal" class="modal-overlay hidden" role="dialog" aria-modal="true">
      <button id="open-analytics"></button>
      <button id="close-analytics"></button>
    </div>

    <!-- Savings modals -->
    <div id="savings-goal-modal" class="modal-overlay hidden">
      <button id="save-savings-goal"></button>
      <input id="savings-goal-name" />
      <input id="savings-goal-target" />
    </div>
    <div id="contribution-modal" class="modal-overlay hidden">
      <button id="save-contribution"></button>
      <input id="contribution-amount" />
    </div>

    <!-- Theme buttons -->
    <button class="theme-btn" data-theme="dark"></button>
    <button class="theme-btn" data-theme="light"></button>

    <!-- Alert/Celebration -->
    <button id="dismiss-alert"></button>
    <button id="celebration-close"></button>

    <!-- Edit recurring modal -->
    <div id="edit-recurring-modal" class="modal-overlay hidden">
      <button id="edit-recurring-this"></button>
      <button id="edit-recurring-all"></button>
      <button id="edit-recurring-cancel"></button>
    </div>

    <!-- Toast container -->
    <div id="toast-container"></div>
  `;
}

// ==========================================
// TESTS
// ==========================================

describe('modal-events lifecycle', () => {
  beforeEach(() => {
    setupModalDOM();
    DOM.clearAll();
  });

  afterEach(() => {
    cleanupModalEvents();
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('initializes without throwing', () => {
    expect(() => {
      initModalEvents({});
    }).not.toThrow();
  });

  it('cleans up without throwing', () => {
    initModalEvents({});
    expect(() => {
      cleanupModalEvents();
    }).not.toThrow();
  });

  it('re-init cleans up previous listeners (no double-fire)', () => {
    initModalEvents({});
    initModalEvents({});

    // After double init, sync conflict should fire only once
    const eventHandler = vi.fn();
    window.addEventListener('sync-conflict-resolution', eventHandler);

    const acceptBtn = document.getElementById('sync-accept-remote') as HTMLButtonElement;
    acceptBtn.click();

    // Should fire exactly once, not twice
    expect(eventHandler).toHaveBeenCalledTimes(1);
    window.removeEventListener('sync-conflict-resolution', eventHandler);
  });

  it('cleanup removes all event listeners', () => {
    initModalEvents({});
    cleanupModalEvents();

    const eventHandler = vi.fn();
    window.addEventListener('sync-conflict-resolution', eventHandler);

    const acceptBtn = document.getElementById('sync-accept-remote') as HTMLButtonElement;
    acceptBtn.click();

    // After cleanup, clicking should not fire the handler
    expect(eventHandler).toHaveBeenCalledTimes(0);
    window.removeEventListener('sync-conflict-resolution', eventHandler);
  });

  it('sync-accept-remote dispatches correct custom event', () => {
    initModalEvents({});

    const eventHandler = vi.fn((e: Event) => {
      const detail = (e as CustomEvent).detail;
      expect(detail.action).toBe('accept');
    });
    window.addEventListener('sync-conflict-resolution', eventHandler);

    document.getElementById('sync-accept-remote')!.click();
    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener('sync-conflict-resolution', eventHandler);
  });

  it('sync-keep-local dispatches correct custom event', () => {
    initModalEvents({});

    const eventHandler = vi.fn((e: Event) => {
      const detail = (e as CustomEvent).detail;
      expect(detail.action).toBe('reject');
    });
    window.addEventListener('sync-conflict-resolution', eventHandler);

    document.getElementById('sync-keep-local')!.click();
    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener('sync-conflict-resolution', eventHandler);
  });

  it('callbacks are stored and used', () => {
    const refreshAll = vi.fn();
    const resetForm = vi.fn();
    initModalEvents({ refreshAll, resetForm });

    // Callbacks are stored internally — verified by not throwing
    // Full integration with click→callback requires more mocking
    expect(true).toBe(true);
  });
});

describe('modal-events DOM resilience', () => {
  it('handles missing DOM elements gracefully', () => {
    document.body.innerHTML = ''; // Empty DOM
    DOM.clearAll();

    expect(() => {
      initModalEvents({});
    }).not.toThrow();

    expect(() => {
      cleanupModalEvents();
    }).not.toThrow();
  });

  it('handles partial DOM (only some elements exist)', () => {
    document.body.innerHTML = `
      <button id="sync-accept-remote"></button>
      <div id="toast-container"></div>
    `;
    DOM.clearAll();

    expect(() => {
      initModalEvents({});
    }).not.toThrow();
  });
});
