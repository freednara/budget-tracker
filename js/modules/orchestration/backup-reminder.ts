/**
 * Backup Reminder Module
 *
 * Shows a reminder banner when the user hasn't backed up data recently.
 *
 * @module backup-reminder
 */
'use strict';

import { SK, lsGet } from '../core/state.js';
import * as signals from '../core/signals.js';
import DOM from '../core/dom-cache.js';
import type { Transaction } from '../../types/index.js';

// ==========================================
// MODULE STATE
// ==========================================

// Default reminder threshold (can be overridden)
let reminderDays = 7;

// ==========================================
// CONFIGURATION
// ==========================================

/**
 * Set the backup reminder threshold
 */
export function setReminderDays(days: number): void {
  reminderDays = days;
}

// ==========================================
// REMINDER LOGIC
// ==========================================

/**
 * Check if backup reminder should be shown
 * Shows banner if last backup was more than reminderDays ago
 */
export function checkBackupReminder(): void {
  const lastBackup = lsGet(SK.LAST_BACKUP, 0) as number;
  const daysSince = lastBackup ? Math.floor((Date.now() - lastBackup) / (1000 * 60 * 60 * 24)) : 999;
  const banner = DOM.get('backup-reminder');
  if (!banner) return;

  const transactions = signals.transactions.value as Transaction[];
  const shouldShow = daysSince >= reminderDays && transactions.length > 0;

  if (shouldShow) {
    banner.classList.remove('hidden');
    const daysText = lastBackup ? `${daysSince} days since last backup` : 'No backup found';
    const textEl = DOM.get('backup-reminder-text');
    if (textEl) textEl.textContent = daysText;
  } else {
    // Hide banner if conditions no longer met (e.g., after export)
    banner.classList.add('hidden');
  }
}

/**
 * Hide the backup reminder banner
 */
export function hideBackupReminder(): void {
  const banner = DOM.get('backup-reminder');
  if (banner) banner.classList.add('hidden');
}
