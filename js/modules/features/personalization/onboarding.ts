/**
 * Onboarding Module
 *
 * Reactive first-time user tour using signals and Lit.
 * Coordinates spotlight positioning and multi-tab state.
 * Step 0 integrates the preset picker so the entire first-launch
 * experience is one seamless flow.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { onboarding as onboardingActions } from '../../core/state-actions.js';
import { switchMainTab, switchTab } from '../../ui/core/ui-navigation.js';
import { on, emit, Events, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat } from '../../core/lit-helpers.js';
import { effect } from '@preact/signals-core';
import { CATEGORY_PRESETS, type CategoryPreset } from '../../core/category-presets.js';
import { applyPreset } from '../../core/category-store.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type TooltipPosition = 'below' | 'above' | 'left' | 'right' | 'center';
type StepKind = 'tour' | 'preset-picker';

interface OnboardingStep {
  kind: StepKind;
  emoji: string;
  title: string;
  body: string;
  btn: string;
  target: string | null;
  tab: 'dashboard' | 'transactions' | 'budget' | 'calendar';
  subTab?: 'expense' | 'income';
  position: TooltipPosition;
}

// ==========================================
// CONFIGURATION
// ==========================================

/** Total steps shown in the progress dots (excludes the preset picker). */
const TOUR_STEP_COUNT = 5;

export const ONBOARDING_STEPS: OnboardingStep[] = [
  // Step 0 — Integrated preset picker (full-page, centered)
  {
    kind: 'preset-picker',
    emoji: '',
    title: 'Welcome to Harbor Ledger',
    body: 'Pick a category pack that fits how you manage money. You can customize them later in Settings.',
    btn: '',          // preset picker has its own buttons
    target: null,
    tab: 'dashboard',
    position: 'center'
  },
  // Step 1
  {
    kind: 'tour',
    emoji: '🎯',
    title: 'Plan Your Month',
    body: 'Start here each month. Set your budget so the app knows how much each category and goal should handle.',
    btn: 'Next',
    target: '#open-plan-budget',
    tab: 'budget',
    position: 'below'
  },
  // Step 2
  {
    kind: 'tour',
    emoji: '💸',
    title: 'Log & Categorize',
    body: 'Log what you spend and earn. Categories help you see where your money goes each month.'
      + ('ontouchstart' in globalThis ? ' Tip: swipe left on any transaction to edit or delete it.' : ''),
    btn: 'Next',
    target: '#amount',
    tab: 'transactions',
    subTab: 'expense',
    position: 'below'
  },
  // Step 3
  {
    kind: 'tour',
    emoji: '📅',
    title: 'Calendar View',
    body: 'See when money moves. Review daily activity, recurring bills, and tap any date to jump straight to its transactions.',
    btn: 'Next',
    target: '#calendar-planning',
    tab: 'calendar',
    position: 'below'
  },
  // Step 4
  {
    kind: 'tour',
    emoji: '📊',
    title: 'Your Dashboard',
    body: 'This is home base. Check your daily allowance, spending pace, and what to do next — all at a glance.',
    btn: 'Next',
    target: '#hero-dashboard-card',
    tab: 'dashboard',
    position: 'below'
  },
  // Step 5
  {
    kind: 'tour',
    emoji: '🚀',
    title: 'You\'re All Set!',
    body: 'Budget the month, log transactions, check Calendar for timing, and use Dashboard to stay on track. You\'ve got this!',
    btn: 'Start Tracking!',
    target: null,
    tab: 'dashboard',
    position: 'center'
  }
];

// ==========================================
// ACTIONS
// ==========================================

/**
 * Start or resume the onboarding tour.
 * Resumes from whatever step was last saved — step 0 (preset picker)
 * for new users, or a later step for returning users who paused mid-tour.
 */
export function startOnboarding(): void {
  // CR-Apr24-I finding 127: reset the preset picker selection so a
  // previously-selected preset from an earlier tour run doesn't leak
  // into the new session.
  _presetSelectedId = 'personal';
  onboardingActions.start();
}

// Retry timeout for target element detection
let _retryTimeout: number | null = null;
const TARGET_RETRY_DELAY_MS = 200;
const TARGET_RETRY_LIMIT = 12;

