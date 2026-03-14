/**
 * Sample Data Module
 * Generates realistic sample transactions for testing analytics
 *
 * @module sample-data
 */
'use strict';

import { dataSdk } from './data/data-manager.js';
import { emit, Events } from './core/event-bus.js';
import { showToast } from './ui/core/ui.js';
import type { TransactionType } from '../types/index.js';

// ==========================================
// TYPES
// ==========================================

interface SampleTransaction {
  type: TransactionType;
  category: string;
  amount: number;
  description: string;
  date: string;
}

interface ExpenseTemplate {
  min: number;
  max: number;
  descs: string[];
}

// ==========================================
// TEMPLATES
// ==========================================

const expenseTemplates: Record<string, ExpenseTemplate> = {
  food: { min: 15, max: 200, descs: ['Grocery shopping', 'Restaurant dinner', 'Coffee shop', 'Takeout', 'Farmers market', 'Lunch'] },
  transport: { min: 20, max: 150, descs: ['Gas station', 'Bus pass', 'Uber ride', 'Car maintenance', 'Parking', 'Train ticket'] },
  shopping: { min: 25, max: 300, descs: ['Amazon order', 'New clothes', 'Electronics', 'Home goods', 'Gift purchase', 'Online shopping'] },
  bills: { min: 50, max: 250, descs: ['Electric bill', 'Internet bill', 'Phone bill', 'Water bill', 'Insurance', 'Subscription'] },
  entertainment: { min: 10, max: 100, descs: ['Netflix', 'Movie tickets', 'Concert', 'Spotify', 'Video game', 'Books'] },
  health: { min: 20, max: 200, descs: ['Pharmacy', 'Doctor visit', 'Gym membership', 'Vitamins', 'Dental checkup', 'Eye care'] },
  education: { min: 15, max: 150, descs: ['Online course', 'Books', 'Workshop', 'Software subscription', 'Certification', 'Tutorial'] },
  other: { min: 10, max: 100, descs: ['Miscellaneous', 'Pet supplies', 'Donation', 'Fees', 'Repairs', 'Services'] }
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Get seasonal spending multiplier based on month
 * @param month - Month number (1-12)
 * @returns Multiplier for spending amounts
 */
function seasonalMultiplier(month: number): number {
  if (month === 12) return 1.5;  // December: holiday spending
  if (month === 11) return 1.3;  // November: Black Friday
  if (month === 1) return 0.75;  // January: post-holiday recovery
  if (month === 2) return 0.85;  // February: still recovering
  if (month >= 6 && month <= 8) return 1.15; // Summer: vacations
  return 1.0;
}

// ==========================================
// MAIN EXPORT
// ==========================================

/**
 * Load sample transactions for testing analytics
 * Generates ~500 transactions spanning 24 months with realistic patterns
 */
export function loadSampleData(): void {
  if (!confirm('Load sample data? This will add ~500 transactions spanning 24 months for testing analytics.')) return;

  const today = new Date();
  const samples: SampleTransaction[] = [];
  const categories = Object.keys(expenseTemplates);

  // Generate 24 months of data
  for (let monthsAgo = 23; monthsAgo >= 0; monthsAgo--) {
    const d = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const mk = `${year}-${String(month).padStart(2, '0')}`;
    const daysInMonth = new Date(year, month, 0).getDate();
    const multiplier = seasonalMultiplier(month);

    // Monthly salary (with occasional variation)
    const salaryVariation = Math.random() > 0.85 ? (Math.random() * 1000 + 500) : 0;
    samples.push({
      type: 'income', category: 'salary',
      amount: Math.round((5000 + salaryVariation) * 100) / 100,
      description: salaryVariation > 0 ? 'Monthly Salary + Bonus' : 'Monthly Salary',
      date: `${mk}-01`
    });

    // Occasional freelance income
    if (Math.random() > 0.7) {
      samples.push({
        type: 'income', category: 'freelance',
        amount: Math.round((Math.random() * 800 + 200) * 100) / 100,
        description: 'Freelance project',
        date: `${mk}-${String(Math.floor(Math.random() * daysInMonth) + 1).padStart(2, '0')}`
      });
    }

    // Generate 12-20 expenses per month
    const numExpenses = Math.floor(Math.random() * 9) + 12;
    for (let i = 0; i < numExpenses; i++) {
      const cat = categories[Math.floor(Math.random() * categories.length)];
      const template = expenseTemplates[cat];
      const baseAmount = Math.random() * (template.max - template.min) + template.min;
      const amount = Math.round(baseAmount * multiplier * 100) / 100;
      const day = Math.floor(Math.random() * daysInMonth) + 1;
      const desc = template.descs[Math.floor(Math.random() * template.descs.length)];

      samples.push({
        type: 'expense', category: cat, amount,
        description: desc,
        date: `${mk}-${String(day).padStart(2, '0')}`
      });
    }
  }

  // Shuffle to simulate realistic entry order
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }

  // Use atomic batch write for sample data
  (async () => {
    const result = await dataSdk.createBatch(
      samples.map(s => ({
        ...s,
        tags: '',
        notes: '',
        currency: '',
        recurring: false
      }))
    );

    if (!result.isOk) {
      showToast('Failed to load sample data: storage may be full', 'error');
      return;
    }

    emit(Events.DATA_IMPORTED);
    showToast(`Loaded ${samples.length} sample transactions across 24 months!`, 'success');
  })();
}
