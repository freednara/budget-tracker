/**
 * Savings Goals Interface
 * Defines interfaces and types for savings goals to prevent circular dependencies
 */

// ==========================================
// DATA TYPES
// ==========================================

export interface SavingsGoalData {
  id: string;
  name: string;
  target: number;
  current: number;
  deadline: string;
  category?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  isCompleted: boolean;
  priority?: 'low' | 'medium' | 'high';
}

export interface SavingsContribution {
  id: string;
  goalId: string;
  amount: number;
  date: string;
  note?: string;
}

// ==========================================
// SERVICE INTERFACE
// ==========================================

export interface SavingsGoalsService {
  // Goal management
  getGoals(): SavingsGoalData[];
  getGoalById(id: string): SavingsGoalData | undefined;
  addGoal(goal: Omit<SavingsGoalData, 'id' | 'createdAt' | 'updatedAt'>): Promise<SavingsGoalData>;
  updateGoal(id: string, updates: Partial<SavingsGoalData>): Promise<void>;
  deleteGoal(id: string): Promise<void>;
  
  // Contribution management
  addContribution(goalId: string, amount: number, note?: string): Promise<void>;
  getContributions(goalId: string): SavingsContribution[];
  deleteContribution(contributionId: string): Promise<void>;
  
  // Analytics
  getTotalSaved(): number;
  getTotalTarget(): number;
  getCompletionPercentage(): number;
  getGoalsByPriority(priority: 'low' | 'medium' | 'high'): SavingsGoalData[];
  getUpcomingDeadlines(days: number): SavingsGoalData[];
}

// ==========================================
// EVENT TYPES
// ==========================================

export enum SavingsGoalsEvents {
  // Goal events
  GOAL_ADDED = 'savings:goal:added',
  GOAL_UPDATED = 'savings:goal:updated',
  GOAL_DELETED = 'savings:goal:deleted',
  GOAL_COMPLETED = 'savings:goal:completed',
  
  // Contribution events
  CONTRIBUTION_ADDED = 'savings:contribution:added',
  CONTRIBUTION_DELETED = 'savings:contribution:deleted',
  
  // Analytics events
  PROGRESS_UPDATED = 'savings:progress:updated',
  DEADLINE_APPROACHING = 'savings:deadline:approaching'
}

// ==========================================
// EVENT PAYLOADS
// ==========================================

export interface GoalAddedEvent {
  goal: SavingsGoalData;
}

export interface GoalUpdatedEvent {
  goalId: string;
  updates: Partial<SavingsGoalData>;
  previousData: SavingsGoalData;
}

export interface GoalDeletedEvent {
  goalId: string;
  goal: SavingsGoalData;
}

export interface GoalCompletedEvent {
  goal: SavingsGoalData;
  completionDate: string;
}

export interface ContributionAddedEvent {
  contribution: SavingsContribution;
  goal: SavingsGoalData;
  newTotal: number;
}

export interface ProgressUpdatedEvent {
  totalSaved: number;
  totalTarget: number;
  completionPercentage: number;
  completedGoals: number;
  activeGoals: number;
}

// ==========================================
// CONFIGURATION
// ==========================================

export interface SavingsGoalsConfig {
  enableNotifications: boolean;
  deadlineWarningDays: number;
  autoCompleteOnTarget: boolean;
  allowOverContribution: boolean;
}

export const DEFAULT_SAVINGS_CONFIG: SavingsGoalsConfig = {
  enableNotifications: true,
  deadlineWarningDays: 7,
  autoCompleteOnTarget: true,
  allowOverContribution: false
};