/** Whether the current navigation was triggered by prevStep (suppresses auto-skip). */
let _isBackNavigation = false;

/**
 * Wait for a target element to have non-zero dimensions.
 * Resolves with the element once visible, or null after timeout.
 */
function waitForTarget(selector: string, timeoutMs = 2500): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const pollInterval = 80;
    let elapsed = 0;

    const check = (): void => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          resolve(el);
          return;
        }
      }
      elapsed += pollInterval;
      if (elapsed >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, pollInterval);
    };

    // Start after one rAF to let the DOM settle from tab switch
    requestAnimationFrame(check);
  });
}

// Track ESC keydown listener for cleanup
let _escKeydownListener: ((e: KeyboardEvent) => void) | null = null;
let _listenerGroupId: string | null = null;

/**
 * Move to next step in tour
 */
export function nextStep(): void {
  // Cancel pending retry to prevent stale step skips
  if (_retryTimeout) { clearTimeout(_retryTimeout); _retryTimeout = null; }
  const state = signals.onboarding.value;
  const nextIdx = state.step + 1;

  if (nextIdx >= ONBOARDING_STEPS.length) {
    completeOnboarding();
  } else {
    onboardingActions.setState({ ...state, step: nextIdx });
  }
}

/**
 * Move to previous step in tour (minimum step 1 — can't go back to preset picker)
 */
export function prevStep(): void {
  if (_retryTimeout) { clearTimeout(_retryTimeout); _retryTimeout = null; }
  const state = signals.onboarding.value;
  const prevIdx = state.step - 1;

  // Don't go back before step 1 (preset picker is step 0, already completed)
  if (prevIdx >= 1) {
    _isBackNavigation = true;
    onboardingActions.setState({ ...state, step: prevIdx });
  }
}

/**
 * Skip and complete the tour
 */
export function completeOnboarding(): void {
  // Clear any pending retry timeout to prevent stale step-skip firing after completion
  if (_retryTimeout) { clearTimeout(_retryTimeout); _retryTimeout = null; }
  // CR-Apr24-I finding 127: reset preset selection so the next tour
  // run starts clean at 'personal'.
  _presetSelectedId = 'personal';
  onboardingActions.complete();

  // CR-May01: navigate back to Dashboard so the welcome hero is visible.
  // The tour navigates the user to Budget (step 1), Transactions (step 2),
  // Calendar (step 3), etc. — if they skip mid-tour they'd land on a bare
  // empty tab instead of the Dashboard welcome hero with its "Add First
  // Transaction" / "Load Sample Data" CTAs.
  switchMainTab('dashboard');

  emit(Events.SHOW_TOAST, { message: 'You\'re ready to track!', type: 'success' });
}

// ==========================================
// PRESET PICKER STATE (for step 0)
// ==========================================

let _presetSelectedId = 'personal';

function selectOnboardingPreset(id: string): void {
  _presetSelectedId = id;
  // Re-render by poking the onboarding signal (same step, forces effect)
  const state = signals.onboarding.value;
  onboardingActions.setState({ ...state });
}

function confirmOnboardingPreset(): void {
  applyPreset(_presetSelectedId);
  nextStep();
}

function renderPresetPreview(preset: CategoryPreset) {
  return html`
    <div class="preset-picker__preview">
      <p class="preset-picker__preview-section">Expense categories (${preset.expense.length})</p>
      <div class="preset-picker__preview-list">
        ${preset.expense.map(c => html`
          <span class="preset-picker__preview-chip">
            <span class="preset-picker__preview-chip-emoji">${c.emoji}</span>
            <span>${c.name}</span>
          </span>
        `)}
      </div>
      <p class="preset-picker__preview-section">Income categories (${preset.income.length})</p>
      <div class="preset-picker__preview-list">
        ${preset.income.map(c => html`
          <span class="preset-picker__preview-chip preset-picker__preview-chip--income">
            <span class="preset-picker__preview-chip-emoji">${c.emoji}</span>
            <span>${c.name}</span>
          </span>
        `)}
      </div>
    </div>
  `;
}

