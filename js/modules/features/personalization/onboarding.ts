/**
 * Onboarding Module
 * 
 * Reactive first-time user tour using signals and Lit.
 * Coordinates spotlight positioning and multi-tab state.
 */
'use strict';

import { SK } from '../../core/state.js';
import { safeStorage } from '../../core/safe-storage.js';
import * as signals from '../../core/signals.js';
import { showToast } from '../../ui/core/ui.js';
import { switchMainTab, switchTab } from '../../ui/core/ui-navigation.js';
import { on } from '../../core/event-bus.js';
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
    title: 'Welcome to Budget Tracker Elite!',
    body: 'Your personal finance command center. Let me show you around in 30 seconds.',
    btn: 'Start Tour',
    target: null,
    tab: 'dashboard',
    position: 'center'
  },
  {
    emoji: '🎯',
    title: 'Set Your Monthly Income',
    body: 'First, tell us how much money you have to work with each month. This powers your daily allowance calculation.',
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
    emoji: '📊',
    title: 'Monitor Your Dashboard',
    body: 'Your dashboard shows the big picture: daily allowance, spending pace, and insights.',
    btn: 'Next',
    target: '#dashboard-summary',
    tab: 'dashboard',
    position: 'below'
  },
  {
    emoji: '🚀',
    title: 'You\'re All Set!',
    body: 'Start tracking today and watch your financial clarity improve. Pro tip: Add transactions daily for best results.',
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
  const state = signals.onboarding.value;
  signals.onboarding.value = { ...state, active: true };
}

// Retry timeout for target element detection
let _retryTimeout: number | null = null;

// Track ESC keydown listener for cleanup
let _escKeydownListener: ((e: KeyboardEvent) => void) | null = null;

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
    signals.onboarding.value = { ...state, step: nextIdx };
  }
}

/**
 * Skip and complete the tour
 */
export function completeOnboarding(): void {
  // Clear any pending retry timeout to prevent stale step-skip firing after completion
  if (_retryTimeout) { clearTimeout(_retryTimeout); _retryTimeout = null; }
  signals.onboarding.value = { active: false, step: 0, completed: true };
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
      container.classList.remove('active', 'no-transition');
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

    // Position spotlight & tooltip after tab render
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateSpotlightPosition(step);
      });
    });

    render(html`
        <div id="onboarding-backdrop" class="absolute inset-0 bg-black/60 backdrop-blur-[2px]" @click=${completeOnboarding}></div>
        <div id="onboarding-spotlight" class="absolute transition-all duration-300 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] z-[9998] pointer-events-none"></div>
        
        <div id="onboarding-tooltip" class="absolute z-[9999] w-[320px] md:w-[400px] transition-all duration-300">
          <div class="bg-card-section p-6 rounded-2xl shadow-2xl border border-white/10">
            <div class="text-4xl mb-4" id="onboarding-emoji">${step.emoji}</div>
            <h3 class="text-xl font-black text-primary mb-2" id="onboarding-title">${step.title}</h3>
            <p class="text-sm text-secondary leading-relaxed mb-6" id="onboarding-body">${step.body}</p>
            
            <div class="flex items-center justify-between">
              <div class="flex gap-1" id="onboard-progress">
                ${repeat(ONBOARDING_STEPS, (_, i) => i, (_, i) => html`
                  <div class=${classMap({
                    'w-2 h-2 rounded-full transition-all duration-300': true,
                    'bg-accent w-6': i === stepIdx,
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
  });

  return cleanup;
}

/**
 * Position the spotlight and tooltip based on target element
 */
function updateSpotlightPosition(step: OnboardingStep): void {
  const spotlight = DOM.get('onboarding-spotlight');
  const tooltip = DOM.get('onboarding-tooltip');
  if (!spotlight || !tooltip) return;

  document.querySelectorAll('.onboarding-highlight').forEach(el => el.classList.remove('onboarding-highlight'));

  if (!step.target) {
    spotlight.style.opacity = '0';
    tooltip.style.top = '50%';
    tooltip.style.left = '50%';
    tooltip.style.transform = 'translate(-50%, -50%)';
    return;
  }

  const target = document.querySelector(step.target) as HTMLElement;
  if (!target) {
    if (import.meta.env.DEV) console.warn(`Onboarding target not found: ${step.target}, waiting for render...`);
    // Clear any existing retry timeout to prevent stale step skips
    if (_retryTimeout) clearTimeout(_retryTimeout);
    // Retry once after a short delay to let pending DOM updates complete.
    _retryTimeout = window.setTimeout(() => {
      _retryTimeout = null;
      const retryTarget = document.querySelector(step.target!) as HTMLElement;
      if (!retryTarget) {
        if (import.meta.env.DEV) console.warn(`Onboarding target still not found after retry: ${step.target}, skipping`);
        nextStep();
      } else {
        updateSpotlightPosition(step);
      }
    }, 500);
    return;
  }

  target.classList.add('onboarding-highlight');
  const rect = target.getBoundingClientRect();
  const pad = 8;

  spotlight.style.opacity = '1';
  spotlight.style.left = `${rect.left - pad}px`;
  spotlight.style.top = `${rect.top - pad}px`;
  spotlight.style.width = `${rect.width + pad * 2}px`;
  spotlight.style.height = `${rect.height + pad * 2}px`;

  // Position tooltip
  let top = 0, left = 0;
  const margin = 20;
  const tw = tooltip.offsetWidth || 400;
  const th = tooltip.offsetHeight || 250;

  if (step.position === 'below') {
    top = rect.bottom + margin;
    left = rect.left + rect.width / 2 - tw / 2;
  } else if (step.position === 'above') {
    top = rect.top - th - margin;
    left = rect.left + rect.width / 2 - tw / 2;
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
  on(FeatureEvents.START_ONBOARDING, () => {
    signals.onboarding.value = { active: true, step: 0, completed: false };
  });
  
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
  if (_escKeydownListener) {
    window.removeEventListener('keydown', _escKeydownListener);
    _escKeydownListener = null;
  }
  if (_retryTimeout) {
    clearTimeout(_retryTimeout);
    _retryTimeout = null;
  }
}
