/**
 * Onboarding Module
 * Handles the first-time user tour experience
 */

import { SK, lsGet, lsSet } from '../../core/state.js';
import { showToast } from '../../ui/core/ui.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat, classMap } from '../../core/lit-helpers.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type TooltipPosition = 'center' | 'below' | 'above' | 'left' | 'right';
type MainTab = 'dashboard' | 'transactions' | 'budget';
type SubTab = 'expense' | 'income';

interface OnboardingStep {
  emoji: string;
  title: string;
  body: string;
  btn: string;
  target: string | null;
  tab: MainTab;
  subTab?: SubTab;
  position: TooltipPosition;
}

interface OnboardingState {
  completed: boolean;
  step: number;
}

interface OnboardingCallbacks {
  switchMainTab?: (tab: MainTab) => void;
  switchTab?: (tab: SubTab) => void;
}

// ==========================================
// CONFIGURATION
// ==========================================

/**
 * Onboarding tour steps
 */
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
    target: '.category-chip',
    tab: 'transactions',
    position: 'below'
  },
  {
    emoji: '📊',
    title: 'Monitor Your Dashboard',
    body: 'Your dashboard shows the big picture: daily allowance, spending pace, and insights.',
    btn: 'Next',
    target: '.hero-dashboard-grid',
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
// MODULE STATE
// ==========================================

// Tab switching callbacks (injected from main app)
let switchMainTabFn: ((tab: MainTab) => void) | null = null;
let switchTabFn: ((tab: SubTab) => void) | null = null;

// Store event handlers for cleanup to prevent memory leaks
let currentNextHandler: (() => void) | null = null;
let currentSkipHandler: (() => void) | null = null;
let currentBackdropHandler: (() => void) | null = null;
let currentEscHandler: ((e: KeyboardEvent) => void) | null = null;

// ==========================================
// CONFIGURATION
// ==========================================

/**
 * Set tab switching callbacks
 */
export function setOnboardingCallbacks(callbacks: OnboardingCallbacks): void {
  if (callbacks.switchMainTab) switchMainTabFn = callbacks.switchMainTab;
  if (callbacks.switchTab) switchTabFn = callbacks.switchTab;
}

// ==========================================
// ONBOARDING FUNCTIONS
// ==========================================

/**
 * Start the onboarding tour for new users
 * Checks if onboarding was already completed before showing
 */
export function startOnboarding(): void {
  const onboard = lsGet(SK.ONBOARD, { completed: false, step: 0 }) as OnboardingState;
  if (onboard.completed) return;

  const overlay = DOM.get('onboarding-overlay');
  const backdrop = DOM.get('onboarding-backdrop');
  const spotlight = DOM.get('onboarding-spotlight');
  const tooltip = DOM.get('onboarding-tooltip');

  if (!overlay || !tooltip) return;

  // Show overlay
  overlay.classList.add('active');

  let currentStep = Math.min(onboard.step || 0, ONBOARDING_STEPS.length - 1);

  const renderStep = (): void => {
    const step = ONBOARDING_STEPS[currentStep];

    // Update content
    const emojiEl = DOM.get('onboarding-emoji');
    const titleEl = DOM.get('onboarding-title');
    const bodyEl = DOM.get('onboarding-body');
    const nextBtnEl = DOM.get('onboard-next');
    const progressEl = DOM.get('onboard-progress');

    if (emojiEl) emojiEl.textContent = step.emoji;
    if (titleEl) titleEl.textContent = step.title;
    if (bodyEl) bodyEl.textContent = step.body;
    if (nextBtnEl) nextBtnEl.textContent = step.btn;

    // Update progress dots
    if (progressEl) {
      render(html`
        ${repeat(ONBOARDING_STEPS, (_, i) => i, (_, i) => html`
          <div class=${classMap({
            'onboard-dot': true,
            'completed': i < currentStep,
            'active': i === currentStep,
            'pending': i > currentStep
          })}></div>
        `)}
      `, progressEl);
    }

    // Switch to required tab
    if (step.tab && switchMainTabFn) {
      switchMainTabFn(step.tab);
    }
    if (step.subTab && switchTabFn) {
      const tabFn = switchTabFn;
      setTimeout(() => tabFn(step.subTab!), 100);
    }

    // Position spotlight and tooltip
    setTimeout(() => positionSpotlight(step), 150);
  };

  const positionSpotlight = (step: OnboardingStep): void => {
    if (!spotlight || !tooltip) return;

    // Remove previous highlight
    document.querySelectorAll('.onboarding-highlight').forEach(el => {
      el.classList.remove('onboarding-highlight');
    });

    if (!step.target) {
      // No target - center tooltip, no spotlight
      spotlight.classList.remove('active');
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
      tooltip.classList.add('visible');
      return;
    }

    const targetEl = document.querySelector(step.target);
    if (!targetEl) {
      console.warn('Onboarding target not found:', step.target);
      // Fallback to center
      spotlight.classList.remove('active');
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
      tooltip.classList.add('visible');
      return;
    }

    // Add highlight class
    targetEl.classList.add('onboarding-highlight');

    // Get target position
    const rect = targetEl.getBoundingClientRect();
    const padding = 12;

    // Position spotlight
    spotlight.style.left = `${rect.left - padding}px`;
    spotlight.style.top = `${rect.top - padding}px`;
    spotlight.style.width = `${rect.width + padding * 2}px`;
    spotlight.style.height = `${rect.height + padding * 2}px`;
    spotlight.classList.add('active');

    // Position tooltip relative to target
    const tooltipWidth = 400;
    const tooltipHeight = 300;
    const spacing = 20;

    let top: number, left: number;

    if (step.position === 'below') {
      top = rect.bottom + spacing;
      left = rect.left + rect.width / 2 - tooltipWidth / 2;
    } else if (step.position === 'above') {
      top = rect.top - tooltipHeight - spacing;
      left = rect.left + rect.width / 2 - tooltipWidth / 2;
    } else if (step.position === 'right') {
      top = rect.top + rect.height / 2 - tooltipHeight / 2;
      left = rect.right + spacing;
    } else if (step.position === 'left') {
      top = rect.top + rect.height / 2 - tooltipHeight / 2;
      left = rect.left - tooltipWidth - spacing;
    } else {
      // center
      top = window.innerHeight / 2 - tooltipHeight / 2;
      left = window.innerWidth / 2 - tooltipWidth / 2;
    }

    // Keep tooltip on screen
    const margin = 20;
    top = Math.max(margin, Math.min(top, window.innerHeight - tooltipHeight - margin));
    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipWidth - margin));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.transform = 'none';
    tooltip.classList.add('visible');
  };

  const nextStep = (): void => {
    currentStep++;
    if (currentStep >= ONBOARDING_STEPS.length) {
      completeOnboarding();
    } else {
      lsSet(SK.ONBOARD, { completed: false, step: currentStep });
      renderStep();
    }
  };

  const skipOnboarding = (): void => {
    completeOnboarding();
  };

  const completeOnboarding = (): void => {
    if (!spotlight || !tooltip || !overlay) return;

    // Clean up
    spotlight.classList.remove('active');
    tooltip.classList.remove('visible');
    document.querySelectorAll('.onboarding-highlight').forEach(el => {
      el.classList.remove('onboarding-highlight');
    });

    setTimeout(() => {
      overlay.classList.remove('active');
    }, 300);

    lsSet(SK.ONBOARD, { completed: true, step: currentStep });

    // Show success toast
    showToast('You\'re ready to track! Start by adding your first transaction.');
  };

  // Clean up previous event listeners to prevent memory leaks
  const nextBtn = DOM.get('onboard-next');
  const skipBtn = DOM.get('onboard-skip');
  if (nextBtn && currentNextHandler) nextBtn.removeEventListener('click', currentNextHandler);
  if (skipBtn && currentSkipHandler) skipBtn.removeEventListener('click', currentSkipHandler);
  if (backdrop && currentBackdropHandler) backdrop.removeEventListener('click', currentBackdropHandler);
  if (currentEscHandler) document.removeEventListener('keydown', currentEscHandler);

  // Store new handler references
  currentNextHandler = nextStep;
  currentSkipHandler = skipOnboarding;

  // Add fresh event listeners
  if (nextBtn) nextBtn.addEventListener('click', currentNextHandler);
  if (skipBtn) skipBtn.addEventListener('click', currentSkipHandler);

  // ESC key to skip
  currentEscHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      skipOnboarding();
      if (currentEscHandler) {
        document.removeEventListener('keydown', currentEscHandler);
        currentEscHandler = null;
      }
    }
  };
  document.addEventListener('keydown', currentEscHandler);

  // Backdrop click to skip
  if (backdrop) {
    currentBackdropHandler = skipOnboarding;
    backdrop.addEventListener('click', currentBackdropHandler);
  }

  // Render first step
  renderStep();
}

/**
 * Reset onboarding state to allow re-running the tour
 */
export function resetOnboarding(): void {
  lsSet(SK.ONBOARD, { completed: false, step: 0 });
}