function renderPresetPickerStep() {
  // Phase 6 Slice 1i (rev 12 L6): `CATEGORY_PRESETS[0]` is now
  // `CategoryPreset | undefined` under `noUncheckedIndexedAccess`.
  // The preset list is non-empty at build time, but render a safe
  // empty-state placeholder rather than crash if that ever changes.
  const selected = CATEGORY_PRESETS.find(p => p.id === _presetSelectedId) ?? CATEGORY_PRESETS[0];
  if (!selected) {
    return html`<div class="preset-picker__fallback">Category presets unavailable.</div>`;
  }

  return html`
    <div id="onboarding-backdrop" class="onboarding-backdrop" @click=${confirmOnboardingPreset}></div>
    <div class="onboard-preset-page">
      <div
        id="onboarding-preset-picker"
        class="preset-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-preset-picker-title"
        tabindex="-1"
      >
        <div class="preset-picker__brand">
          <div class="preset-picker__logo">💎</div>
          <h2 id="onboarding-preset-picker-title" class="preset-picker__title">Welcome to Harbor Ledger</h2>
        </div>
        <p class="preset-picker__subtitle">Pick a category pack to get started. You can fully customize them later in Settings.</p>

        <div class="preset-picker__grid">
          ${CATEGORY_PRESETS.map(p => html`
            <button
              class="preset-picker__card ${_presetSelectedId === p.id ? 'preset-picker__card--selected' : ''}"
              @click=${() => selectOnboardingPreset(p.id)}
            >
              <div class="preset-picker__card-emoji">${p.emoji}</div>
              <div class="preset-picker__card-name">${p.name}</div>
              <div class="preset-picker__card-desc">${p.description}</div>
            </button>
          `)}
        </div>

        ${renderPresetPreview(selected)}

        <button class="preset-picker__confirm" @click=${confirmOnboardingPreset}>
          Use ${selected.name} Pack
        </button>
        <button class="preset-picker__skip" @click=${() => { _presetSelectedId = 'personal'; confirmOnboardingPreset(); }}>
          Use Default Pack (Personal)
        </button>
      </div>
    </div>
  `;
}

// ==========================================
// RENDERER
// ==========================================

// Guard against double-mounting (blocking path + lazy loader both call this)
let _mountedCleanup: (() => void) | null = null;

/**
 * Mount the reactive onboarding component.
 * Safe to call multiple times — subsequent calls return the existing cleanup.
 */
