/**
 * Recurring Transaction Templates Module
 * 
 * FIXED: Implements a template-based recurring transaction system
 * instead of creating all future occurrences upfront.
 * This prevents database bloat and allows for unlimited recurring series.
 * 
 * @module data/recurring-templates
 */
'use strict';

import * as signals from '../core/signals.js';
import { parseLocalDate, generateId } from '../core/utils.js';
import { SK } from '../core/state.js';
import { safeStorage } from '../core/safe-storage.js';
import { dataSdk } from './data-manager.js';
import type { Transaction } from '../../types/index.js';

type RecurringType = NonNullable<Transaction['recurring_type']>;

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface RecurringTemplate {
  id: string;
  type: 'expense' | 'income';
  category: string;
  amount: number;
  description: string;
  tags: string;
  notes: string;
  startDate: string;
  endDate: string;
  recurringType: RecurringType;
  originalDayOfMonth: number; // Store original day to prevent drift
  lastGeneratedDate?: string; // Track last generated occurrence
  active: boolean;
}

// ==========================================
// STATE MANAGEMENT
// ==========================================

// Store recurring templates separately from transactions
let recurringTemplates: Map<string, RecurringTemplate> = new Map();

/**
 * Load recurring templates from storage
 */
export function loadRecurringTemplates(): void {
  try {
    const templates = safeStorage.getJSON<Record<string, RecurringTemplate>>(SK.RECURRING, {});
    recurringTemplates = new Map(Object.entries(templates));
  } catch (e) {
    if (import.meta.env.DEV) console.error('Failed to load recurring templates:', e);
  }
}

/**
 * Save recurring templates to storage
 */
function saveRecurringTemplates(): void {
  const templatesObj = Object.fromEntries(recurringTemplates);
  safeStorage.setJSON(SK.RECURRING, templatesObj);
}

/**
 * Clear all recurring templates from memory and storage.
 * Used by app reset flows that must fully remove recurring state.
 */
export function clearRecurringTemplates(): void {
  recurringTemplates = new Map();
  safeStorage.setJSON(SK.RECURRING, {});
}

// ==========================================
// TEMPLATE MANAGEMENT
// ==========================================

/**
 * Create a new recurring template (replaces upfront batch creation)
 */
export async function createRecurringTemplate(data: Omit<RecurringTemplate, 'id' | 'lastGeneratedDate' | 'active'>): Promise<string> {
  const id = generateId();
  const template: RecurringTemplate = {
    ...data,
    id,
    active: true,
    originalDayOfMonth: parseLocalDate(data.startDate).getDate()
  };
  
  recurringTemplates.set(id, template);
  saveRecurringTemplates();
  
  // Generate only the first occurrence immediately
  await generateNextOccurrence(template);
  
  return id;
}

/**
 * Update a recurring template
 */
export function updateRecurringTemplate(id: string, updates: Partial<RecurringTemplate>): boolean {
  const template = recurringTemplates.get(id);
  if (!template) return false;
  
  Object.assign(template, updates);
  saveRecurringTemplates();
  return true;
}

/**
 * Delete a recurring template (with option to keep/delete existing transactions)
 */
export async function deleteRecurringTemplate(id: string, deleteExisting: boolean = false): Promise<boolean> {
  const template = recurringTemplates.get(id);
  if (!template) return false;

  if (deleteExisting) {
    // Delete associated transactions BEFORE removing the template,
    // so if deletion fails, the template link still exists for retry
    const allTx = await dataSdk.getAll();
    const toDelete = allTx.filter(
      (tx: Transaction) => (tx as any).recurringTemplateId === id
    );
    for (const tx of toDelete) {
      await dataSdk.delete(tx);
    }
  }

  // Remove template after associated transactions are cleaned up
  recurringTemplates.delete(id);
  saveRecurringTemplates();

  return true;
}

// ==========================================
// OCCURRENCE GENERATION
// ==========================================

/**
 * Generate the next occurrence of a recurring template
 * FIXED: Uses dataSdk.create() for consistent dual-backend persistence
 */
