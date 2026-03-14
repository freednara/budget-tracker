# Budget Tracker Elite - Module Structure

## Overview

This directory contains ES6 modules for Budget Tracker Elite, extracted from the monolithic `app.js` file to improve maintainability, testability, and code organization.

## Current Status

**Phase**: Feature Modules (Phase 3)
**Modules Created**: 8/12
**Main App Status**: app.js now imports from modules (ES6 module integration complete)

## Module Architecture

### Completed Modules ✅

#### `utils.js` (~200 lines)
Core utility functions for the application:
- **Currency Formatting**: `fmtCur()`, `CURRENCY_MAP`
- **Date Helpers**: `parseLocalDate()`, `getMonthKey()`, `getTodayStr()`, `formatDateForInput()`
- **Array Operations**: `sumByType()`
- **DOM Helpers**: `downloadBlob()`, `esc()`
- **Math Utilities**: `calcPercentage()`, `clamp()`
- **General Utilities**: `debounce()`, `generateId()`

#### `state.js` (~130 lines) ✅
Application state management and localStorage operations:
- **State Object**: Central `S` object with all app state
- **Storage Keys**: `SK` constants
- **Persistence**: `lsGet()`, `lsSet()`, `persist()`
- **Session State**: `dismissedAlerts` set
- **Storage Helpers**: Error handling for quota exceeded

#### `categories.js` (~160 lines) ✅
Category definitions and helpers:
- **Constants**: `EXPENSE_CATS`, `INCOME_CATS`, `EMOJI_PICKER_CATEGORIES`
- **Category Helpers**: `getAllCats()`, `getCatInfo()`, `findCategoryById()`
- **Custom Categories**: Custom category management
- **Subcategories**: Hierarchical category support with parent detection

#### `data-manager.js` (~115 lines) ✅
Data SDK and transaction management:
- **DataManager Class**: Core data operations
- **CRUD Operations**: Create, read, update, delete transactions
- **Batch Operations**: createBatch for bulk imports
- **dataSdk**: Default instance for app-wide use

#### `ui.js` (~220 lines) ✅
Core UI components and helpers:
- **Toast Notifications**: `showToast()` with success/error/info types
- **Progress Modal**: `showProgress()`, `updateProgress()`, `hideProgress()`
- **Modal Management**: `openModal()`, `closeModal()` with focus trap
- **Configuration**: `setTimingConfig()`, `setSwipeManager()`

#### `swipe-manager.js` (~185 lines) ✅

Touch gesture handling for mobile:
- **Swipe Detection**: Touch event handling with velocity tracking
- **Swipe Actions**: Reveal action buttons on swipe left
- **Swipe State**: Active swipe tracking and management
- **Swipe Animations**: Spring-back transitions with configurable thresholds
- **Configuration**: `setSwipeConfig()` for threshold customization

#### `theme.js` (~85 lines) ✅

Theme management and persistence:

- **Theme Switching**: `setTheme()` for dark/light/system modes
- **System Detection**: `getSystemTheme()` detects OS preference
- **Auto-sync**: Listens for system theme changes in 'system' mode
- **Initialization**: `initTheme()` loads saved preference
- **State Integration**: `setThemeState()` connects to app state

#### `onboarding.js` (~250 lines) ✅

First-time user tour experience:

- **Tour Steps**: `ONBOARDING_STEPS` configurable tour content
- **Tour Control**: `startOnboarding()` initiates the guided tour
- **Spotlight System**: Highlights target elements with positioning
- **Progress Tracking**: Saves/resumes tour progress via localStorage
- **Tab Integration**: `setOnboardingCallbacks()` for tab switching

### Planned Modules 📋

#### `transactions.js` (~400 lines)
Transaction CRUD operations and rendering:
- **Transaction List**: `renderTransactions()`, pagination
- **Transaction Form**: Form handling, validation
- **Transaction Operations**: Add, edit, delete, split
- **Filtering**: Advanced filter logic
- **Sorting**: Multiple sort options

#### `filters.js` (~250 lines)
Transaction filtering and search:
- **Filter State**: Filter configuration management
- **Filter Application**: Apply multiple filters
- **Search**: Text search across transactions
- **Date Ranges**: Date range presets
- **Filter UI**: Filter badge, active count

#### `budget.js` (~350 lines)
Budget planning and envelope system:
- **Budget Allocation**: Envelope budgeting
- **Budget Planning**: Monthly budget setup
- **Budget Tracking**: Spending vs budget
- **Budget Insights**: Over/under budget categories
- **Budget Health**: Overall budget status

#### `recurring.js` (~200 lines)
Recurring transaction management:
- **Recurring Setup**: Schedule configuration
- **Recurring Processing**: Auto-generation logic
- **Recurring Bills**: Bill tracking and reminders
- **Recurring Calendar**: Upcoming bills view