export function mountOnboarding(): () => void {
  if (_mountedCleanup) return _mountedCleanup;

  const container = DOM.get('onboarding-overlay');
  if (!container) return () => {};

  const cleanup = effect(() => {
    const { active, step: stepIdx } = signals.onboarding.value;

    // CR-May02-C: the app-shell header sits at z-index:40, above the
    // onboarding overlay at z-index:30 (--z-overlay). Rather than
    // re-layer the z-index stack (which would risk breaking modal/toast
    // ordering), use `inert` to block interaction with the entire #app
    // subtree while onboarding is active. This prevents tab clicks,
    // keyboard navigation, and assistive-technology access to content
    // behind the overlay.
    const appEl = DOM.get('app');

    if (!active) {
      if (appEl) {
        appEl.removeAttribute('inert');
        appEl.removeAttribute('aria-hidden');
      }
      // CR-May01: fade out the overlay before removing it so skip/complete
      // doesn't feel like an abrupt cut. The CSS transition on
      // `.onboarding-overlay.dismissing` handles the opacity animation;
      // we wait for it to finish before tearing down the DOM.
      if (container.classList.contains('active')) {
        container.classList.add('dismissing');
        container.classList.remove('no-transition');
        const teardown = (): void => {
          container.classList.remove('active', 'dismissing', 'onboarding-overlay--centered', 'onboarding-overlay--targeted');
          render(html``, container);
          document.querySelectorAll('.onboarding-highlight').forEach(el => el.classList.remove('onboarding-highlight'));
        };
        container.addEventListener('transitionend', teardown, { once: true });
        // Safety fallback if transitionend doesn't fire (e.g., reduced motion)
        setTimeout(teardown, 350);
      } else {
        container.classList.remove('active', 'no-transition', 'onboarding-overlay--centered', 'onboarding-overlay--targeted');
        render(html``, container);
        document.querySelectorAll('.onboarding-highlight').forEach(el => el.classList.remove('onboarding-highlight'));
      }
      return;
    }
    if (appEl) {
      appEl.setAttribute('inert', '');
      appEl.setAttribute('aria-hidden', 'true');
    }
    container.classList.add('modal-overlay', 'active', 'no-transition');

    // Phase 6 Slice 1i (rev 12 L6): `ONBOARDING_STEPS[stepIdx]` is now
    // `OnboardingStep | undefined` under `noUncheckedIndexedAccess`.
    // If an out-of-range index slips through (e.g., persisted state
    // with an old step count), complete the tour cleanly instead of
    // crashing.
    const step = ONBOARDING_STEPS[stepIdx];
    if (!step) {
      completeOnboarding();
      return;
    }

    // ---- Preset picker step gets its own full-page render ----
    if (step.kind === 'preset-picker') {
      container.classList.add('onboarding-overlay--centered');
      container.classList.remove('onboarding-overlay--targeted');
      render(renderPresetPickerStep(), container);
      // A11y: move focus into the dialog after paint so keyboard users and
      // screen readers land inside the first onboarding step instead of
      // behind it on the underlying page. Double-rAF mirrors the normal
      // tour-step focus pattern below (wait for lit-html commit + layout).
      // CR-Apr24-I finding 133: guard the deferred focus — bail if the tour
      // step has changed or been dismissed before the rAF fires.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!signals.onboarding.value.active || signals.onboarding.value.step !== stepIdx) return;
          const panel = document.getElementById('onboarding-preset-picker');
          if (panel) panel.focus({ preventScroll: true });
        });
      });
      return;
    }

    // ---- Normal tour steps ----
    // Switch tabs automatically (use navigation functions that sync both signals AND DOM)
    // CR-May03: use `.peek()` to read tab signals without creating effect
    // dependencies. The previous `.value` reads caused this effect to
    // re-trigger when `switchMainTab` / `switchTab` mutated the same
    // signals, producing a double-render that reset the tooltip's CSS
    // opacity transition before it could complete (stuck at ~0 opacity).
    if (signals.activeMainTab.peek() !== step.tab) {
      switchMainTab(step.tab);
    }
    if (step.subTab && signals.currentTab.peek() !== step.subTab) {
      switchTab(step.subTab);
    }

    container.classList.toggle('onboarding-overlay--centered', !step.target);
    container.classList.toggle('onboarding-overlay--targeted', Boolean(step.target));

    // Tour step index for progress dots (offset by 1 to exclude preset picker step)
    const tourIdx = stepIdx - 1;

    const showBack = tourIdx > 0;

    render(html`
        <div id="onboarding-backdrop" class="onboarding-backdrop" @click=${nextStep}></div>
        <div id="onboarding-spotlight" class="onboarding-spotlight"></div>

        <div id="onboarding-tooltip" class="onboarding-tooltip" tabindex="-1">
          <div class="onboarding-tooltip-content">
            <div class="onboard-emoji" id="onboarding-emoji">${step.emoji}</div>
            <h3 class="onboard-title" id="onboarding-title">${step.title}</h3>
            <p class="onboard-body" id="onboarding-body">${step.body}</p>

            <div class="onboard-footer">
              <div class="onboard-dots" id="onboard-progress">
                ${repeat(
                  Array.from({ length: TOUR_STEP_COUNT }),
                  (_, i) => i,
                  (_, i) => html`
                    <div class="onboard-dot ${i === tourIdx ? 'onboard-dot--active' : i < tourIdx ? 'onboard-dot--done' : ''}" role="presentation"></div>
                  `
                )}
              </div>

              <div class="onboard-actions">
                ${showBack ? html`<button @click=${prevStep} class="onboard-skip-btn" aria-label="Go back">Back</button>` : html``}
                <button @click=${completeOnboarding} id="onboard-skip" class="onboard-skip-btn">Skip</button>
                <button @click=${nextStep} id="onboard-next" class="px-6 py-2 rounded-xl font-bold text-sm btn-primary">
                  ${step.btn}
                </button>
              </div>
            </div>
          </div>
        </div>
    `, container);

    // Position spotlight & tooltip after the live onboarding DOM has been rendered,
    // then focus the tooltip for keyboard/screen reader accessibility.
    // When step has a target, show the tooltip centered immediately so the user
    // always sees step content, then reposition to the target once it renders.
    const capturedStep = stepIdx;
    const wasBackNav = _isBackNavigation;
    _isBackNavigation = false;

    // Remove no-transition after first paint so subsequent animations work
    requestAnimationFrame(() => {
      container.classList.remove('no-transition');
    });

    if (step.target) {
      // Show tooltip immediately in centered position while waiting for target
      requestAnimationFrame(() => {
        if (!signals.onboarding.value.active || signals.onboarding.value.step !== capturedStep) return;
        const tooltip = document.getElementById('onboarding-tooltip');
        if (tooltip) {
          tooltip.classList.add('visible');
          tooltip.style.top = '50%';
          tooltip.style.left = '50%';
          tooltip.style.transform = 'translate(-50%, -50%)';
          tooltip.focus({ preventScroll: true });
        }
      });

      void (async () => {
        const el = await waitForTarget(step.target!, wasBackNav ? 3000 : 2500);
        // Bail if the step changed while we were waiting
        if (!signals.onboarding.value.active || signals.onboarding.value.step !== capturedStep) return;

        if (!el && wasBackNav) {
          // Back navigation: don't auto-skip — keep tooltip centered
          emit(Events.SHOW_TOAST, { message: 'Moving on to the overview for this step', type: 'info' });
          const spotlight = document.getElementById('onboarding-spotlight');
          if (spotlight) { spotlight.style.opacity = '0'; spotlight.classList.remove('active'); }
          container.classList.add('onboarding-overlay--centered');
          container.classList.remove('onboarding-overlay--targeted');
          return;
        }

        // Forward navigation or target found — reposition to target
        requestAnimationFrame(() => {
          if (!signals.onboarding.value.active || signals.onboarding.value.step !== capturedStep) return;
          updateSpotlightPosition(step);
          const tooltip = document.getElementById('onboarding-tooltip');
          if (tooltip) tooltip.focus({ preventScroll: true });
        });
      })();
    } else {
      // No target (centered step like "You're All Set!") — position immediately
      // CR-Apr24-I finding 135: guard the deferred focus — bail if the tour
      // step has changed or been dismissed before the double-rAF fires.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!signals.onboarding.value.active || signals.onboarding.value.step !== capturedStep) return;
          updateSpotlightPosition(step);
          const tooltip = document.getElementById('onboarding-tooltip');
          if (tooltip) tooltip.focus({ preventScroll: true });
        });
      });
    }
  });

  _mountedCleanup = () => {
    cleanup();
    _mountedCleanup = null;
  };
  return _mountedCleanup;
}

