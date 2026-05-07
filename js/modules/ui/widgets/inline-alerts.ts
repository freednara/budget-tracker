/**
 * Inline Alert Hosts
 *
 * Renders the primary budget alert into the shell banner.
 */
'use strict';

import { effect } from '@preact/signals-core';
import * as signals from '../../core/signals.js';
import { alerts as alertActions } from '../../core/state-actions.js';
import DOM from '../../core/dom-cache.js';
import { html, render, type TemplateResult } from '../../core/lit-helpers.js';

function dismissAlert(alertId: string): void {
  alertActions.dismissAlert(alertId, signals.currentMonth.value);
}

function buildDismissLabel(primaryAlert: string, moreCount: number): string {
  return moreCount > 0
    ? `Dismiss alert: ${primaryAlert}. ${moreCount} more alert${moreCount === 1 ? '' : 's'} remain.`
    : `Dismiss alert: ${primaryAlert}`;
}

function alertTemplate(displayText: string, alertId: string, dismissLabel: string): TemplateResult {
  return html`
    <div class="inline-alert-card" data-alert-id=${alertId}>
      <div class="inline-alert-card__copy">
        <span class="inline-alert-card__icon" aria-hidden="true">⚠️</span>
        <div class="inline-alert-card__body">
          <p class="inline-alert-card__label">Budget Alert</p>
          <p class="inline-alert-card__text">${displayText}</p>
        </div>
      </div>
      <button
        @click=${() => dismissAlert(alertId)}
        class="touch-btn inline-alert-card__dismiss"
        data-alert-id=${alertId}
        aria-label=${dismissLabel}
      >
        ✕
      </button>
    </div>
  `;
}

// Phase 5g-1 (Inline-Behavior-Review rev 12, L30c): deleted the
// `renderAlertHost(container, template)` helper. The in-page
// `#dashboard-alerts` and `#budget-alerts` host divs were only ever
// rendered with a null template (always empty/hidden), so this helper's
// template branch never executed. The shell banner — which IS live — uses
// `renderShellAlertHost` instead. The now-orphaned HTML divs in
// index.html:318/417 are tracked for deletion in action-plan item #147.
function renderShellAlertHost(container: HTMLElement | null, template: TemplateResult | null): void {
  if (!container) return;

  if (!template) {
    container.classList.add('hidden');
    render(html``, container);
    return;
  }

  container.classList.remove('hidden');
  render(html`
    <div class="mx-auto w-full max-w-6xl px-4 py-2">
      ${template}
    </div>
  `, container);
}

export function mountInlineAlerts(): () => void {
  // Phase 5g-1 (Inline-Behavior-Review rev 12, L30c): removed the
  // `dashboardContainer`/`budgetContainer` DOM lookups and their paired
  // `renderAlertHost(..., null)` render branches (4 call sites total). They
  // were no-ops: the hosts only ever received a null template, so all they
  // did was re-add `.hidden` to divs that were already hidden in index.html.
  // Alert UI lives entirely in the shell banner now.
  const shellContainer = DOM.get('alert-banner');

  return effect(() => {
    const alerts = signals.activeAlertEntries.value;

    if (alerts.length === 0) {
      renderShellAlertHost(shellContainer, null);
      return;
    }

    // Phase 6 Slice 1i (rev 12 L6): `alerts[0]` is `T | undefined`
    // under `noUncheckedIndexedAccess`; the `alerts.length === 0`
    // guard above guarantees presence, but a local narrow keeps the
    // downstream field reads type-safe without a non-null assertion.
    const primaryAlert = alerts[0];
    if (!primaryAlert) {
      renderShellAlertHost(shellContainer, null);
      return;
    }
    const moreCount = alerts.length - 1;
    const displayText = primaryAlert.text + (moreCount > 0 ? ` (+${moreCount} more)` : '');
    const dismissLabel = buildDismissLabel(primaryAlert.text, moreCount);
    const template = alertTemplate(displayText, primaryAlert.key, dismissLabel);

    renderShellAlertHost(shellContainer, template);
  });
}
