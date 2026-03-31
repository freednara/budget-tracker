/**
 * Onboarding Module
 * 
 * Reactive first-time user tour using signals and Lit.
 * Coordinates spotlight positioning and multi-tab state.
 */
'use strict';

import { SK } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { onboarding as onboardingActions } from '../../core/state-actions.js';
import { showToast } from '../../ui/core/ui.js';
import { switchMainTab, switchTab } from '../../ui/core/ui-navigation.js';
import { on, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat, classMap } from '../../core/lit-helpers.js';
import { effect } from '@preact/signals-core';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type TooltipPosition = 'below' | 'above' | 'left' | 'right' | 'center';

interface OnboardingStep {
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

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    emoji: '💎',
    title: 'Welcome to Harbor Ledger!',
    body: 'Track what matters, plan the month, and know what you can safely spend next.',
    btn: 'Start Tour',
    target: null,
    tab: 'dashboard',
    position: 'center'
  },
  {
    emoji: '🎯',
    title: 'Plan Your Month',
    body: 'Start here each month. Set your budget so the app knows how much money each category and goal should handle.',
    btn: 'Next',
    target: '#open-plan-budget',
    tab: 'budget',
    position: 'below'
  },
  {
    emoji: '💸',
    title: 'Track Your Spending',
    body: 'Add expenses here. Every transaction helps you understand where your money goes.',
    btn: 'Next',
    target: '#amount',
    tab: 'transactions',
    subTab: 'expense',
    position: 'below'
  },
  {
    emoji: '🏷️',
    title: 'Categorize Everything',
    body: 'Categories help you see spending patterns. Choose what fits best for each transaction.',
    btn: 'Next',
    target: '#category-chips',
    tab: 'transactions',
    position: 'below'
  },
  {
    emoji: '🗓️',
    title: 'Use Calendar to Plan Timing',
    body: 'Calendar shows when money moves. Review daily activity, recurring bills, and jump into transactions for a specific date.',
    btn: 'Next',
    target: '.calendar-main-card',
    tab: 'calendar',
    position: 'below'
  },
  {
    emoji: '📊',
    title: 'Watch the Dashboard',
    body: 'Come back here to react. The dashboard tells you your daily allowance, spending pace, and next action.',
    btn: 'Next',
    target: '#hero-dashboard-card',
    tab: 'dashboard',
    position: 'below'
  },
  {
    emoji: '🚀',
    title: 'You\'re All Set!',
    body: 'You now have the core workflow: budget the month, log money movement, check Calendar for timing, and use Dashboard to stay on track.',
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
 * Start or resume the onboarding tour
 */
export function startOnboarding(): void {
  onboardingActions.start();
}

// Retry timeout for target element detection
let _retryTimeout: number | null = null;
const TARGET_RETRY_DELAY_MS = 180;
const TARGET_RETRY_LIMIT = 10;

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
 * Skip and complete the tour
 */
export function completeOnboarding(): void {
  // Clear any pending retry timeout to prevent stale step-skip firing after completion
  if (_retryTimeout) { clearTimeout(_retryTimeout); _retryTimeout = null; }
  onboardingActions.complete();
  showToast('You\'re ready to track!');
}

// ==========================================
// RENDERER
// ==========================================

/**
 * Mount the reactive onboarding component
 */
export function mountOnboarding(): () => void {
  const container = DOM.get('onboarding-overlay');
  if (!container) return () => {};

  const cleanup = effect(() => {
    const { active, step: stepIdx } = signals.onboarding.value;
    
    if (!active) {
      container.classList.remove('active', 'no-transition', 'onboarding-overlay--centered', 'onboarding-overlay--targeted');
      render(html``, container);
      document.querySelectorAll('.onboarding-highlight').forEach(el => el.classList.remove('onboarding-highlight'));
      return;
    }
    container.classList.add('modal-overlay', 'active', 'no-transition');

    const step = ONBOARDING_STEPS[stepIdx];
    
    // Switch tabs automatically (use navigation functions that sync both signals AND DOM)
    if (signals.activeMainTab.value !== step.tab) {
      switchMainTab(step.tab);
    }
    if (step.subTab && signals.currentTab.value !== step.subTab) {
      switchTab(step.subTab);
    }

    container.classList.toggle('onboarding-overlay--centered', !step.target);
    container.classList.toggle('onboarding-overlay--targeted', Boolean(step.target));

    render(html`
        <div id="onboarding-backdrop" class="onboarding-backdrop" @click=${completeOnboarding}></div>
        <div id="onboarding-spotlight" class="onboarding-spotlight"></div>
        
        <div id="onboarding-tooltip" class="onboarding-tooltip">
          <div class="onboarding-tooltip-content">
            <div class="text-4xl mb-4" id="onboarding-emoji">${step.emoji}</div>
            <h3 class="text-xl font-black text-primary mb-2" id="onboarding-title">${step.title}</h3>
            <p class="text-sm text-secondary leading-relaxed mb-6" id="onboarding-body">${step.body}</p>
            
            <div class="flex items-center justify-between">
              <div class="flex gap-1" id="onboard-progress">
                ${repeat(ONBOARDING_STEPS, (_, i) => i, (_, i) => html`
                  <div class=${classMap({
                    'w-2': true,
                    'h-2': true,
                    'rounded-full': true,
                    'transition-all': true,
                    'duration-300': true,
                    'bg-accent': i === stepIdx,
                    'w-6': i === stepIdx,
                    'bg-accent/40': i < stepIdx,
                    'bg-tertiary/20': i > stepIdx
                  })}></div>
                `)}
              </div>
              
              <div class="flex gap-2">
                <button @click=${completeOnboarding} id="onboard-skip" class="px-4 py-2 text-xs font-bold text-tertiary hover:text-primary transition-colors">Skip</button>
                <button @click=${nextStep} id="onboard-next" class="px-6 py-2 rounded-xl font-bold text-sm btn-primary">
                  ${step.btn}
                </button>
              </div>
            </div>
          </div>
        </div>
    `, container);

    // Position spotlight & tooltip after the live onboarding DOM has been rendered.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateSpotlightPosition(step);
      });
    });
  });

  return cleanup;
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

  if (step.position === 'below') {
    top = targetRect.bottom + margin;
    left = targetRect.left + targetRect.width / 2 - tw / 2;
    if (top + th > window.innerHeight - margin) {
      top = targetRect.top - th - margin;
    }
  } else if (step.position === 'above') {
    top = targetRect.top - th - margin;
    left = targetRect.left + targetRect.width / 2 - tw / 2;
    if (top < margin) {
      top = targetRect.bottom + margin;
    }
  } else if (step.position === 'right') {
    top = targetRect.top + targetRect.height / 2 - th / 2;
    left = targetRect.right + margin;
  } else if (step.position === 'left') {
    top = targetRect.top + targetRect.height / 2 - th / 2;
    left = targetRect.left - tw - margin;
  }

  // Keep on screen
  top = Math.max(margin, Math.min(top, window.innerHeight - th - margin));
  left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));

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
