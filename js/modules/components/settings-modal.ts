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
import { announcer } from '../core/accessibility.js';

// ==========================================
// SETTINGS MODAL
// ==========================================

/**
 * Render the settings modal
 */
export function renderSettingsModal(): TemplateResult {
  return html`
    <div id="settings-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <div class="rounded-2xl p-6 max-w-lg w-full card-shadow" style="background: var(--bg-card-section); border: 1px solid var(--border-section); max-height: 85vh; overflow-y: auto;">
        <h3 id="settings-modal-title" class="text-xl font-black mb-4 text-primary">⚙️ Settings</h3>

        <!-- Appearance -->
        <p class="text-xs font-black mb-3 mt-1" style="color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Appearance</p>
        <div class="mb-4 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">Theme</label>
          <div class="flex gap-2">
            <button class="theme-btn flex-1 py-2 rounded-lg text-sm font-bold" data-theme="dark" style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" aria-pressed="false">🌙 Dark</button>
            <button class="theme-btn flex-1 py-2 rounded-lg text-sm font-bold" data-theme="light" style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" aria-pressed="false">☀️ Light</button>
            <button class="theme-btn flex-1 py-2 rounded-lg text-sm font-bold" data-theme="system" style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" aria-pressed="false">🖥️ System</button>
          </div>
        </div>

        <!-- Currency -->
        <div class="mb-5 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">Default Currency</label>
          <select id="settings-currency" class="w-full px-3 py-2 rounded-lg text-sm cursor-pointer"
            style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">
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
        <p class="text-xs font-black mb-3" style="color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Dashboard Sections</p>
        <div class="mb-5 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">Show Sections</label>
          <div class="space-y-2">
            <label class="flex items-center gap-3 cursor-pointer"><input type="checkbox" id="show-envelope" checked class="w-4 h-4"> <span class="text-sm text-primary">Envelope Budget</span></label>
          </div>
          <label class="block text-xs font-bold mt-3 mb-2 text-secondary-uppercase">Insight Tone</label>
          <select id="insight-personality" aria-label="Insight tone" class="w-full px-3 py-2 rounded-lg text-sm" style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">
            <option value="serious">📊 Serious</option>
            <option value="friendly">😊 Friendly</option>
            <option value="roast">🔥 Roast Me</option>
          </select>
        </div>

        <!-- Budget Rollover -->
        <p class="text-xs font-black mb-3" style="color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Budget Rollover</p>
        <div class="mb-5 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="flex items-center gap-3 cursor-pointer mb-3">
            <input type="checkbox" id="rollover-enabled" class="w-4 h-4">
            <span class="text-sm" style="color: var(--text-primary);">Enable budget rollover</span>
          </label>

          <div id="rollover-options" class="space-y-3 hidden">
            <div>
              <label class="block text-xs font-bold mb-1" style="color: var(--text-secondary);">Rollover Mode</label>
              <select id="rollover-mode" class="w-full px-3 py-2 rounded-lg text-sm"
                style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">
                <option value="all">All categories</option>
                <option value="selected">Selected categories only</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-bold mb-1" style="color: var(--text-secondary);">Negative Balance Handling</label>
              <select id="negative-handling" class="w-full px-3 py-2 rounded-lg text-sm"
                style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">
                <option value="zero">Reset to zero (forgive overspending)</option>
                <option value="carry">Carry forward (reduce next month)</option>
                <option value="ignore">Ignore negatives</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-bold mb-1" style="color: var(--text-secondary);">Max Rollover Per Category</label>
              <input type="number" id="max-rollover" min="0" step="10" placeholder="Unlimited"
                class="w-full px-3 py-2 rounded-lg text-sm"
                style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">
              <p class="text-xs mt-1" style="color: var(--text-tertiary);">Leave empty for unlimited rollover</p>
            </div>
          </div>
        </div>

        <!-- Categories -->
        <p class="text-xs font-black mb-3" style="color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Categories</p>
        <div class="mb-5 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">Custom Categories</label>
          <div id="custom-categories-list" class="space-y-2 mb-2"></div>
          <button id="add-custom-cat-btn" class="w-full py-2 rounded-lg text-sm font-semibold" style="background: var(--bg-input); color: var(--text-secondary); border: 1px dashed var(--border-input);">+ Add Custom Category</button>
        </div>

        <!-- Alerts & Notifications -->
        <p class="text-xs font-black mb-3" style="color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Alerts & Notifications</p>
        <div class="mb-5 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">Budget Alerts</label>
          <label class="flex items-center gap-3 cursor-pointer mb-2"><input type="checkbox" id="alert-budget-exceed" checked class="w-4 h-4"> <span class="text-sm text-primary">In-app alert when budget exceeds 80%</span></label>
          <label class="flex items-center gap-3 cursor-pointer"><input type="checkbox" id="browser-budget-notifications" class="w-4 h-4"> <span class="text-sm text-primary">Browser notifications for new budget alerts</span></label>
          <p class="text-xs mt-2" style="color: var(--text-tertiary);">Browser notifications are local-only, require permission, and work only while the app or installed PWA is open.</p>
        </div>

        <!-- Security -->
        <p class="text-xs font-black mb-3" style="color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Security</p>
        <div class="mb-5 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">PIN Lock</label>
          <form class="flex items-center gap-3">
            <input type="password" id="settings-pin" maxlength="6" inputmode="numeric" pattern="[0-9]*" class="w-32 px-3 py-2 rounded-lg text-sm"
              style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" placeholder="Set PIN">
            <button type="button" id="save-pin-btn" class="px-3 py-2 rounded-lg text-sm font-bold btn-primary">Set PIN</button>
            <button type="button" id="clear-pin-btn" class="px-3 py-2 rounded-lg text-sm font-bold" style="background: var(--color-expense); color: white;">Remove</button>
          </form>
        </div>

        <!-- Keyboard Shortcuts -->
        <div class="mb-4">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">Keyboard Shortcuts</label>
          <div class="text-xs space-y-1 text-secondary">
            <p><kbd class="px-1 rounded" style="background: var(--bg-input);">D</kbd> Dashboard &nbsp; <kbd class="px-1 rounded" style="background: var(--bg-input);">N</kbd> New transaction &nbsp; <kbd class="px-1 rounded" style="background: var(--bg-input);">B</kbd> Budget</p>
            <p><kbd class="px-1 rounded" style="background: var(--bg-input);">E</kbd> Expense &nbsp; <kbd class="px-1 rounded" style="background: var(--bg-input);">I</kbd> Income &nbsp; <kbd class="px-1 rounded" style="background: var(--bg-input);">Esc</kbd> Close &nbsp; <kbd class="px-1 rounded" style="background: var(--bg-input);">?</kbd> Settings</p>
          </div>
        </div>

        <!-- Help -->
        <p class="text-xs font-black mb-3" style="color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Help</p>
        <div class="mb-5 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">Getting Started</label>
          <button id="restart-onboarding" class="w-full py-2 rounded-lg text-sm font-semibold" style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">🎯 Restart App Tour</button>
        </div>

        <!-- Data -->
        <p class="text-xs font-black mb-3" style="color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Data</p>
        <div class="mb-5 pl-3 border-l-2" style="border-color: var(--border-input);">
          <label class="block text-xs font-bold mb-2 text-secondary-uppercase">Data Management</label>
          <p class="text-xs mb-3" style="color: var(--text-tertiary);">
            Clears transactions, budgets, goals, debts, templates, recurring templates, categories, and settings on this device.
            Backup retention is chosen in the confirmation step.
          </p>
          <div class="flex gap-2">
            <button id="load-sample-data" class="flex-1 py-2 rounded-lg text-xs font-semibold" style="background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border-input);">📊 Load Sample Data</button>
            <button id="clear-all-data" class="flex-1 py-2 rounded-lg text-xs font-semibold" style="background: color-mix(in srgb, var(--color-expense) 15%, transparent); color: var(--color-expense);">🗑️ Clear All App Data</button>
          </div>
        </div>

        <div class="flex gap-3">
          <button id="cancel-settings" class="flex-1 py-3 rounded-lg font-bold btn-secondary">Cancel</button>
          <button id="close-settings" class="flex-1 py-3 rounded-lg font-bold btn-primary">Save Settings</button>
        </div>
      </div>
    </div>
    <div id="reset-app-data-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="reset-app-data-title" style="z-index: 80;">
      <div class="rounded-2xl p-6 max-w-md w-full card-shadow" style="background: var(--bg-card-section); border: 1px solid var(--border-section);">
        <h3 id="reset-app-data-title" class="text-xl font-black mb-2 text-primary">Clear App Data</h3>
        <p class="text-sm mb-3 text-secondary">
          This is irreversible. App data will be reset to a first-use state on this device.
        </p>
        <div class="p-3 rounded-xl mb-4" style="background: color-mix(in srgb, var(--color-expense) 8%, var(--bg-input)); border: 1px solid color-mix(in srgb, var(--color-expense) 25%, var(--border-input));">
          <p class="text-xs font-bold mb-1" style="color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.05em;">Choose Backup Behavior</p>
          <p class="text-sm text-secondary">
            You can keep stored backups for later restore, or wipe backups too for a full local reset.
          </p>
        </div>
        <div class="space-y-2">
          <button id="confirm-reset-keep-backups" class="w-full py-3 rounded-lg font-bold text-sm btn-primary">
            Clear App Data Only
          </button>
          <button id="confirm-reset-clear-backups" class="w-full py-3 rounded-lg font-bold text-sm" style="background: var(--color-expense); color: white;">
            Clear App Data + Backups
          </button>
          <button id="cancel-reset-app-data" class="w-full py-3 rounded-lg font-bold text-sm btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </div>
  `;
}