#### `analytics.js` (~500 lines)
Charts, insights, and data visualization:
- **Dashboard Charts**: Spending by category, trends over time
- **Insights Engine**: AI-powered spending insights
- **Calendar Heatmap**: Transaction density visualization
- **Trend Analysis**: Spending patterns and forecasts
- **Achievements**: Badge system

#### `ui.js` (~300 lines)
UI helpers and theme management:
- **Modal System**: `openModal()`, `closeModal()`
- **Toast Notifications**: `showToast()`
- **Theme System**: Light/dark mode, theme switching
- **Empty States**: No data placeholders
- **Loading States**: Loading indicators

#### `calendar.js` (~400 lines)
Calendar heatmap implementation:
- **Calendar Rendering**: Month view with transactions
- **Heatmap Colors**: Spending intensity visualization
- **Calendar Navigation**: Month switching
- **Calendar Interactions**: Click handlers, tooltips

## Migration Strategy

### Phase 1: Foundation ✅
- [x] Create module directory structure
- [x] Extract utils.js as proof of concept
- [x] Document module architecture

### Phase 2: Core Modules ✅
- [x] Extract state.js (localStorage + state management)
- [x] Extract categories.js (category definitions)
- [x] Update app.js to import from these modules
- [x] Update index.html to load app.js as ES6 module
- [ ] Test that app still works (Next step)

### Phase 3: Feature Modules
- [ ] Extract transactions.js
- [ ] Extract budget.js
- [ ] Extract analytics.js
- [x] Extract ui.js ✅

### Phase 4: Specialized Modules
- [ ] Extract filters.js
- [ ] Extract recurring.js
- [ ] Extract calendar.js
- [x] Extract onboarding.js ✅
- [x] Extract swipe-manager.js ✅

### Phase 5: Integration
- [ ] Create main.js entry point
- [ ] Update index.html to use `<script type="module" src="js/main.js">`
- [ ] Remove or archive original app.js
- [ ] Comprehensive testing

### Phase 6: Optimization
- [ ] Tree-shaking analysis
- [ ] Bundle size optimization
- [ ] Performance testing
- [ ] Browser compatibility testing

## Benefits of Modularization

### Development Experience
- **Easier Navigation**: Find code by feature, not line number
- **Better IntelliSense**: Modern editors provide better autocomplete
- **Clearer Dependencies**: Explicit imports show what depends on what
- **Easier Testing**: Test modules in isolation

### Performance
- **Faster Parsing**: Browsers parse smaller files faster
- **Better Caching**: Modules cached independently
- **Code Splitting**: Potential for lazy loading features
- **Tree Shaking**: Remove unused code in production

### Maintainability
- **Separation of Concerns**: Each module has single responsibility
- **Easier Refactoring**: Changes isolated to relevant module
- **Clearer Architecture**: Module structure documents design
- **Team Collaboration**: Multiple devs can work on different modules

## Import/Export Patterns

### Named Exports (Preferred)
```javascript
// utils.js
export function fmtCur(amount) { ... }
export function parseLocalDate(str) { ... }

// main.js
import { fmtCur, parseLocalDate } from './modules/utils.js';
```

### Default Exports (For Classes/Objects)
```javascript
// data-manager.js
export default class DataManager { ... }

// main.js
import DataManager from './modules/data-manager.js';
```

### Re-exports (For Aggregation)
```javascript
// index.js (barrel file)
export * from './utils.js';
export * from './state.js';
export * from './categories.js';
```

## Testing Strategy

Each module should be testable in isolation:

```javascript
// utils.test.js (example)
import { fmtCur, parseLocalDate } from '../modules/utils.js';

describe('fmtCur', () => {
  test('formats USD correctly', () => {
    expect(fmtCur(100, 'USD', mockState)).toBe('$100.00');
  });
});
```

## Browser Compatibility

ES6 modules are supported in:
- Chrome 61+
- Firefox 60+
- Safari 11+
- Edge 16+

For older browsers, consider using a bundler (Vite, Rollup) to transpile modules.

## Next Steps

1. **Extract transactions.js**: Move transaction rendering and list management
2. **Extract filters.js**: Move filtering logic and search functionality
3. **Extract budget.js**: Move budget planning and envelope system
4. **Extract analytics.js**: Move charts, insights, and visualization
5. **Extract remaining modules**: calendar.js, recurring.js, onboarding.js
6. **Test thoroughly**: Ensure no regressions after each extraction

## Notes

- Keep the original app.js as backup until full migration is complete
- Test after each module extraction
- Use feature flags for gradual rollout if needed
- Monitor bundle size and performance metrics
- Consider using a build tool (Vite) for production optimization
