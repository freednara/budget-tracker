/**
 * Settings Modal Event Handlers
 * 
 * Enhanced with accessibility announcements for screen readers.
 * Provides feedback for all settings changes and critical actions.
 */
'use strict';

import { announcer, aria } from '../core/accessibility.js';

// ==========================================
// EVENT HANDLER ENHANCEMENTS
// ==========================================

/**
 * Announce theme change to screen readers
 */
export function announceThemeChange(themeName: string): void {
  const themeLabels: Record<string, string> = {
    'dark': 'Dark theme',
    'light': 'Light theme', 
    'system': 'System theme'
  };
  
  const label = themeLabels[themeName] || themeName;
  announcer.announce(`${label} selected`, 'polite');
}

/**
 * Announce currency change to screen readers
 */
export function announceCurrencyChange(currency: string, symbol: string): void {
  announcer.announce(`Currency changed to ${currency}`, 'polite');
}

/**
 * Announce insight personality change
 */
export function announceInsightPersonalityChange(personality: string): void {
  const personalityLabels: Record<string, string> = {
    'serious': 'Serious',
    'friendly': 'Friendly',
    'roast': 'Roast Me'
  };
  
  const label = personalityLabels[personality] || personality;
  announcer.announce(`Insight tone changed to ${label}`, 'polite');
}

/**
 * Announce PIN actions
 */
export function announcePinAction(action: 'created' | 'updated' | 'removed'): void {
  const messages = {
    'created': 'PIN protection enabled',
    'updated': 'PIN updated successfully',
    'removed': 'PIN protection disabled'
  };
  
  announcer.announce(messages[action], 'polite');
}

/**
 * Announce custom category actions
 */
export function announceCategoryAction(
  action: 'created' | 'deleted',
  categoryName: string
): void {
  const messages = {
    'created': `Custom category "${categoryName}" created`,
    'deleted': `Custom category "${categoryName}" deleted`
  };
  
  announcer.announce(messages[action], 'polite');
}

/**
 * Announce rollover setting changes
 */
export function announceRolloverChange(enabled: boolean): void {
  const message = enabled ? 'Budget rollover enabled' : 'Budget rollover disabled';
  announcer.announce(message, 'polite');
}

/**
 * Announce data export/import actions
 */
export function announceDataAction(
  action: 'exported' | 'imported' | 'cleared',
  details?: string
): void {
  let message: string;
  
  switch (action) {
    case 'exported':
      message = details ? `Data exported: ${details}` : 'Data exported successfully';
      break;
    case 'imported':
      message = details ? `Data imported: ${details}` : 'Data imported successfully';
      break;
    case 'cleared':
      message = 'All data cleared';
      break;
  }
  
  announcer.announce(message, 'assertive');
}

/**
 * Announce validation errors for settings
 */
export function announceValidationError(field: string, error: string): void {
  announcer.announce(`${field}: ${error}`, 'assertive');
}

/**
 * Announce settings saved
 */
export function announceSettingsSaved(): void {
  announcer.announce('Settings saved', 'polite');
}

// ==========================================
// ENHANCED ARIA HELPERS
// ==========================================

/**
 * Update theme button states with proper ARIA
 */
export function updateThemeButtonStates(selectedTheme: string): void {
  const themeButtons = document.querySelectorAll('.theme-btn');
  themeButtons.forEach((button: Element) => {
    const htmlButton = button as HTMLButtonElement;
    const theme = htmlButton.dataset.theme;
    const isSelected = theme === selectedTheme;
    
    // Update aria-pressed state
    htmlButton.setAttribute('aria-pressed', String(isSelected));
    
    // Update visual styling
    if (isSelected) {
      htmlButton.style.background = 'var(--color-accent)';
      htmlButton.style.color = 'white';
      htmlButton.style.borderColor = 'var(--color-accent)';
    } else {
      htmlButton.style.background = 'var(--bg-input)';
      htmlButton.style.color = 'var(--text-primary)';
      htmlButton.style.borderColor = 'var(--border-input)';
    }
  });
}

/**
 * Enhanced focus management for modal navigation
 */
export function enhanceModalFocus(): void {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  
  // Keep initial modal focus off native select controls on mobile Safari.
  const firstFocusable = modal.querySelector(
    '[data-modal-initial-focus], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), select:not([disabled])'
  ) as HTMLElement;
  
  if (firstFocusable) {
    firstFocusable.focus();
  }
  
  // Add aria-describedby for complex sections
  const rolloverSection = document.getElementById('rollover-options');
  if (rolloverSection) {
    const rolloverCheckbox = document.getElementById('rollover-enabled') as HTMLElement;
    if (rolloverCheckbox) {
      rolloverCheckbox.setAttribute('aria-describedby', 'rollover-options');
    }
  }
}

/**
 * Announce form validation status
 */
export function announceFormValidation(isValid: boolean, errors: string[] = []): void {
  if (isValid) {
    announcer.announce('All settings are valid', 'polite');
  } else {
    const errorMessage = `${errors.length} validation error${errors.length > 1 ? 's' : ''}: ${errors.join(', ')}`;
    announcer.announce(errorMessage, 'assertive');
  }
}

/**
 * Create accessible status region for settings feedback
 */
export function createSettingsStatusRegion(): void {
  const existingStatus = document.getElementById('settings-status');
  if (existingStatus) return;
  
  const statusRegion = document.createElement('div');
  statusRegion.id = 'settings-status';
  statusRegion.setAttribute('aria-live', 'polite');
  statusRegion.setAttribute('aria-atomic', 'true');
  statusRegion.className = 'sr-only'; // Screen reader only
  
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.appendChild(statusRegion);
  }
}

/**
 * Update settings status region
 */
export function updateSettingsStatus(message: string): void {
  const statusRegion = document.getElementById('settings-status');
  if (statusRegion) {
    statusRegion.textContent = message;
  }
}

// ==========================================
// INTEGRATION HELPERS
// ==========================================

/**
 * Enhance existing settings event handlers with announcements
 */
export function enhanceSettingsAccessibility(): void {
  // Create status region
  createSettingsStatusRegion();
  
  // Enhance modal focus
  enhanceModalFocus();
  
  // Add keyboard navigation hints
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.setAttribute('aria-describedby', 'settings-modal-description');
    
    // Add description for screen readers (guard against duplicates)
    if (!document.getElementById('settings-modal-description')) {
      const description = document.createElement('div');
      description.id = 'settings-modal-description';
      description.className = 'sr-only';
      description.textContent = 'Configure application settings. Use Tab to navigate, Space to select checkboxes, Enter to activate buttons.';
      modal.appendChild(description);
    }
  }
}

export default {
  announceThemeChange,
  announceCurrencyChange,
  announceInsightPersonalityChange,
  announcePinAction,
  announceCategoryAction,
  announceRolloverChange,
  announceDataAction,
  announceValidationError,
  announceSettingsSaved,
  updateThemeButtonStates,
  enhanceModalFocus,
  announceFormValidation,
  enhanceSettingsAccessibility,
  updateSettingsStatus
};
