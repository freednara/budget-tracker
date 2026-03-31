/**
 * Swipe Manager Module
 * Handles swipe gestures for transaction rows on mobile devices
 * 
 * Key improvements:
 * - Per-element state management (fixes multi-touch conflicts)
 * - Angle-based gesture detection with locking
 * - Race condition prevention in animations
 * - Optimized passive event listeners
 */

import type { TouchHandlers, SwipeConfig } from '../../../types/index.js';

// ==========================================
// CONFIGURATION
// ==========================================

interface SwipeConfigInternal extends SwipeConfig {
  VELOCITY_THRESHOLD: number;
  ANGLE_THRESHOLD: number;
  MIN_DISTANCE: number;
}

/**
 * Default swipe configuration (can be overridden)
 */
const DEFAULT_CONFIG: SwipeConfigInternal = {
  threshold: 80,           // Pixels to trigger action reveal
  VELOCITY_THRESHOLD: 0.5, // px/ms for quick swipe
  maxSwipe: 168,           // Maximum swipe distance
  resistance: 0.4,         // Resistance factor past threshold
  ANGLE_THRESHOLD: 30,     // Max angle (degrees) for horizontal swipe
  MIN_DISTANCE: 10         // Minimum distance to start gesture detection
};

// Store config (will be set from main app)
let swipeConfig: SwipeConfigInternal = DEFAULT_CONFIG;

/**
 * Set swipe configuration
 */
export function setSwipeConfig(config: Partial<SwipeConfig>): void {
  swipeConfig = { ...DEFAULT_CONFIG, ...config };
}

// ==========================================
// STATE MANAGEMENT
// ==========================================

/**
 * Per-element swipe state - fixes multi-touch conflicts
 */
interface SwipeState {
  startX: number;
  startY: number;
  startTime: number;
  currentOffset: number;
  isLocked: boolean;        // Gesture direction locked
  isHorizontal: boolean;    // Confirmed horizontal swipe
  pendingCleanup: number | null; // Animation cleanup timer
}

// WeakMap to store listener references for cleanup
const listenerMap = new WeakMap<HTMLElement, TouchHandlers>();

// Per-element state storage - eliminates singleton conflicts
const swipeStates = new WeakMap<HTMLElement, SwipeState>();

// Single active swipe container (for closing others)
let activeSwipeContainer: HTMLElement | null = null;

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Calculate angle between two points in degrees
 */
function getSwipeAngle(deltaX: number, deltaY: number): number {
  // Measure deviation from horizontal axis (0° = horizontal, 90° = vertical)
  // Using abs of both deltas ensures symmetry for left/right and up/down
  return Math.atan2(Math.abs(deltaY), Math.abs(deltaX)) * (180 / Math.PI);
}

/**
 * Get or create swipe state for an element
 */
function getSwipeState(content: HTMLElement): SwipeState {
  let state = swipeStates.get(content);
  if (!state) {
    state = {
      startX: 0,
      startY: 0,
      startTime: 0,
      currentOffset: 0,
      isLocked: false,
      isHorizontal: false,
      pendingCleanup: null
    };
    swipeStates.set(content, state);
  }
  return state;
}

/**
 * Clear pending animation cleanup
 */
function clearPendingCleanup(content: HTMLElement): void {
  const state = swipeStates.get(content);
  if (state?.pendingCleanup) {
    clearTimeout(state.pendingCleanup);
    state.pendingCleanup = null;
  }
}

// ==========================================
// SWIPE MANAGER
// ==========================================

/**
 * SwipeManager handles touch gestures for revealing action buttons
 * on transaction rows in mobile view
 */
