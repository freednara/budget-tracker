/**
 * Settings Modal Component
 *
 * Lit template for the settings modal with all configuration options.
 * Maintains existing element IDs for backward compatibility.
 * Enhanced with announcer integration for accessibility.
 *
 * @module components/settings-modal
 */
'use strict';

import { html, type TemplateResult } from '../core/lit-helpers.js';
import { localeService } from '../core/locale-service.js';

// ==========================================
// SETTINGS MODAL
// ==========================================

/**
 * Render the settings modal
 */
export function renderSettingsModal(): TemplateResult {
  const runtimeInfo = typeof window !== 'undefined'
    ? ((window as Window & {
        __APP_RUNTIME_INFO__?: {
          version?: string;
          buildTime?: string;
          runtimeMode?: string;
          serviceWorkerControlled?: boolean;
        };
      }).__APP_RUNTIME_INFO__ ?? null)
    : null;

  // Use the app's configured locale so the build-timestamp display is
  // consistent with the rest of the app (previously hardcoded 'en-US').
  const buildTimeLabel = runtimeInfo?.buildTime
    ? new Date(runtimeInfo.buildTime).toLocaleString(localeService.getLocale(), {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Unknown build';

  const runtimeModeLabel = runtimeInfo?.runtimeMode === 'standalone' ? 'Installed PWA' : 'Browser tab';
  const serviceWorkerLabel = runtimeInfo?.serviceWorkerControlled ? 'Active' : 'Not controlling';

  return html`
    <div id="settings-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <div class="rounded-2xl p-6 max-w-lg w-full card-shadow modal-panel modal-panel--scroll">
        <div class="flex justify-between items-center mb-4">
          <h3 id="settings-modal-title" class="text-xl font-black text-primary">⚙️ Settings</h3>
          <button id="close-settings-x" class="w-8 h-8 flex items-center justify-center rounded-lg text-lg form-input-secondary" aria-label="Close settings">✕</button>
        </div>

        <!-- Appearance -->
        <p class="text-xs font-black mb-3 mt-1 section-header">Appearance</p>
        <div class="mb-4 pl-3 border-l-2 settings-section-border">
          <fieldset class="border-0 p-0 m-0">
            <legend class="block text-xs font-bold mb-2 text-secondary-uppercase">Theme</legend>
            <div class="flex gap-2" role="group" aria-label="Theme selection">
              <button class="theme-btn flex-1 py-2 rounded-lg text-sm font-bold form-input" data-theme="dark" data-modal-initial-focus="true" aria-pressed="false">🌙 Dark</button>
              <button class="theme-btn flex-1 py-2 rounded-lg text-sm font-bold form-input" data-theme="light" aria-pressed="false">☀️ Light</button>
              <button class="theme-btn flex-1 py-2 rounded-lg text-sm font-bold form-input" data-theme="system" aria-pressed="false">🖥️ System</button>
            </div>
          </fieldset>
        </div>

        <!-- Currency -->
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <label for="settings-currency" class="block text-xs font-bold mb-2 text-secondary-uppercase">Default Currency</label>
          <select id="settings-currency" class="w-full px-3 py-2 rounded-lg text-sm cursor-pointer form-input">
            <option value="USD">$ USD - US Dollar</option>
            <option value="EUR">€ EUR - Euro</option>
            <option value="GBP">£ GBP - British Pound</option>
            <option value="JPY">¥ JPY - Japanese Yen</option>
            <option value="CAD">$ CAD - Canadian Dollar</option>
            <option value="AUD">$ AUD - Australian Dollar</option>
            <option value="CHF">Fr CHF - Swiss Franc</option>
            <option value="CNY">¥ CNY - Chinese Yuan</option>
            <option value="INR">₹ INR - Indian Rupee</option>
            <option value="MXN">$ MXN - Mexican Peso</option>
            <option value="BRL">R$ BRL - Brazilian Real</option>
            <option value="KRW">₩ KRW - Korean Won</option>
          </select>
        </div>

        <!-- Dashboard Sections -->
        <p class="text-xs font-black mb-3 section-header">Dashboard Sections</p>
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <fieldset class="border-0 p-0 m-0">
            <legend class="block text-xs font-bold mb-2 text-secondary-uppercase">Show Sections</legend>
            <div class="space-y-2">
              <label class="flex items-center gap-3 cursor-pointer"><input type="checkbox" id="show-envelope" checked class="w-4 h-4"> <span class="text-sm text-primary">Envelope Budget</span></label>
              <label class="flex items-center gap-3 cursor-pointer"><input type="checkbox" id="show-templates" checked class="w-4 h-4"> <span class="text-sm text-primary">Transaction Templates</span></label>
            </div>
          </fieldset>
          <label for="insight-personality" class="block text-xs font-bold mt-3 mb-2 text-secondary-uppercase">Insight Tone</label>
          <select id="insight-personality" class="w-full px-3 py-2 rounded-lg text-sm form-input">
            <option value="serious">📊 Serious</option>
            <option value="friendly">😊 Friendly</option>
            <option value="roast">🔥 Roast Me</option>
          </select>
        </div>

        <!-- Budget Rollover -->
        <p class="text-xs font-black mb-3 section-header">Budget Rollover</p>
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <label class="flex items-center gap-3 cursor-pointer mb-3">
            <input type="checkbox" id="rollover-enabled" class="w-4 h-4">
            <span class="text-sm text-primary">Enable budget rollover</span>
          </label>

          <div id="rollover-options" class="space-y-3 hidden">
            <div>
              <label for="rollover-mode" class="block text-xs font-bold mb-1 text-secondary">Rollover Mode</label>
              <select id="rollover-mode" class="w-full px-3 py-2 rounded-lg text-sm form-input">
                <option value="all">All categories</option>
                <option value="selected">Selected categories only</option>
              </select>
            </div>

            <div>
              <label for="negative-handling" class="block text-xs font-bold mb-1 text-secondary">Negative Balance Handling</label>
              <select id="negative-handling" class="w-full px-3 py-2 rounded-lg text-sm form-input">
                <option value="zero">Reset to zero (forgive overspending)</option>
                <option value="carry">Carry forward (reduce next month)</option>
                <option value="ignore">Ignore negatives</option>
              </select>
            </div>

            <div>
              <label for="max-rollover" class="block text-xs font-bold mb-1 text-secondary">Max Rollover Per Category</label>
              <input type="number" id="max-rollover" min="0" step="10" placeholder="Unlimited"
                aria-describedby="max-rollover-hint"
                class="w-full px-3 py-2 rounded-lg text-sm form-input">
              <p id="max-rollover-hint" class="text-xs mt-1 text-tertiary">Leave empty for unlimited rollover</p>
            </div>
          </div>
        </div>

        <!-- Categories -->
        <p class="text-xs font-black mb-3 section-header">Categories</p>
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <div id="category-manager-mount"></div>
        </div>

        <!-- Alerts & Notifications -->
        <p class="text-xs font-black mb-3 section-header">Alerts & Notifications</p>
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <fieldset class="border-0 p-0 m-0">
            <legend class="block text-xs font-bold mb-2 text-secondary-uppercase">Budget Alerts</legend>
            <label class="flex items-center gap-3 cursor-pointer mb-2"><input type="checkbox" id="alert-budget-exceed" checked class="w-4 h-4"> <span class="text-sm text-primary">In-app alert when budget exceeds 80%</span></label>
            <label class="flex items-center gap-3 cursor-pointer"><input type="checkbox" id="browser-budget-notifications" class="w-4 h-4"> <span class="text-sm text-primary">Browser notifications for new budget alerts</span></label>
          </fieldset>
          <p class="text-xs mt-2 text-tertiary">Browser notifications are local-only, require permission, and work only while the app or installed PWA is open.</p>
        </div>

        <!-- Security -->
        <p class="text-xs font-black mb-3 section-header">Security</p>
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <label for="settings-pin" class="block text-xs font-bold mb-2 text-secondary-uppercase">PIN Lock</label>
          <form class="flex items-center gap-3">
            <input type="password" id="settings-pin" maxlength="6" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password" class="w-32 px-3 py-2 rounded-lg text-sm form-input" placeholder="Set PIN">
            <button type="button" id="save-pin-btn" class="px-3 py-2 rounded-lg text-sm font-bold btn btn-primary">Set PIN</button>
            <button type="button" id="clear-pin-btn" class="px-3 py-2 rounded-lg text-sm font-bold btn btn-danger" hidden>Turn Off PIN</button>
          </form>
        </div>

        <!-- Keyboard Shortcuts -->
        <!--
          NOTE: Not a form control, so no <label>. Render as a heading
          with the same visual treatment the labels use. (Fixes a11y
          review P1: standalone <label> with no 'for' target.)
        -->
        <div class="mb-4">
          <h4 class="block text-xs font-bold mb-2 text-secondary-uppercase">Keyboard Shortcuts</h4>
          <div class="text-xs space-y-1 text-secondary">
            <p><kbd class="kbd">D</kbd> Dashboard &nbsp; <kbd class="kbd">N</kbd> New transaction &nbsp; <kbd class="kbd">B</kbd> Budget</p>
            <p><kbd class="kbd">E</kbd> Expense &nbsp; <kbd class="kbd">I</kbd> Income &nbsp; <kbd class="kbd">Esc</kbd> Close &nbsp; <kbd class="kbd">?</kbd> Settings</p>
          </div>
        </div>

        <!-- Help -->
        <!--
          "Getting Started" is a heading for the restart-onboarding button,
          not a form-control label. The button has its own visible/accessible
          name, so the correct element is a heading, not a <label>.
        -->
        <p class="text-xs font-black mb-3 section-header">Help</p>
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <h4 class="block text-xs font-bold mb-2 text-secondary-uppercase">Getting Started</h4>
          <button id="restart-onboarding" class="w-full py-2 rounded-lg text-sm font-semibold form-input">🎯 Restart App Tour</button>
        </div>

        <!-- Runtime -->
        <p class="text-xs font-black mb-3 section-header">App Runtime</p>
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <div class="text-xs space-y-2 text-secondary">
            <p><span class="font-bold text-primary">Version:</span> ${runtimeInfo?.version || 'Unknown'}</p>
            <p><span class="font-bold text-primary">Built:</span> ${buildTimeLabel}</p>
            <p><span class="font-bold text-primary">Mode:</span> ${runtimeModeLabel}</p>
            <p><span class="font-bold text-primary">Service Worker:</span> ${serviceWorkerLabel}</p>
          </div>
        </div>

        <!-- Data -->
        <!--
          "Data Management" is a section heading, not a form-control label.
          The controls (sample-data / clear-all-data buttons) are named
          individually.
        -->
        <p class="text-xs font-black mb-3 section-header">Data</p>
        <div class="mb-5 pl-3 border-l-2 settings-section-border">
          <h4 class="block text-xs font-bold mb-2 text-secondary-uppercase">Data Management</h4>
          <p class="text-xs mb-3 text-tertiary">
            Clears transactions, budgets, goals, debts, templates, recurring templates, categories, and settings on this device.
            Backup retention is chosen in the confirmation step.
          </p>
        </div>

        <div class="space-y-2">
          <div class="flex gap-2">
            <button id="load-sample-data" class="btn btn-secondary btn-sm flex-1">📊 Load Sample Data</button>
            <button id="clear-all-data" class="btn btn-secondary btn-sm flex-1 text-expense border-danger">🗑️ Clear All App Data</button>
          </div>
        </div>

        <!-- Sticky footer for save/cancel -->
        <div class="settings-modal__footer">
          <div class="flex gap-2">
            <button id="cancel-settings" class="btn btn-secondary btn-sm flex-1">Cancel</button>
            <button id="close-settings" class="btn btn-primary btn-sm flex-1">Save Settings</button>
          </div>
        </div>
      </div>
    </div>
    <div id="reset-app-data-modal" class="modal-overlay modal-overlay--priority hidden" role="dialog" aria-modal="true" aria-labelledby="reset-app-data-title">
      <div class="rounded-2xl p-6 max-w-md w-full card-shadow modal-panel">
        <h3 id="reset-app-data-title" class="text-xl font-black mb-2 text-primary">Clear App Data</h3>
        <p class="text-sm mb-3 text-secondary">
          This is irreversible. App data will be reset to a first-use state on this device.
        </p>
        <div class="p-3 rounded-xl mb-4 settings-danger-box">
          <p class="text-xs font-bold mb-1 settings-danger-box__title">Choose Backup Behavior</p>
          <p class="text-sm text-secondary">
            You can keep stored backups for later restore, or wipe backups too for a full local reset.
          </p>
        </div>
        <div class="space-y-2">
          <button id="confirm-reset-keep-backups" class="btn btn-danger-outline w-full text-sm">
            Clear App Data Only
          </button>
          <button id="confirm-reset-clear-backups" class="btn btn-danger w-full text-sm">
            Clear App Data + Backups
          </button>
          <!--
            Design-Review-Apr21 P3 (batch 6 follow-up): the shared
            modal opener's focus-resolver picks the first focusable
            control unless one is tagged with
            data-modal-initial-focus. With no tag, keyboard users
            open this dialog focused on "Clear App Data Only" — one
            Space/Enter away from an irreversible reset. Route
            initial focus to Cancel so a reflexive activation is
            the safe, non-destructive outcome. Both destructive
            buttons still require a deliberate move.
          -->
          <button id="cancel-reset-app-data" data-modal-initial-focus="true" class="btn btn-secondary w-full text-sm">
            Cancel
          </button>
        </div>
      </div>
    </div>
  `;
}
