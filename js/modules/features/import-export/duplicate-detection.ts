/**
 * Duplicate Detection Service
 * 
 * Secure duplicate detection using exact mathematical precision.
 * Prevents floating-point errors during transaction reconciliation.
 */

import { toCents } from '../../core/utils-pure.js';
import { formatCurrency } from '../../core/locale-service.js';
import type { Transaction } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface DuplicateDetectionResult {
  exact: Transaction[];
  similar: Transaction[];
  unique: Transaction[];
}

export interface DuplicateKey {
  dateKey: string;
  amountCents: number;
  description: string;
  category: string;
  type: string;
}

interface NormalizedTransaction {
  date: string;
  type: string;
  category: string;
  amountCents: number;
  description: string;
  tokens: string[];
}

// ==========================================
// KEY GENERATION
// ==========================================

/**
 * Generate exact duplicate key using mathematical precision
 * Uses integer cents to avoid floating-point precision errors
 */
function getExactKey(transaction: Transaction): string {
  const amountCents = typeof transaction.amount === 'number' 
    ? toCents(transaction.amount)
    : toCents(parseFloat(String(transaction.amount)));

  return [
    transaction.date,
    transaction.type,
    transaction.category,
    amountCents.toString(),
    (transaction.description || '').trim()
  ].join('|');
}

/**
 * Extract the canonical merchant stem used for fuzzy description grouping.
 *
 * Design-Review-Apr21 (new batch, Commit D of 7k): the prior key just
 * truncated the description to its first 20 characters, which collapsed
 * long merchant names sharing a common prefix (e.g. "WHOLE FOODS MARKET
 * #234" and "WHOLE EARTH PROVISIONS") into the same fuzzy bucket and
 * flagged them as potential duplicates even though they are genuinely
 * different vendors.
 *
 * The new approach keeps fuzzy matching intact where it should — same
 * merchant, different per-transaction suffix like an order number —
 * while separating merchants that happen to share a corporate stem:
 *
 *   - Lowercase, collapse whitespace.
 *   - Split on whitespace and strip tokens that are pure digits/symbols
 *     (order numbers, store IDs, transaction references).
 *   - Take the first four meaningful tokens so the vendor name
 *     dominates the key and per-transaction noise drops out.
 *   - Cap the resulting join at 50 chars as a safety ceiling.
 */
function merchantStem(description: string): string {
  const tokens = description
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(t => t.length > 0)
    // A token must contain at least one letter to count — this drops
    // pure-numeric store IDs (#1234, 0987) and pure-symbol tokens.
    .filter(t => /[a-z]/.test(t));

  const meaningful = tokens.slice(0, 4).join(' ');
  return meaningful.slice(0, 50);
}

/**
 * Generate fuzzy duplicate key for loose matching
 * Allows for slight date variations and description differences
 */
function getFuzzyKey(transaction: Transaction): string {
  const amountCents = typeof transaction.amount === 'number'
    ? toCents(transaction.amount)
    : toCents(parseFloat(String(transaction.amount)));

  // Commit D / new batch P3: token-aware merchant stem instead of a
  // raw 20-char prefix so vendors sharing a long prefix don't collide.
  const descriptionKey = merchantStem(transaction.description || '');

  // Group dates by month for fuzzy date matching
  const date = new Date(transaction.date);
  const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

  return [
    monthKey,
    transaction.type,
    transaction.category,
    amountCents.toString(),
    descriptionKey
  ].join('|');
}

