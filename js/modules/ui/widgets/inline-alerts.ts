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

function renderAlertHost(container: HTMLElement | null, template: TemplateResult | null): void {
  if (!container) return;

  if (!template) {
    container.classList.add('hidden');
    render(html``, container);
    return;
  }

  container.classList.remove('hidden');
  render(template, container);
}

function renderShellAlertHost(container: HTMLElement | null, template: TemplateResult | null): void {
  if (!container) return;

  if (!template) {
    container.classList.add('hidden');
    render(html``, container);
    return;
  }

  container.classList.remove('hidden');
  render(html`
    <div class="mx-auto w-full max-w-6xl px-4 py-3">
      ${template}
    </div>
  `, container);
}

export function mountInlineAlerts(): () => void {
  const shellContainer = DOM.get('alert-banner');
  const dashboardContainer = DOM.get('dashboard-alerts');
  const budgetContainer = DOM.get('budget-alerts');

  return effect(() => {
    const alerts = signals.activeAlertEntries.value;

    if (alerts.length === 0) {
      renderShellAlertHost(shellContainer, null);
      renderAlertHost(dashboardContainer, null);
      renderAlertHost(budgetContainer, null);
      return;
    }

    const primaryAlert = alerts[0];
    const moreCount = alerts.length - 1;
    const displayText = primaryAlert.text + (moreCount > 0 ? ` (+${moreCount} more)` : '');
    const dismissLabel = buildDismissLabel(primaryAlert.text, moreCount);
    const template = alertTemplate(displayText, primaryAlert.key, dismissLabel);

    renderShellAlertHost(shellContainer, template);
    renderAlertHost(dashboardContainer, null);
    renderAlertHost(budgetContainer, null);
  });
}