/**
 * Position the spotlight and tooltip based on target element
 */
function updateSpotlightPosition(step: OnboardingStep, attempt = 0): void {
  const overlay = document.getElementById('onboarding-overlay');
  const spotlight = document.getElementById('onboarding-spotlight');
  const tooltip = document.getElementById('onboarding-tooltip');
  if (!overlay || !spotlight || !tooltip) return;

  document.querySelectorAll('.onboarding-highlight').forEach(el => el.classList.remove('onboarding-highlight'));
  overlay.classList.toggle('onboarding-overlay--centered', !step.target);
  overlay.classList.toggle('onboarding-overlay--targeted', Boolean(step.target));

  if (!step.target) {
    spotlight.style.opacity = '0';
    spotlight.classList.remove('active');
    tooltip.classList.add('visible');
    tooltip.style.top = '50%';
    tooltip.style.left = '50%';
    tooltip.style.transform = 'translate(-50%, -50%)';
    return;
  }

  const target = document.querySelector(step.target) as HTMLElement;
  const targetRect = target?.getBoundingClientRect();
  const targetStyle = target ? window.getComputedStyle(target) : null;
  const targetVisible = Boolean(
    target &&
    targetRect &&
    targetRect.width > 0 &&
    targetRect.height > 0 &&
    targetStyle &&
    targetStyle.display !== 'none' &&
    targetStyle.visibility !== 'hidden'
  );

  if (!targetVisible || !targetRect) {
    if (import.meta.env.DEV) console.warn(`Onboarding target not found: ${step.target}, waiting for render...`);
    // Clear any existing retry timeout to prevent stale step skips
    if (_retryTimeout) clearTimeout(_retryTimeout);

    const activeStep = signals.onboarding.value.step;
    if (attempt < TARGET_RETRY_LIMIT && signals.onboarding.value.active) {
      _retryTimeout = window.setTimeout(() => {
        _retryTimeout = null;
        if (!signals.onboarding.value.active || signals.onboarding.value.step !== activeStep) return;
        updateSpotlightPosition(step, attempt + 1);
      }, TARGET_RETRY_DELAY_MS);
      return;
    }

    _retryTimeout = window.setTimeout(() => {
      _retryTimeout = null;
      if (!signals.onboarding.value.active || signals.onboarding.value.step !== activeStep) return;
      if (import.meta.env.DEV) console.warn(`Onboarding target still not found after retry: ${step.target}, skipping`);
      emit(Events.SHOW_TOAST, { message: 'Skipping to the next step', type: 'info' });
      nextStep();
    }, 0);
    return;
  }

  target.classList.add('onboarding-highlight');
  const pad = 8;

  spotlight.style.opacity = '1';
  spotlight.classList.add('active');
  spotlight.style.left = `${targetRect.left - pad}px`;
  spotlight.style.top = `${targetRect.top - pad}px`;
  spotlight.style.width = `${targetRect.width + pad * 2}px`;
  spotlight.style.height = `${targetRect.height + pad * 2}px`;

  // Position tooltip
  let top = 0, left = 0;
  const margin = 20;
  tooltip.classList.add('visible');
  const tooltipRect = tooltip.getBoundingClientRect();
  const tw = tooltipRect.width || 400;
  const th = tooltipRect.height || 250;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceBelow = vh - targetRect.bottom;
  const spaceAbove = targetRect.top;
  const spaceRight = vw - targetRect.right;
  const spaceLeft = targetRect.left;

  if (step.position === 'below' || step.position === 'above') {
    // Prefer below, fall back to above, then pick whichever side has more room
    left = targetRect.left + targetRect.width / 2 - tw / 2;

    if (spaceBelow >= th + margin * 2) {
      top = targetRect.bottom + margin;
    } else if (spaceAbove >= th + margin * 2) {
      top = targetRect.top - th - margin;
    } else if (spaceRight >= tw + margin * 2) {
      // Neither above nor below fits — try right of target
      top = targetRect.top + targetRect.height / 2 - th / 2;
      left = targetRect.right + margin;
    } else if (spaceLeft >= tw + margin * 2) {
      top = targetRect.top + targetRect.height / 2 - th / 2;
      left = targetRect.left - tw - margin;
    } else {
      // Last resort: overlap center of target
      top = targetRect.top + targetRect.height / 2 - th / 2;
    }
  } else if (step.position === 'right') {
    top = targetRect.top + targetRect.height / 2 - th / 2;
    left = targetRect.right + margin;
  } else if (step.position === 'left') {
    top = targetRect.top + targetRect.height / 2 - th / 2;
    left = targetRect.left - tw - margin;
  }

  // Keep on screen
  top = Math.max(margin, Math.min(top, vh - th - margin));
  left = Math.max(margin, Math.min(left, vw - tw - margin));

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
  tooltip.style.transform = 'none';
}

/**
 * Initialize onboarding listeners
 */
export function initOnboarding(): void {
  cleanupOnboarding();
  _listenerGroupId = createListenerGroup('onboarding');

  on(FeatureEvents.START_ONBOARDING, () => {
    onboardingActions.reset();
  }, { groupId: _listenerGroupId });

  // Remove previous ESC listener before re-registering
  if (_escKeydownListener) {
    window.removeEventListener('keydown', _escKeydownListener);
  }

  // Listen for ESC key
  _escKeydownListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && signals.onboarding.value.active) {
      completeOnboarding();
    }
  };
  window.addEventListener('keydown', _escKeydownListener);
}

/**
 * Clean up onboarding listeners
 */
export function cleanupOnboarding(): void {
  if (_listenerGroupId) {
    destroyListenerGroup(_listenerGroupId);
    _listenerGroupId = null;
  }
  if (_escKeydownListener) {
    window.removeEventListener('keydown', _escKeydownListener);
    _escKeydownListener = null;
  }
  if (_retryTimeout) {
    clearTimeout(_retryTimeout);
    _retryTimeout = null;
  }
}