export async function generateNextOccurrence(template: RecurringTemplate): Promise<Transaction | null> {
  if (!template.active) return null;
  
  const now = new Date();
  const endDate = parseLocalDate(template.endDate);
  
  // Calculate next occurrence date
  const nextDate = calculateNextOccurrenceDate(template);
  
  // Check if we've passed the end date
  if (nextDate > endDate) {
    template.active = false;
    saveRecurringTemplates();
    return null;
  }
  
  // Check if it's time to generate this occurrence (within 30 days)
  const daysUntil = Math.floor((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (daysUntil > 30) return null; // Don't generate too far in advance
  
  const dateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;

  // Create the transaction via SDK for atomicity and validation
  const result = await dataSdk.create({
    type: template.type,
    category: template.category,
    amount: template.amount,
    description: template.description,
    tags: template.tags,
    notes: template.notes,
    date: dateStr,
    currency: signals.currency.value?.home ?? 'USD',
    recurring: true,
    recurring_type: template.recurringType,
    recurring_end: template.endDate,
    reconciled: false,
    // Add custom metadata to link back to template
    recurringTemplateId: template.id
  } as any);

  if (!result.isOk || !result.data) {
    if (import.meta.env.DEV) console.error('Failed to generate recurring transaction:', result.error);
    return null;
  }
  
  // Update template state only after successful creation
  template.lastGeneratedDate = dateStr;
  saveRecurringTemplates();

  return result.data;
}

/**
 * Calculate the next occurrence date for a template
 * FIXED: Properly handles month-end dates without drift
 */
function calculateNextOccurrenceDate(template: RecurringTemplate): Date {
  // If no occurrences have been generated yet, the first occurrence IS the start date
  if (!template.lastGeneratedDate) {
    return parseLocalDate(template.startDate);
  }

  const lastDate = parseLocalDate(template.lastGeneratedDate);
  const nextDate = new Date(lastDate);
  
  switch (template.recurringType) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1);
      break;
      
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
      
    case 'biweekly':
      nextDate.setDate(nextDate.getDate() + 14);
      break;
      
    case 'monthly': {
      // FIXED: Use original day of month to prevent drift
      const nextMonth = nextDate.getMonth() + 1;
      const nextYear = nextDate.getFullYear() + (nextMonth > 11 ? 1 : 0);
      const actualMonth = nextMonth % 12;
      const maxDay = new Date(nextYear, actualMonth + 1, 0).getDate();
      const targetDay = Math.min(template.originalDayOfMonth, maxDay);
      return new Date(nextYear, actualMonth, targetDay);
    }
    
    case 'quarterly': {
      // FIXED: Properly handle year wrap-around for quarterly
      let nextMonth = nextDate.getMonth() + 3;
      let nextYear = nextDate.getFullYear();
      
      if (nextMonth > 11) {
        nextYear += Math.floor(nextMonth / 12);
        nextMonth = nextMonth % 12;
      }
      
      const maxDay = new Date(nextYear, nextMonth + 1, 0).getDate();
      const targetDay = Math.min(template.originalDayOfMonth, maxDay);
      return new Date(nextYear, nextMonth, targetDay);
    }
    
    case 'yearly': {
      // FIXED: Consistent year increment
      const nextYear = nextDate.getFullYear() + 1;
      const month = nextDate.getMonth();
      const maxDay = new Date(nextYear, month + 1, 0).getDate();
      const targetDay = Math.min(template.originalDayOfMonth, maxDay);
      return new Date(nextYear, month, targetDay);
    }
  }
  
  return nextDate;
}

// ==========================================
// DAILY PROCESSING
// ==========================================

/**
 * Process all recurring templates to generate due occurrences
 * Should be called daily (on app load or via a scheduled job)
 */
export async function processRecurringTemplates(): Promise<number> {
  let generated = 0;
  
  for (const template of recurringTemplates.values()) {
    if (!template.active) continue;
    
    // Keep generating occurrences until we're caught up
    let attempts = 0;
    while (attempts < 100) { // Safety limit
      const tx = await generateNextOccurrence(template);
      if (!tx) break;
      generated++;
      attempts++;
    }
  }
  
  return generated;
}

// ==========================================
// MIGRATION
// ==========================================

// migrateToTemplateSystem removed - was never imported/used.
// Migration logic should go through migration.ts for centralized tracking.

// ==========================================
// INITIALIZATION
// ==========================================

// Load templates on module import
loadRecurringTemplates();

// RECURRING key already exists in SK
