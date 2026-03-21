/**
 * Automatic Backup Module
 * 
 * Implements automatic scheduled backups with versioning,
 * compression, and cloud storage support.
 */

import { SK, lsGet, lsSet } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { downloadBlob } from '../../core/utils-dom.js';
import { showToast } from '../../ui/core/ui.js';
import { generateId, getTodayStr } from '../../core/utils-pure.js';
import { trackError } from '../../core/error-tracker.js';
import type { Transaction, SavingsGoal, CustomCategory } from '../../../types/index.js';

// ==========================================
// TYPES
// ==========================================

interface BackupMetadata {
  id: string;
  timestamp: number;
  version: string;
  deviceId: string;
  transactionCount: number;
  compressed: boolean;
  checksum?: string;
  size: number;
}

export interface BackupData {
  metadata: BackupMetadata;
  data: {
    transactions: Transaction[];
    savingsGoals: Record<string, SavingsGoal>;
    monthlyAllocations: Record<string, any>;
    customCategories: CustomCategory[];
    debts: any[];
    settings: any;
    [key: string]: any;
  };
}

interface BackupSchedule {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string; // HH:MM format
  lastBackup?: number;
  nextBackup?: number;
  retainCount: number; // Number of backups to retain
}

interface BackupStatus {
  inProgress: boolean;
  lastSuccess?: number;
  lastError?: string;
  totalBackups: number;
  totalSize: number;
}

// ==========================================
// CONSTANTS
// ==========================================

const BACKUP_STORAGE_KEY = 'budget_tracker_auto_backups';
const BACKUP_SCHEDULE_KEY = 'budget_tracker_backup_schedule';
const BACKUP_STATUS_KEY = 'budget_tracker_backup_status';
const MAX_LOCAL_BACKUPS = 10;
const BACKUP_VERSION = '2.0';
const DEVICE_ID = getOrCreateDeviceId();

// ==========================================
// MODULE STATE
// ==========================================

let backupSchedule: BackupSchedule = getBackupSchedule();
let backupStatus: BackupStatus = getBackupStatus();
let scheduledBackupTimer: number | null = null;

// ==========================================
// BACKUP CREATION
// ==========================================

/**
 * Create a backup of all data
 */
export async function createBackup(manual: boolean = false): Promise<BackupData | null> {
  try {
    // Update status
    backupStatus.inProgress = true;
    saveBackupStatus();
    
    // Collect all data
    const backupData: BackupData = {
      metadata: {
        id: generateId(),
        timestamp: Date.now(),
        version: BACKUP_VERSION,
        deviceId: DEVICE_ID,
        transactionCount: signals.transactions.value.length,
        compressed: false,
        size: 0
      },
      data: {
        transactions: signals.transactions.value,
        savingsGoals: signals.savingsGoals.value,
        monthlyAllocations: signals.monthlyAlloc.value,
        customCategories: signals.customCats.value,
        debts: signals.debts.value,
        settings: {
          currency: signals.currency.value,
          rolloverSettings: signals.rolloverSettings.value,
          achievements: signals.achievements.value,
          streak: signals.streak.value
        },
        // Include additional data
        filterPresets: lsGet(SK.FILTER_PRESETS, []),
        txTemplates: lsGet(SK.TX_TEMPLATES, []),
        savingsContributions: lsGet(SK.SAVINGS_CONTRIB, []),
        alerts: lsGet(SK.ALERTS, {})
      }
    };
    
    // Calculate size first, then compute checksum on the final state (minus checksum field)
    const sizeStr = JSON.stringify(backupData);
    backupData.metadata.size = sizeStr.length;

    // Re-serialize with correct size, then compute checksum
    const checksumStr = JSON.stringify(backupData);
    backupData.metadata.checksum = await generateChecksum(checksumStr);

    // Note: compression is not currently used for storage since the compressed
    // data isn't persisted. The metadata.compressed flag stays false.

    // Store backup locally
    await storeBackupLocally(backupData);
    
    // Update status
    backupStatus.inProgress = false;
    backupStatus.lastSuccess = Date.now();
    backupStatus.totalBackups++;
    backupStatus.totalSize += backupData.metadata.size;
    saveBackupStatus();
    
    // Update last backup time
    if (!manual) {
      backupSchedule.lastBackup = Date.now();
      scheduleNextBackup();
    }
    
    // Notify user if manual
    if (manual) {
      showToast('Backup created successfully', 'success');
    }
    
    return backupData;
    
  } catch (error) {
    backupStatus.inProgress = false;
    backupStatus.lastError = error instanceof Error ? error.message : 'Unknown error';
    saveBackupStatus();
    
    trackError(error as Error, {
      module: 'backup',
      action: 'create_backup'
    });
    
    if (manual) {
      showToast('Backup failed', 'error');
    }
    
    return null;
  }
}

