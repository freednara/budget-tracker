/**
 * Swipe Manager Module
 * Handles swipe gestures for transaction rows on mobile devices
 */

import type { TouchHandlers, SwipeConfig } from '../../../types/index.js';

// ==========================================
// CONFIGURATION
// ==========================================

interface SwipeConfigInternal extends SwipeConfig {
  VELOCITY_THRESHOLD: number;
}

/**
 * Default swipe configuration (can be overridden)
 */
const DEFAULT_CONFIG: SwipeConfigInternal = {
  threshold: 80,           // Pixels to trigger action reveal
  VELOCITY_THRESHOLD: 0.5, // px/ms for quick swipe
  maxSwipe: 140,           // Maximum swipe distance
  resistance: 0.4          // Resistance factor past threshold
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
// SWIPE MANAGER
// ==========================================

// WeakMap to store listener references for cleanup
const listenerMap = new WeakMap<HTMLElement, TouchHandlers>();

interface SwipeManagerState {
  activeSwipe: HTMLElement | null;
  startX: number;
  startY: number;
  startTime: number;
  currentOffset: number;
}

/**
 * SwipeManager handles touch gestures for revealing action buttons
 * on transaction rows in mobile view
 */
export const swipeManager = {
  activeSwipe: null as HTMLElement | null,
  startX: 0,
  startY: 0,
  startTime: 0,
  currentOffset: 0,

  /**
   * Attach swipe listeners to a container
   */
  attach(container: HTMLElement): void {
    const content = container.querySelector('.swipe-content') as HTMLElement | null;
    if (!content) return;

    // Avoid double-attaching
    if (listenerMap.has(content)) return;

    // Create bound handlers that we can remove later
    const handlers: TouchHandlers = {
      touchstart: (e: TouchEvent) => this.onTouchStart(e, container, content),
      touchmove: (e: TouchEvent) => this.onTouchMove(e, container, content),
      touchend: (e: TouchEvent) => this.onTouchEnd(e, container, content)
    };

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

    // Clear active swipe if this was it
    if (this.activeSwipe === container) {
      this.activeSwipe = null;
    }
  },

  /**
   * Handle touch start
   */
  onTouchStart(e: TouchEvent, container: HTMLElement, content: HTMLElement): void {
    // Close any other open swipes
    if (this.activeSwipe && this.activeSwipe !== container) {
      this.closeSwipe(this.activeSwipe);
    }

    this.startX = e.touches[0].clientX;
    this.startY = e.touches[0].clientY;
    this.startTime = Date.now();
    this.currentOffset = 0;
    content.classList.add('swiping');
    content.classList.remove('spring-back');
  },

  /**
   * Handle touch move
   */
  onTouchMove(e: TouchEvent, container: HTMLElement, content: HTMLElement): void {
    if (!this.startX) return;

    const diffX = e.touches[0].clientX - this.startX;
    const diffY = Math.abs(e.touches[0].clientY - this.startY);

    // If vertical scroll detected, abort swipe
    if (diffY > 30 && Math.abs(diffX) < 30) {
      this.resetSwipe(content);
      return;
    }

    // Prevent scroll if horizontal swipe
    if (Math.abs(diffX) > 10) {
      e.preventDefault();
    }

    // Apply resistance past threshold
    let offset = diffX;
    const maxOffset = swipeConfig.maxSwipe;
    if (Math.abs(offset) > swipeConfig.threshold) {
      const extra = Math.abs(offset) - swipeConfig.threshold;
      const resistedExtra = extra * swipeConfig.resistance;
      offset = (offset > 0 ? 1 : -1) * (swipeConfig.threshold + resistedExtra);
    }
    offset = Math.max(-maxOffset, Math.min(maxOffset, offset));

    this.currentOffset = offset;
    content.style.transform = `translateX(${offset}px)`;

    // Show/hide action buttons based on direction
    container.classList.toggle('revealed-left', offset < -40);
    container.classList.toggle('revealed-right', offset > 40);
  },

  /**
   * Handle touch end
   */
  onTouchEnd(_e: TouchEvent, container: HTMLElement, content: HTMLElement): void {
    content.classList.remove('swiping');

    const elapsed = Date.now() - this.startTime;
    const velocity = Math.abs(this.currentOffset) / elapsed;
    const quickSwipe = velocity > swipeConfig.VELOCITY_THRESHOLD;

    const threshold = quickSwipe ? 30 : swipeConfig.threshold;

    if (Math.abs(this.currentOffset) >= threshold) {
      // Reveal actions
      const targetOffset = this.currentOffset < 0 ? -swipeConfig.maxSwipe : swipeConfig.maxSwipe;
      content.style.transform = `translateX(${targetOffset}px)`;
      this.activeSwipe = container;
    } else {
      // Spring back
      this.springBack(container, content);
    }

    this.startX = 0;
  },

  /**
   * Spring back animation
   */
  springBack(container: HTMLElement, content: HTMLElement): void {
    const currentTransform = content.style.transform;
    const match = currentTransform.match(/-?\d+/);
    content.style.setProperty('--swipe-offset', (match ? match[0] : '0') + 'px');
    content.style.transform = '';
    content.classList.add('spring-back');
    container.classList.remove('revealed-left', 'revealed-right');
    setTimeout(() => content.classList.remove('spring-back'), 400);
  },

  /**
   * Close a specific swipe
   */
  closeSwipe(container: HTMLElement | null): void {
    const content = container?.querySelector('.swipe-content') as HTMLElement | null;
    if (content) {
      this.springBack(container!, content);
    }
    if (this.activeSwipe === container) {
      this.activeSwipe = null;
    }
  },

  /**
   * Reset swipe state
   */
  resetSwipe(content: HTMLElement): void {
    content.classList.remove('swiping');
    content.style.transform = '';
    this.startX = 0;
  },

  /**
   * Close all open swipes
   */
  closeAll(): void {
    document.querySelectorAll<HTMLElement>('.swipe-container').forEach(c => this.closeSwipe(c));
  }
};
