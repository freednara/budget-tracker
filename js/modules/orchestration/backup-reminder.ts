/**
 * Enhanced Backup Reminder Module
 * 
 * Fully reactive backup reminder system using signals and Lit.
 * Monitors transaction changes and time elapsed since last backup.
 */
'use strict';

import { SK } from '../core/state.js';
import { safeStorage } from '../core/safe-storage.js';
import * as signals from '../core/signals.js';
import DOM from '../core/dom-cache.js';
import { html, render, classMap } from '../core/lit-helpers.js';
import { effect, computed } from '@preact/signals-core';

// ==========================================
// CONFIGURATION
// ==========================================

interface BackupReminderConfig {
  reminderDays: number;
  transactionThreshold: number;
  snoozeHours: number;
  maxSnoozeCount: number;
  urgentThreshold: number;
}

const DEFAULT_CONFIG: BackupReminderConfig = {
  reminderDays: 7,
  transactionThreshold: 5,
  snoozeHours: 24,
  maxSnoozeCount: 3,
  urgentThreshold: 14
};

const SNOOZE_KEY = 'backup_reminder_snooze';
const SNOOZE_COUNT_KEY = 'backup_reminder_snooze_count';

// ==========================================
// REACTIVE STATE
// = :=========================================

const snoozeUntil = signals.signal<number>(safeStorage.getJSON(SNOOZE_KEY, 0));
const snoozeCount = signals.signal<number>(safeStorage.getJSON(SNOOZE_COUNT_KEY, 0));

/**
 * Computed backup status
 */
const backupStatus = computed(() => {
  const lastTs = signals.lastBackup.value;
  const lastCount = signals.lastBackupTxCount.value;
  const currentCount = signals.transactions.value.length;

  // Cache Date.now() to avoid multiple calls per computation
  const now = Date.now();

  // Handle both numeric timestamps and ISO date strings (from import)
  let lastTsNum: number;
  if (typeof lastTs === 'string' && lastTs) {
    lastTsNum = new Date(lastTs).getTime();
  } else {
    lastTsNum = Number(lastTs) || 0;
  }
  const MS_PER_DAY = 86_400_000; // 1000 * 60 * 60 * 24
  const daysSince = lastTsNum > 0 ? Math.floor((now - lastTsNum) / MS_PER_DAY) : 0;
  const newTxCount = Math.max(0, currentCount - lastCount);
  const isSnoozed = snoozeUntil.value > now;
  
  const isUrgent = daysSince >= DEFAULT_CONFIG.urgentThreshold;
  const reachedSnoozeLimit = snoozeCount.value >= DEFAULT_CONFIG.maxSnoozeCount;

  const shouldShow = (
    currentCount > 0 && 
    !isSnoozed &&
    (
      daysSince >= DEFAULT_CONFIG.reminderDays || 
      newTxCount >= DEFAULT_CONFIG.transactionThreshold ||
      (reachedSnoozeLimit && daysSince > 0) ||
      isUrgent
    )
  );

  let priority: 'low' | 'medium' | 'high' | 'urgent' = 'low';
  let title = 'Backup Available';
  let message = `${daysSince} days since last backup.`;

  if (isUrgent) {
    priority = 'urgent';
    title = 'Urgent: Backup Required';
    message = `${daysSince} days since backup! ${newTxCount} new transactions at risk.`;
  } else if (newTxCount >= DEFAULT_CONFIG.transactionThreshold * 2) {
    priority = 'high';
    title = 'Important: Many Changes';
    message = `${newTxCount} new transactions since your last backup.`;
  } else if (lastTsNum === 0) {
    priority = 'medium';
    title = 'First Backup';
    message = `You have ${currentCount} transactions. Create your first backup to protect your data.`;
  }

  return { shouldShow, priority, title, message, newTxCount, totalCount: currentCount, isUrgent, reachedSnoozeLimit };
});

// ==========================================
// ACTIONS
// ==========================================

/**
 * Snooze the reminder
 */
export function snoozeBackupReminder(): void {
  const until = Date.now() + (DEFAULT_CONFIG.snoozeHours * 60 * 60 * 1000);
  const nextCount = snoozeCount.value + 1;
  
  snoozeUntil.value = until;
  snoozeCount.value = nextCount;
  
  safeStorage.setJSON(SNOOZE_KEY, until);
  safeStorage.setJSON(SNOOZE_COUNT_KEY, nextCount);
}

/**
 * Mark backup as completed
 */
export function markBackupCompleted(): void {
  const currentCount = signals.transactions.value.length;
  const now = Date.now();

  signals.lastBackup.value = now;
  signals.lastBackupTxCount.value = currentCount;
  
  snoozeUntil.value = 0;
  snoozeCount.value = 0;
  
  safeStorage.setJSON(SNOOZE_KEY, 0);
  safeStorage.setJSON(SNOOZE_COUNT_KEY, 0);
}

// ==========================================
// RENDERER
// ==========================================

/**
 * Mount the reactive backup reminder component
 */
export function mountBackupReminder(): () => void {
  const container = DOM.get('backup-reminder');
  if (!container) return () => {};

  const cleanup = effect(() => {
    const status = backupStatus.value;
    
    if (!status.shouldShow) {
      render(html``, container);
      return;
    }

    render(html`
      <div class=${classMap({ 'backup-banner': true, [`priority-${status.priority}`]: true })} role="alert">
        <div class="flex items-center justify-between gap-4">
          <div class="flex-1">
            <h4 class="font-black text-sm uppercase tracking-tighter leading-none mb-1">
              ${status.title}
            </h4>
            <p class="text-xs opacity-90 leading-tight">
              ${status.message}
            </p>
            <div class="text-[10px] mt-1 font-bold opacity-75">
              ${status.newTxCount} new • ${status.totalCount} total
            </div>
          </div>
          
          <div class="flex gap-2">
            ${!status.isUrgent && !status.reachedSnoozeLimit ? html`
              <button @click=${snoozeBackupReminder} 
                      class="px-3 py-1.5 rounded-lg text-[10px] font-bold bg-black/10 hover:bg-black/20 transition-colors">
                ${snoozeCount.value > 0 ? `Snooze (${DEFAULT_CONFIG.maxSnoozeCount - snoozeCount.value})` : 'Snooze 24h'}
              </button>
            ` : ''}
            
            <button @click=${() => window.dispatchEvent(new CustomEvent('request-export'))}
                    class="px-4 py-1.5 rounded-lg text-[10px] font-bold bg-white text-black hover:scale-105 active:scale-95 transition-all shadow-sm">
              ${status.isUrgent ? 'BACKUP NOW!' : 'Create Backup'}
            </button>
          </div>
        </div>
      </div>
    `, container);
  });

  return cleanup;
}

/**
 * Legacy support for checkBackupReminder (now reactive)
 */
export function checkBackupReminder(): void {
  // Logic is now automatic via effect() in mountBackupReminder
}

/**
 * Statistics for UI and debug
 */
export function getBackupStats() {
  return backupStatus.peek();
}