export const swipeManager = {
  /**
   * Attach swipe listeners to a container
   */
  attach(container: HTMLElement): void {
    const content = container.querySelector('.swipe-content') as HTMLElement | null;
    if (!content) return;

    // Avoid double-attaching
    if (listenerMap.has(content)) return;

    // Initialize state
    getSwipeState(content);

    // Create bound handlers that we can remove later
    const handlers: TouchHandlers = {
      touchstart: (e: TouchEvent) => this.onTouchStart(e, container, content),
      touchmove: (e: TouchEvent) => this.onTouchMove(e, container, content),
      touchend: (e: TouchEvent) => this.onTouchEnd(e, container, content)
    };

    // touchmove must already be attached when the gesture begins so the first
    // horizontal movement can be measured and locked correctly.
    content.addEventListener('touchstart', handlers.touchstart, { passive: true });
    content.addEventListener('touchmove', handlers.touchmove, { passive: false });
    content.addEventListener('touchend', handlers.touchend, { passive: true });

    // Store handlers for cleanup
    listenerMap.set(content, handlers);
  },

  /**
   * Detach swipe listeners from a container (cleanup)
   */
  detach(container: HTMLElement | null): void {
    const content = container?.querySelector('.swipe-content') as HTMLElement | null;
    if (!content) return;

    const handlers = listenerMap.get(content);
    if (handlers) {
      content.removeEventListener('touchstart', handlers.touchstart);
      content.removeEventListener('touchmove', handlers.touchmove);
      content.removeEventListener('touchend', handlers.touchend);
      listenerMap.delete(content);
    }

    // Clear any pending cleanup timers
    clearPendingCleanup(content);

    // Clean up state
    swipeStates.delete(content);

    // Clear active swipe if this was it
    if (activeSwipeContainer === container) {
      activeSwipeContainer = null;
    }
  },

  /**
   * Handle touch start - optimized with angle detection
   */
  onTouchStart(e: TouchEvent, container: HTMLElement, content: HTMLElement): void {
    // Get per-element state
    const state = getSwipeState(content);

    // Close any other open swipes
    if (activeSwipeContainer && activeSwipeContainer !== container) {
      this.closeSwipe(activeSwipeContainer);
    }

    // Clear any pending animations immediately to prevent race conditions
    clearPendingCleanup(content);
    content.classList.remove('spring-back');

    // Force complete any ongoing transitions
    content.style.transition = 'none';
    requestAnimationFrame(() => {
      content.style.transition = '';
    });

    // Initialize touch state
    state.startX = e.touches[0].clientX;
    state.startY = e.touches[0].clientY;
    state.startTime = Date.now();
    state.currentOffset = 0;
    state.isLocked = false;
    state.isHorizontal = false;

    content.classList.add('swiping');
  },

  /**
   * Handle touch move - with dynamic listener attachment and angle detection
   */
  onTouchMove(e: TouchEvent, container: HTMLElement, content: HTMLElement): void {
    const state = getSwipeState(content);
    if (!state.startX) return;

    const diffX = e.touches[0].clientX - state.startX;
    const diffY = e.touches[0].clientY - state.startY;
    const distance = Math.sqrt(diffX * diffX + diffY * diffY);

    // Early exit if not enough movement
    if (distance < swipeConfig.MIN_DISTANCE) return;

    // Gesture direction detection (only once per gesture)
    if (!state.isLocked) {
      const angle = getSwipeAngle(diffX, diffY);
      
      if (angle <= swipeConfig.ANGLE_THRESHOLD) {
        state.isHorizontal = true;
        state.isLocked = true;
      } else {
        // Vertical scroll - abort swipe and don't interfere
        this.resetSwipe(content);
        return;
      }
    }

    // Only proceed if confirmed horizontal
    if (!state.isHorizontal) return;

    // Prevent scroll for horizontal swipes
    e.preventDefault();

    // Apply resistance past threshold
    let offset = diffX;
    const maxOffset = swipeConfig.maxSwipe;
    if (Math.abs(offset) > swipeConfig.threshold) {
      const extra = Math.abs(offset) - swipeConfig.threshold;
      const resistedExtra = extra * swipeConfig.resistance;
      offset = (offset > 0 ? 1 : -1) * (swipeConfig.threshold + resistedExtra);
    }
    offset = Math.max(-maxOffset, Math.min(maxOffset, offset));

    state.currentOffset = offset;
    content.style.transform = `translateX(${offset}px)`;

    // Show/hide action buttons based on direction
    container.classList.toggle('revealed-left', offset < -40);
    container.classList.toggle('revealed-right', offset > 40);
  },

  /**
   * Handle touch end - with race condition prevention
   */
  onTouchEnd(_e: TouchEvent, container: HTMLElement, content: HTMLElement): void {
    const state = getSwipeState(content);
    
    content.classList.remove('swiping');

    // Only process if we had a confirmed horizontal swipe
    if (!state.isHorizontal) {
      this.resetSwipe(content);
      return;
    }

    const elapsed = Date.now() - state.startTime;
    const velocity = Math.abs(state.currentOffset) / elapsed;
    const quickSwipe = velocity > swipeConfig.VELOCITY_THRESHOLD;

    const threshold = quickSwipe ? 30 : swipeConfig.threshold;

    if (Math.abs(state.currentOffset) >= threshold) {
      // Reveal actions
      const targetOffset = state.currentOffset < 0 ? -swipeConfig.maxSwipe : swipeConfig.maxSwipe;
      content.style.transform = `translateX(${targetOffset}px)`;
      activeSwipeContainer = container;
    } else {
      // Spring back
      this.springBack(container, content);
    }

    // Reset state
    state.startX = 0;
    state.isLocked = false;
    state.isHorizontal = false;
  },

  /**
   * Spring back animation - with race condition prevention
   */
  springBack(container: HTMLElement, content: HTMLElement): void {
    // Clear any existing cleanup timer
    clearPendingCleanup(content);

    const currentTransform = content.style.transform;
    const match = currentTransform.match(/-?\d+/);
    content.style.setProperty('--swipe-offset', (match ? match[0] : '0') + 'px');
    content.style.transform = '';
    content.classList.add('spring-back');
    container.classList.remove('revealed-left', 'revealed-right');

    // Flag to prevent double-cleanup from both transitionend and fallback timeout
    let cleanedUp = false;

    const performCleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      content.classList.remove('spring-back');
      content.removeEventListener('transitionend', handleTransitionEnd);
      const s = getSwipeState(content);
      if (s.pendingCleanup) {
        clearTimeout(s.pendingCleanup);
        s.pendingCleanup = null;
      }
    };

    // Use transitionend event for reliable cleanup
    const handleTransitionEnd = () => {
      performCleanup();
    };

    content.addEventListener('transitionend', handleTransitionEnd, { once: true });

    // Fallback timeout in case transitionend doesn't fire
    const state = getSwipeState(content);
    state.pendingCleanup = window.setTimeout(() => {
      performCleanup();
    }, 450); // Slightly longer than CSS transition
  },

  /**
   * Close a specific swipe
   */
  closeSwipe(container: HTMLElement | null): void {
    const content = container?.querySelector('.swipe-content') as HTMLElement | null;
    if (content) {
      this.springBack(container!, content);
    }
    if (activeSwipeContainer === container) {
      activeSwipeContainer = null;
    }
  },

  /**
   * Reset swipe state - enhanced cleanup
   */
  resetSwipe(content: HTMLElement): void {
    const state = getSwipeState(content);
    
    content.classList.remove('swiping');
    content.style.transform = '';
    
    // Clear pending cleanup
    clearPendingCleanup(content);
    
    // Reset state
    state.startX = 0;
    state.isLocked = false;
    state.isHorizontal = false;
    state.currentOffset = 0;
  },

  /**
   * Close all open swipes
   */
  closeAll(): void {
    document.querySelectorAll<HTMLElement>('.swipe-container').forEach(c => this.closeSwipe(c));
  },

  /**
   * Get performance statistics for debugging
   */
  getStats(): {
    activeSwipes: number;
    attachedElements: number;
    statesInMemory: number;
  } {
    const attachedElements = document.querySelectorAll<HTMLElement>('.swipe-content').length;
    
    return {
      activeSwipes: activeSwipeContainer ? 1 : 0,
      attachedElements,
      statesInMemory: 0 // WeakMaps don't expose size
    };
  },

  /**
   * Force cleanup all resources (for testing/debugging)
   */
  forceCleanup(): void {
    this.closeAll();
    activeSwipeContainer = null;
  }
};

// ==========================================
// EXPORTS
// ==========================================

export default swipeManager;