/**
 * Store backup locally
 */
async function storeBackupLocally(backup: BackupData): Promise<void> {
  const backups = lsGet<BackupData[]>(BACKUP_STORAGE_KEY, []);
  
  // Add new backup
  backups.push(backup);
  
  // Sort by timestamp (newest first)
  backups.sort((a, b) => b.metadata.timestamp - a.metadata.timestamp);
  
  // Trim to max count
  if (backups.length > MAX_LOCAL_BACKUPS) {
    backups.splice(MAX_LOCAL_BACKUPS);
  }
  
  // Save
  lsSet(BACKUP_STORAGE_KEY, backups);
}

// ==========================================
// BACKUP RESTORATION
// ==========================================

/**
 * Restore from a backup
 */
export async function restoreBackup(backupId: string): Promise<boolean> {
  try {
    const backups = lsGet<BackupData[]>(BACKUP_STORAGE_KEY, []);
    const backup = backups.find(b => b.metadata.id === backupId);
    
    if (!backup) {
      throw new Error('Backup not found');
    }
    
    // Verify checksum if present
    if (backup.metadata.checksum) {
      // Checksum was computed on the backup before the checksum field was set,
      // so we must strip it to get the same input
      const savedChecksum = backup.metadata.checksum;
      const verifyClone = JSON.parse(JSON.stringify(backup));
      delete verifyClone.metadata.checksum;
      const dataStr = JSON.stringify(verifyClone);
      const checksum = await generateChecksum(dataStr);
      if (checksum !== savedChecksum) {
        throw new Error('Backup integrity check failed');
      }
    }
    
    // Create a backup of current data before restoring
    await createBackup(true);
    
    // Restore data -- persist transactions to localStorage so they survive reload
    // (IndexedDB is synced from localStorage by the storage manager)
    signals.transactions.value = backup.data.transactions;
    lsSet(SK.TX, backup.data.transactions);
    signals.savingsGoals.value = backup.data.savingsGoals;
    signals.monthlyAlloc.value = backup.data.monthlyAllocations;
    signals.customCats.value = backup.data.customCategories;
    signals.debts.value = backup.data.debts;
    
    // Restore settings
    if (backup.data.settings) {
      signals.currency.value = backup.data.settings.currency;
      signals.rolloverSettings.value = backup.data.settings.rolloverSettings;
      signals.achievements.value = backup.data.settings.achievements;
      signals.streak.value = backup.data.settings.streak;
    }
    
    // Restore additional data
    lsSet(SK.FILTER_PRESETS, backup.data.filterPresets || []);
    lsSet(SK.TX_TEMPLATES, backup.data.txTemplates || []);
    lsSet(SK.SAVINGS_CONTRIB, backup.data.savingsContributions || []);
    lsSet(SK.ALERTS, backup.data.alerts || {});
    
    showToast('Backup restored successfully', 'success');
    
    // Trigger UI refresh
    window.dispatchEvent(new CustomEvent('data-restored'));
    
    return true;
    
  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'restore_backup'
    });
    
    showToast(`Restore failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    return false;
  }
}

// ==========================================
// BACKUP SCHEDULING
// ==========================================

/**
 * Enable automatic backups
 */
export function enableAutoBackup(
  frequency: BackupSchedule['frequency'] = 'daily',
  time: string = '02:00'
): void {
  backupSchedule = {
    enabled: true,
    frequency,
    time,
    retainCount: 7
  };
  
  saveBackupSchedule();
  scheduleNextBackup();
  
  showToast('Automatic backups enabled', 'success');
}

/**
 * Disable automatic backups
 */
export function disableAutoBackup(): void {
  backupSchedule.enabled = false;
  saveBackupSchedule();
  
  if (scheduledBackupTimer) {
    clearTimeout(scheduledBackupTimer);
    scheduledBackupTimer = null;
  }
  
  showToast('Automatic backups disabled', 'info');
}

/**
 * Schedule the next backup
 */
function scheduleNextBackup(): void {
  if (!backupSchedule.enabled) return;
  
  // Clear existing timer
  if (scheduledBackupTimer) {
    clearTimeout(scheduledBackupTimer);
  }
  
  // Calculate next backup time
  const now = new Date();
  const [hours, minutes] = backupSchedule.time.split(':').map(Number);
  const nextBackup = new Date();
  nextBackup.setHours(hours, minutes, 0, 0);
  
  // If time has passed today, schedule for tomorrow
  if (nextBackup.getTime() <= now.getTime()) {
    nextBackup.setDate(nextBackup.getDate() + 1);
  }
  
  // Adjust based on frequency
  if (backupSchedule.frequency === 'weekly') {
    // Schedule for next Sunday
    const daysUntilSunday = (7 - nextBackup.getDay()) % 7;
    if (daysUntilSunday > 0) {
      nextBackup.setDate(nextBackup.getDate() + daysUntilSunday);
    }
  } else if (backupSchedule.frequency === 'monthly') {
    // Schedule for first of next month
    nextBackup.setDate(1);
    if (nextBackup.getTime() <= now.getTime()) {
      nextBackup.setMonth(nextBackup.getMonth() + 1);
    }
  }
  
  backupSchedule.nextBackup = nextBackup.getTime();
  saveBackupSchedule();
  
  // Set timer
  const delay = nextBackup.getTime() - now.getTime();
  scheduledBackupTimer = window.setTimeout(() => {
    performScheduledBackup();
  }, delay);
}

/**
 * Perform a scheduled backup
 */
async function performScheduledBackup(): Promise<void> {
  await createBackup(false);
  scheduleNextBackup();
}

// ==========================================
// BACKUP EXPORT/IMPORT
// ==========================================

/**
 * Export backup to file
 */
export async function exportBackup(backupId?: string): Promise<void> {
  try {
    let backup: BackupData | null;
    
    if (backupId) {
      const backups = lsGet<BackupData[]>(BACKUP_STORAGE_KEY, []);
      backup = backups.find(b => b.metadata.id === backupId) || null;
    } else {
      // Create new backup
      backup = await createBackup(true);
    }
    
    if (!backup) {
      throw new Error('No backup available');
    }
    
    const dataStr = JSON.stringify(backup, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const filename = `budget-backup-${getTodayStr()}-${backup.metadata.id.slice(0, 8)}.json`;
    
    downloadBlob(blob, filename);
    showToast('Backup exported successfully', 'success');
    
  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'export_backup'
    });
    
    showToast('Export failed', 'error');
  }
}

/**
 * Import backup from file
 */
export async function importBackup(file: File): Promise<boolean> {
  try {
    const text = await file.text();
    const backup = JSON.parse(text) as BackupData;
    
    // Validate backup structure
    if (!backup.metadata || !backup.data) {
      throw new Error('Invalid backup file');
    }
    
    // Store the backup
    await storeBackupLocally(backup);
    
    showToast('Backup imported successfully', 'success');
    
    // Ask if user wants to restore
    const { asyncConfirm } = await import('../../ui/components/async-modal.js');
    const shouldRestore = await asyncConfirm({
      title: 'Restore Imported Backup',
      message: 'Restore this backup now?',
      details: 'Your imported backup has been saved locally. You can restore it now or keep it stored for later.',
      type: 'warning',
      confirmText: 'Restore Now',
      cancelText: 'Later'
    });
    if (shouldRestore) {
      return await restoreBackup(backup.metadata.id);
    }
    
    return true;
    
  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'import_backup'
    });
    
    showToast('Import failed: Invalid backup file', 'error');
    return false;
  }
}

// ==========================================
// UTILITIES
// ==========================================

/**
 * Get or create device ID
 */
function getOrCreateDeviceId(): string {
  const stored = localStorage.getItem('budget_tracker_device_id');
  if (stored) return stored;
  
  const id = generateId();
  localStorage.setItem('budget_tracker_device_id', id);
  return id;
}

/**
 * Generate checksum for data
 */
async function generateChecksum(data: string): Promise<string> {
  if (crypto.subtle) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  // Fallback to simple checksum
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Compress data using native CompressionStream API (or fallback)
 * FIXED: Implements actual compression instead of placeholder
 */
async function compressData(data: string): Promise<string> {
  // Use native CompressionStream if available (Chrome 80+, Edge 80+, Safari 16.4+)
  if ('CompressionStream' in window) {
    try {
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(data);
      
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(dataBuffer);
      writer.close();
      
      const compressedChunks: Uint8Array[] = [];
      const reader = cs.readable.getReader();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        compressedChunks.push(value);
      }
      
      // Combine chunks
      const totalLength = compressedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const compressed = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of compressedChunks) {
        compressed.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Convert to base64 for storage (chunk to avoid stack overflow on large arrays)
      let binaryStr = '';
      const CHUNK_SIZE = 8192;
      for (let i = 0; i < compressed.length; i += CHUNK_SIZE) {
        const chunk = compressed.subarray(i, i + CHUNK_SIZE);
        binaryStr += String.fromCharCode(...chunk);
      }
      return btoa(binaryStr);
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Compression failed, using original data:', error);
      return data;
    }
  }
  
  // Fallback: Simple LZ-like compression for repeated patterns
  // This provides basic compression for JSON's repeated keys
  const dict = new Map<string, string>();
  let dictIndex = 0;
  let compressed = data;
  
  // Find repeated patterns (minimum 10 chars)
  const patterns = new Map<string, number>();
  for (let i = 0; i < data.length - 10; i++) {
    for (let len = 10; len <= 50 && i + len <= data.length; len++) {
      const pattern = data.substring(i, i + len);
      patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
    }
  }
  
  // Replace most frequent patterns
  const sortedPatterns = Array.from(patterns.entries())
    .filter(([_, count]) => count > 2)
    .sort((a, b) => (b[1] * b[0].length) - (a[1] * a[0].length))
    .slice(0, 100);
  
  for (const [pattern] of sortedPatterns) {
    const placeholder = `§${dictIndex}§`;
    if (placeholder.length < pattern.length) {
      dict.set(placeholder, pattern);
      compressed = compressed.split(pattern).join(placeholder);
      dictIndex++;
    }
  }
  
  // Only return compressed if it's actually smaller
  const compressedWithDict = JSON.stringify({ d: Object.fromEntries(dict), c: compressed });
  return compressedWithDict.length < data.length * 0.9 ? compressedWithDict : data;
}

/**
 * Decompress data
 */
async function decompressData(data: string): Promise<string> {
  // Check if it's base64 compressed (from CompressionStream)
  try {
    if (data.length > 0 && /^[A-Za-z0-9+/=]+$/.test(data)) {
      // Try to decompress using DecompressionStream
      if ('DecompressionStream' in window) {
        const compressed = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(compressed);
        writer.close();
        
        const decompressedChunks: Uint8Array[] = [];
        const reader = ds.readable.getReader();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          decompressedChunks.push(value);
        }
        
        const decoder = new TextDecoder();
        const totalLength = decompressedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of decompressedChunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        return decoder.decode(merged);
      }
    }
  } catch (error) {
    // Not compressed or decompression failed
  }
  
  // Check if it's dictionary compressed
  try {
    const parsed = JSON.parse(data);
    if (parsed.d && parsed.c) {
      let decompressed = parsed.c;
      for (const [placeholder, pattern] of Object.entries(parsed.d)) {
        decompressed = decompressed.split(placeholder).join(pattern as string);
      }
      return decompressed;
    }
  } catch {
    // Not dictionary compressed
  }
  
  // Return as-is if not compressed
  return data;
}

/**
 * Get backup schedule
 */
function getBackupSchedule(): BackupSchedule {
  return lsGet<BackupSchedule>(BACKUP_SCHEDULE_KEY, {
    enabled: false,
    frequency: 'daily',
    time: '02:00',
    retainCount: 7
  });
}

/**
 * Save backup schedule
 */
function saveBackupSchedule(): void {
  lsSet(BACKUP_SCHEDULE_KEY, backupSchedule);
}

/**
 * Get backup status
 */
function getBackupStatus(): BackupStatus {
  return lsGet<BackupStatus>(BACKUP_STATUS_KEY, {
    inProgress: false,
    totalBackups: 0,
    totalSize: 0
  });
}

/**
 * Save backup status
 */
function saveBackupStatus(): void {
  lsSet(BACKUP_STATUS_KEY, backupStatus);
}

/**
 * Get all backups
 */
export function getAllBackups(): BackupData[] {
  return lsGet<BackupData[]>(BACKUP_STORAGE_KEY, []);
}

/**
 * Delete a backup
 */
export function deleteBackup(backupId: string): boolean {
  try {
    const backups = lsGet<BackupData[]>(BACKUP_STORAGE_KEY, []);
    const index = backups.findIndex(b => b.metadata.id === backupId);
    
    if (index === -1) return false;
    
    backups.splice(index, 1);
    lsSet(BACKUP_STORAGE_KEY, backups);
    
    showToast('Backup deleted', 'info');
    return true;
    
  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'delete_backup'
    });
    return false;
  }
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize automatic backup system
 */
export function initializeAutoBackup(): void {
  // Load saved schedule
  backupSchedule = getBackupSchedule();
  backupStatus = getBackupStatus();
  
  // Schedule next backup if enabled
  if (backupSchedule.enabled) {
    scheduleNextBackup();
  }
  
  // Listen for manual backup requests
  window.addEventListener('request-backup', () => {
    createBackup(true);
  });
  
  // Listen for restore requests
  window.addEventListener('restore-backup', ((event: CustomEvent) => {
    if (event.detail?.backupId) {
      restoreBackup(event.detail.backupId);
    }
  }) as EventListener);
}