function normalizeTransaction(transaction: Transaction): NormalizedTransaction {
  const amountCents = typeof transaction.amount === 'number'
    ? toCents(transaction.amount)
    : toCents(parseFloat(String(transaction.amount)));

  const description = (transaction.description || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

  const tokens = description
    .split(/[^a-z0-9]+/i)
    .map(token => token.trim())
    .filter(token => token.length >= 3);

  return {
    date: transaction.date,
    type: transaction.type,
    category: transaction.category,
    amountCents,
    description,
    tokens
  };
}

/**
 * Generate a lookup key for grouping similar transactions by fuzzy attributes.
 * Used to build fast lookup buckets for O(N+M) duplicate detection.
 * Round 7 fix: Build fuzzy bucket key to avoid O(N*M) nested loops.
 */
function getFuzzyBucketKey(normalized: NormalizedTransaction): string {
  return [
    normalized.date,
    normalized.type,
    normalized.category,
    normalized.amountCents.toString()
  ].join('|');
}

function isSimilarDescription(incoming: NormalizedTransaction, existing: NormalizedTransaction): boolean {
  if (!incoming.description || !existing.description) {
    return false;
  }

  if (incoming.description === existing.description) {
    return true;
  }

  if (incoming.description.includes(existing.description) || existing.description.includes(incoming.description)) {
    return true;
  }

  const existingTokens = new Set(existing.tokens);
  let overlapCount = 0;

  for (const token of incoming.tokens) {
    if (existingTokens.has(token)) {
      overlapCount += 1;
    }
  }

  return overlapCount >= 2;
}

// ==========================================
// DUPLICATE DETECTION
// ==========================================

/**
 * Find duplicate transactions using multiple detection strategies
 * @param incoming - New transactions to check
 * @param existing - Existing transactions to compare against
 * @returns Categorized duplicate results
 *
 * Round 7 fix: O(N+M) fuzzy detection via lookup buckets instead of O(N*M) nested loop.
 * Build a map keyed by fuzzy attributes (date, type, category, amountCents) and only
 * compare incoming transactions against the (typically tiny) bucket of matching candidates.
 */
export function findContentDuplicates(
  incoming: Transaction[],
  existing: Transaction[]
): DuplicateDetectionResult {
  // Create lookup sets for existing transactions
  const exactKeys = new Set(existing.map(getExactKey));

  // Round 7 fix: Build fuzzy lookup buckets to avoid O(N*M) nested loop.
  // Map: fuzzyBucketKey -> array of normalized transactions in that bucket
  const fuzzyBuckets = new Map<string, NormalizedTransaction[]>();

  for (const tx of existing) {
    const normalized = normalizeTransaction(tx);
    const bucketKey = getFuzzyBucketKey(normalized);

    if (!fuzzyBuckets.has(bucketKey)) {
      fuzzyBuckets.set(bucketKey, []);
    }
    fuzzyBuckets.get(bucketKey)!.push(normalized);
  }

  const result: DuplicateDetectionResult = {
    exact: [],
    similar: [],
    unique: []
  };

  for (const transaction of incoming) {
    const exactKey = getExactKey(transaction);

    if (exactKeys.has(exactKey)) {
      result.exact.push(transaction);
      continue;
    }

    const normalizedIncoming = normalizeTransaction(transaction);
    const bucketKey = getFuzzyBucketKey(normalizedIncoming);

    // Round 7 fix: Only compare against the bucket of transactions with matching
    // date/type/category/amount. Most buckets are tiny or empty, reducing comparisons
    // from O(N*M) to O(N+M) on average.
    const candidateBucket = fuzzyBuckets.get(bucketKey) || [];
    const hasSimilarMatch = candidateBucket.some(existingTx =>
      isSimilarDescription(normalizedIncoming, existingTx)
    );

    if (hasSimilarMatch) {
      result.similar.push(transaction);
    } else {
      result.unique.push(transaction);
    }
  }

  return result;
}

/**
 * Find potential duplicates within a single array (self-deduplication)
 * @param transactions - Array of transactions to check for internal duplicates
 * @returns Map of duplicate keys to arrays of matching transactions
 */
export function findInternalDuplicates(transactions: Transaction[]): Map<string, Transaction[]> {
  const keyMap = new Map<string, Transaction[]>();

  for (const transaction of transactions) {
    const key = getExactKey(transaction);
    
    if (!keyMap.has(key)) {
      keyMap.set(key, []);
    }
    keyMap.get(key)!.push(transaction);
  }

  // Only return groups with more than one transaction
  const duplicateGroups = new Map<string, Transaction[]>();
  for (const [key, group] of keyMap.entries()) {
    if (group.length > 1) {
      duplicateGroups.set(key, group);
    }
  }

  return duplicateGroups;
}

/**
 * Advanced fuzzy duplicate detection for imported data cleanup
 * @param transactions - Transactions to analyze
 * @param threshold - Similarity threshold (0-1, default 0.8)
 * @returns Groups of potentially related transactions
 */
export function findFuzzyDuplicates(
  transactions: Transaction[],
  _threshold: number = 0.8
): Map<string, Transaction[]> {
  const fuzzyGroups = new Map<string, Transaction[]>();

  for (const transaction of transactions) {
    const fuzzyKey = getFuzzyKey(transaction);
    
    if (!fuzzyGroups.has(fuzzyKey)) {
      fuzzyGroups.set(fuzzyKey, []);
    }
    fuzzyGroups.get(fuzzyKey)!.push(transaction);
  }

  // Filter to groups that meet similarity threshold
  const similarGroups = new Map<string, Transaction[]>();
  for (const [key, group] of fuzzyGroups.entries()) {
    if (group.length > 1) {
      // Additional similarity scoring could be implemented here
      // For now, use basic grouping
      similarGroups.set(key, group);
    }
  }

  return similarGroups;
}

// ==========================================
// DUPLICATE RESOLUTION
// ==========================================

/**
 * Remove exact duplicates from an array of transactions
 * Keeps the first occurrence of each unique transaction
 */
export function deduplicateExact(transactions: Transaction[]): Transaction[] {
  const seen = new Set<string>();
  const unique: Transaction[] = [];

  for (const transaction of transactions) {
    const key = getExactKey(transaction);
    
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(transaction);
    }
  }

  return unique;
}

/**
 * Create filtered transaction list excluding specified duplicates
 * @param transactions - Source transactions
 * @param duplicates - Transactions to exclude
 * @returns Filtered transaction array
 */
export function excludeDuplicates(
  transactions: Transaction[], 
  duplicates: Transaction[]
): Transaction[] {
  const duplicateKeys = new Set(duplicates.map(getExactKey));
  
  return transactions.filter(tx => {
    const key = getExactKey(tx);
    return !duplicateKeys.has(key);
  });
}

// ==========================================
// STATISTICS AND REPORTING
// ==========================================

/**
 * Generate duplicate detection statistics
 */
export function getDuplicateStats(result: DuplicateDetectionResult) {
  const total = result.exact.length + result.similar.length + result.unique.length;
  
  return {
    total,
    exact: result.exact.length,
    similar: result.similar.length,
    unique: result.unique.length,
    exactPercent: total > 0 ? (result.exact.length / total) * 100 : 0,
    similarPercent: total > 0 ? (result.similar.length / total) * 100 : 0,
    uniquePercent: total > 0 ? (result.unique.length / total) * 100 : 0
  };
}

/**
 * Generate human-readable duplicate summary
 */
export function formatDuplicateSummary(
  result: DuplicateDetectionResult,
  options: { maxSamples?: number } = {}
): string {
  const { maxSamples = 3 } = options;
  const stats = getDuplicateStats(result);
  
  let summary = `Found ${stats.total} transaction(s):\n`;
  summary += `• ${stats.exact} exact duplicate(s)\n`;
  summary += `• ${stats.similar} similar duplicate(s)\n`;
  summary += `• ${stats.unique} unique transaction(s)`;

  if (result.similar.length > 0) {
    summary += '\n\nSimilar transactions (sample):';
    const samples = result.similar.slice(0, maxSamples);
    
    samples.forEach((tx, index) => {
      // Commit D / new batch P3: route through `formatCurrency` so the
      // summary respects the user's locale/currency instead of
      // hardcoding `$` + `.toFixed(2)`. The prior output shipped US
      // formatting into a user-facing duplicate-review surface even
      // when the rest of the app was rendering GBP/EUR/JPY.
      const amountCents = toCents(parseFloat(String(tx.amount)));
      const amount = formatCurrency(amountCents / 100);
      summary += `\n${index + 1}. ${tx.date}: ${tx.category} - ${amount}`;
      if (tx.description) {
        summary += ` (${tx.description.slice(0, 30)}${tx.description.length > 30 ? '…' : ''})`;
      }
    });
    
    if (result.similar.length > maxSamples) {
      summary += `\n...and ${result.similar.length - maxSamples} more`;
    }
  }

  return summary;
}

// ==========================================
// VALIDATION
// ==========================================

// validateTransactionForDuplicateDetection removed - use validator.validateTransaction() instead

export default {
  findContentDuplicates,
  findInternalDuplicates,
  findFuzzyDuplicates,
  deduplicateExact,
  excludeDuplicates,
  getDuplicateStats,
  formatDuplicateSummary
};
