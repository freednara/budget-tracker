# Review Findings

Last updated: 2026-03-12
Status: In progress

This document tracks confirmed review findings during the current code review. New findings should be appended here as the review continues.

## High Severity

1. CSP blocks inline service worker and update UI code.
   - `index.html:6` sets `script-src 'self'`.
   - `index.html:1436` contains inline service worker/update script.
   - `index.html:1474` injects inline `onclick` handlers.
   - `js/modules/error-handler.js:74` also injects inline `onclick`.
   - Result: service worker registration, update prompts, and some error toast interactions are blocked in browsers that enforce the declared policy.

2. Recurring batch creation dispatches one full transaction-refresh cycle per generated entry.
   - `js/modules/data-manager.js:128-130` emits `TRANSACTION_ADDED` once for every transaction in the batch.
   - `app.js:1281-1294` handles each `TRANSACTION_ADDED` event by rerendering summary cards, transaction list, calendar, charts, alerts, insights, month comparison, recurring breakdown, and backup reminder state.
   - Result: creating a long recurring series can trigger dozens or hundreds of whole-app rerenders in one operation, which is an avoidable performance hit in a common workflow.

3. Recurring transaction creation can report success after a failed batch write.
   - `js/modules/form-events.js:355-362` delegates recurring creation to `createRecurringBatch(...)`, but does not check a success result before continuing.
   - `js/modules/form-events.js:482-489` returns early on `dataSdk.createBatch(batch)` failure, after only resetting the submit button.
   - Control then returns to `js/modules/form-events.js:393-412`, which still resets the form, updates month state, and shows `Recurring transactions added`.
   - Result: a failed recurring-batch save can be presented to the user as a successful create, with the form cleared and no persisted transactions.

4. The progress modal still does not follow the modal visibility contract, so long-running operations run without a visible overlay.
   - `index.html:1453` ships the progress dialog as `class="modal-overlay hidden"`.
   - `js/modules/ui.js:133-149` shows progress by adding `.active`, but it never removes `.hidden`.
   - `style.css:196-197` displays modal overlays via `.modal-overlay.active`, while `style.css:1463` still applies `.hidden { display: none; }`.
   - Result: import/export and recurring-series progress operations can run without a visible progress modal even though the code tries to show one.

5. The current module graph still fails during startup because `import-export-events.js` imports a non-exported symbol.
   - `app.js` imports `js/modules/import-export-events.js` during startup.
   - `js/modules/import-export-events.js:12-19` imports `downloadBlob` from `js/modules/import-export.js`.
   - `js/modules/import-export.js` does not export that symbol; `downloadBlob` is exported by `js/modules/utils.js:216`.
   - A direct module import currently fails with `The requested module './import-export.js' does not provide an export named 'downloadBlob'`.
   - Result: the browser module graph still fails before normal app initialization.

## Medium Severity

6. Loading a saved filter preset bypasses the async/worker transaction path.
   - `js/modules/filter-events.js:56` registers `setFilterChangeCallback(() => renderTransactions(true))`.
   - `js/modules/filters.js:184-202` calls that callback from `applyFilterPreset()`.
   - On large datasets, normal text/filter input uses `renderTransactionsAsync()` in `js/modules/filter-events.js:66-73`, but loading a saved preset always forces the synchronous renderer instead.
   - Result: applying a saved preset can change both filtering behavior and performance compared with the normal large-dataset worker path.

7. Filter presets cannot preserve a current-month-only view and always widen scope to all months.
   - `js/modules/filters.js:165-177` saves preset state without recording the `tx-show-all-months` checkbox.
   - `js/modules/filters.js:198-199` explicitly forces `tx-show-all-months` to `true` every time a preset is applied.
   - `js/modules/transactions.js:282-284` and `js/modules/transactions.js:596-598` use that checkbox to decide whether transaction rendering is limited to `S.currentMonth` or spans all months.
   - Result: saving a preset while viewing only the current month cannot be restored accurately; loading any preset silently broadens the transaction scope across all months.

8. Tests for debt logic are stale and reimplement production logic instead of importing the real module.
   - `tests/debt.test.js` defines local copies of the algorithms and asserts obsolete fields like `totalMonths` and `totalInterestCents`.
   - This allows production integration and contract bugs to ship while the suite stays green.

9. `findCategoryById()` never properly falls through from expense to income lookup.
   - `js/modules/categories.js:137-144` checks `cat.id !== 'Unknown'`.
   - `getCatInfo()` preserves the original input ID even when returning the fallback object.
   - Result: the helper usually returns the first fallback immediately instead of trying the second category set.

10. Worker-based filtering and synchronous filtering do not behave the same.
   - `js/modules/transactions.js:322-335` sync filtering searches description plus category name and applies a dedicated tags filter.
   - `js/workers/filter-worker.js:70-90` worker filtering searches description, notes, tags, and category name, so the worker path matches a broader set of transactions than the sync path for the same search text.
   - `js/modules/filter-events.js:78-118`, `js/modules/filter-events.js:175-205`, and `js/modules/filter-events.js:215-233` route many controls such as type, category, recurring, unreconciled, date presets, sort, and quick-date changes through `renderTransactions()` instead of `renderTransactionsAsync()`.
   - `js/modules/transactions.js:664-675` pagination always routes back through `renderTransactions()` instead of the worker path.
   - Result: search and filter results can change when dataset size or interaction path changes, and large datasets still fall back to main-thread filtering for many common controls.

11. Restarting onboarding stacks duplicate event listeners.
   - `app.js:978-981` exposes a restart control.
   - `js/modules/onboarding.js:254-268` attaches click, backdrop, and keydown handlers on each run.
   - Normal completion does not fully clean up those handlers.
   - Result: subsequent onboarding runs can advance or skip multiple steps per click.

12. PIN setup bypasses the numeric PIN validator.
   - `js/modules/pin-ui-handlers.js:101-116` only checks length.
   - `js/modules/validator.js:154-165` defines the intended `4-6 digits` validation contract.
   - Result: non-numeric values can be accepted through the settings flow.

13. Weekly rollup tooltip calls the category helper with the wrong signature.
   - `js/modules/weekly-rollup.js:303` calls `getCatInfo(cat)`.
   - `js/modules/categories.js:80` expects `getCatInfo(type, id)`.
   - Result: tooltip category breakdown labels can resolve incorrectly.

14. Analytics shortcut path is not fully connected.
   - `app.js:1517-1523` handles `?tab=analytics` by looking for `[data-action="open-analytics"]`.
   - The actual button in `index.html:190` uses `id="open-analytics"`.
   - Manual clicks still work via `js/modules/modal-events.js:341`, but the shortcut/query-param path does not.

15. The debt strategy comparison control is wired up but never made visible.
   - `index.html:509` ships `compare-strategies-btn` with a `hidden` class.
   - `js/modules/debt-ui-handlers.js:206-251` attaches a click handler and renders valid strategy output, but no code path removes that `hidden` class.
   - Result: the compare-strategies feature remains unreachable in the shipped UI even though the underlying modal logic now works.

18. Cross-tab savings contribution updates can leave savings-goal forecasts stale.
   - Adding savings persists `SK.SAVINGS` and then `SK.SAVINGS_CONTRIB` in `js/modules/modal-events.js:271-276`.
   - In another tab, `app.js:1441-1444` handles `SK.SAVINGS` by rerendering goals immediately, but `app.js:1462-1465` handles `SK.SAVINGS_CONTRIB` by updating only the summary.
   - Savings-goal forecasts are computed from contribution history in `js/modules/savings-goals.js:41-68` during `renderSavingsGoals()` at `js/modules/savings-goals.js:97-109`.
   - Result: another tab can show the updated saved amount but keep an out-of-date forecast badge until a later full rerender or reload.

19. Sample-data loading can leave a partial dataset behind on failure.
   - `app.js:975-988` creates sample transactions one by one with `dataSdk.create(...)` inside a loop.
   - If a later write fails, the code shows `Failed after ${count} transactions: storage may be full`, emits `DATA_IMPORTED`, and returns without rolling back the transactions that were already created.
   - Result: a failed sample-data load can leave the app in a partially populated state rather than preserving the pre-load dataset or applying the sample set atomically.

20. Currency, achievements, and streak sync now have handlers, but the transaction-derived achievement state still is not recomputed on import/sync.
   - `app.js:1456-1494` updates currency, achievements, and streak from storage in other tabs.
   - However `app.js:1356-1360` handles `DATA_IMPORTED` with `refreshAll()` and `checkBackupReminder()`, not `checkAchievements()`.
   - Achievement rules depend on imported/current transaction, budget, savings, and streak state in `js/modules/achievements.js:49-89`.
   - Result: importing or syncing data that should newly unlock achievements can leave badges missing unless the imported backup already carried those earned flags or a later user action happens to call `checkAchievements()`.

21. Import builder does not validate non-transaction savings/currency state before persisting it.
   - `js/modules/import-export.js:209-220` restores `savingsContributions` and `currency` directly from backup data.
   - `js/modules/import-export.js:264-274` only normalizes currency if the imported value is already an object.
   - The import flow then assigns the result into live state at `app.js:1704-1717` and `app.js:1778-1790`.
   - Later code assumes valid shapes: `js/modules/calculations.js:70-73` and `js/modules/savings-goals.js:41-52` call `.filter()` on `S.savingsContribs`, while renderers like `js/modules/analytics.js:74-78` read `S.currency.symbol` directly.
   - Result: a malformed backup can persist invalid shapes that break savings calculations/forecasts or corrupt currency rendering after import.

22. Budget alerts are not recomputed when the month or budget changes.
   - `js/modules/alerts.js:19-33` computes alerts from `S.currentMonth` and `S.monthlyAlloc[S.currentMonth]`.
   - The transaction-added path at `app.js:1281-1294` calls `checkAlerts()`, but the month-changed and budget-updated handlers at `app.js:1323-1343` do not.
   - Budget edits in `js/modules/budget-planner-ui.js:160-163` emit `Events.BUDGET_UPDATED`, so this stale path is exercised during normal use.
   - Result: the alert banner can keep showing the wrong month’s warnings or fail to reflect updated budgets until a later full refresh.

23. Deleting a custom category mutates allocations without triggering the budget refresh path.
   - `app.js:2025-2034` removes the category, deletes matching entries from `S.monthlyAlloc`, and persists both keys.
   - That code only rerenders category lists and filters; it does not emit `Events.BUDGET_UPDATED`.
   - The budget refresh path at `app.js:2463-2467` is therefore skipped, even though envelope totals and the budget gauge depend on the changed allocations.
   - Result: budget views can remain stale immediately after deleting a custom category from settings.

24. Category metadata changes do not refresh all category-labeled views.
   - Local custom-category add/delete paths only rerender a narrow subset of the UI: `js/modules/budget-planner-ui.js:177-204` refreshes categories, quick shortcuts, filter options, and the custom-category list, while `app.js:868-884` does the same on delete.
   - Cross-tab category sync is equally narrow: `app.js:1350-1354` handles `CATEGORY_UPDATED` by rerendering categories, the category filter, and the transaction list only.
   - Other live views render category names/emojis from `getCatInfo()` when they draw, including `js/modules/calendar.js:102-107`, `js/modules/chart-renderers.js:152-155`, `js/modules/insights.js:126-127`, and `js/modules/dashboard.js:178-180`.
   - Result: renaming or deleting a custom category can leave stale category names/emojis in charts, insights, calendar, and budget widgets until a later full refresh or reload.

25. Invalid transaction submissions now throw because `form-events.js` calls a missing announcer helper.
   - `js/modules/form-events.js:215-219` shows the validation toast and then calls `announceError(errorMessages.join('. '))`.
   - That module does not import `announceError`, and there is no current implementation exported anywhere in `js/modules/utils.js` or the rest of the module graph.
   - `handleFormSubmit()` wraps validation in a `try/catch` at `js/modules/form-events.js:54-135`, so ordinary invalid submissions now log `ReferenceError: announceError is not defined` after rendering field errors.
   - Result: the visible validation UI partly works, but every normal client-side validation failure still throws through the extracted form module instead of completing cleanly.

26. Recurring-series edit rollback can still leave partial changes behind while claiming everything was reverted.
   - `js/modules/form-events.js:224-241` updates the primary transaction first, then `js/modules/form-events.js:294-307` updates later occurrences one by one.
   - If one later update fails, the rollback path at `js/modules/form-events.js:309-321` tries to restore the primary transaction and previously updated occurrences, but it never checks whether those compensating `dataSdk.update(...)` calls succeed.
   - The code still ends by telling the user `Changes reverted.` even if one of those rollback writes fails due to the same storage or persistence problem that triggered the original error.
   - Result: a partial recurring-series edit can survive a failed rollback while the UI reports that the whole series was restored.

27. Import compatibility warnings are stale against the app's own export version.
   - `js/modules/import-export.js:197-200` only treats `2.3` and `2.5` as compatible.
   - `js/modules/import-export.js:420` exports backups as version `2.6`.
   - Result: importing a current backup logs a misleading compatibility warning.

28. Dismissing the settings modal via backdrop click or `Escape` silently saves changes.
   - `js/modules/modal-events.js:293-317` persists sections, currency, alerts, insight personality, and rollover settings from the `close-settings` button handler.
   - `js/modules/ui.js:271-279` routes settings backdrop clicks through that same `close-settings` button instead of cancelling.
   - `js/modules/keyboard-events.js:58-64` does the same for `Escape` while the settings modal is active.
   - `index.html:1318` labels that control as `Close Settings`, so the UI presents it like a dismiss action rather than an explicit save.
   - Result: users can accidentally persist partial or unintended settings edits just by pressing `Escape` or clicking outside the modal.

29. “Merge with Existing” import can overwrite local array-backed user data instead of preserving or combining it.
   - The merge action is presented as adding imported data to existing data in `index.html:1424` and `js/modules/import-export-events.js:182-184`.
   - But `buildImportState()` restores `savingsContributions`, `filterPresets`, and `txTemplates` through the generic `restoreMap` in `js/modules/import-export.js:210-230`.
   - In merge mode, that logic only deep-merges plain objects; arrays fall through to `newS[prop] = d[src]`, replacing the current local arrays with the backup arrays.
   - Result: a merge import can silently replace local savings contribution history, saved filter presets, and saved transaction templates even though only transactions are described as being merged.

30. Imported filter presets and transaction templates do not rerender into the UI until a later manual action or reload.
   - Backups now include `filterPresets` and `txTemplates` in `js/modules/import-export.js:421-422`, and import restore writes them back through `buildImportState()` in `js/modules/import-export.js:210-230`.
   - The post-import path only emits `DATA_IMPORTED` and runs `refreshAll()` via `js/modules/import-export-events.js:163-173`, `js/modules/import-export-events.js:227-237`, `js/modules/import-export-events.js:252-262`, and `app.js:1356-1360`.
   - `refreshAll()` in `app.js:810-830` does not include `renderFilterPresets()` or `renderTemplates()`, and those lists are otherwise only initialized in `js/modules/filter-events.js:248-249` and `js/modules/filter-events.js:267-268`.
   - Result: after importing a backup, the saved filter preset list and template list can stay stale on screen until the user reloads or performs another action that rerenders them.

31. Applying a recurring template can silently reuse a stale end date from the form.
   - `js/modules/transactions.js:146-157` saves template recurrence state with `recurring` and `recurringType`, but does not store `recurring-end`.
   - `js/modules/transactions.js:197-202` restores those recurrence fields, but never clears or overwrites the existing `recurring-end` input.
   - Result: applying a recurring template can inherit an unrelated old end date that was already sitting in the form, changing the recurrence span without the template explicitly specifying it.

32. Applying a template with no saved amount can silently reuse a stale amount from the form.
   - `js/modules/transactions.js:150-157` allows templates to be saved with `amount: ''`.
   - `js/modules/transactions.js:186-189` only writes the amount field when `tmpl.amount` is truthy; otherwise it leaves the current form value untouched.
   - Result: applying a template that intentionally omits amount can keep a previous amount in the form and lead to accidental mis-entry.

## Low Severity

33. Recurring preview rejects a same-day end date even though submission allows it.
   - `js/modules/transactions.js:936-940` shows `End date must be after start date` when `end <= start`.
   - `js/modules/form-events.js:355-360` only rejects the submit when `recurringEnd < date`, so an end date equal to the start date is accepted and creates a single occurrence.
   - Result: the preview can tell the user their recurring setup is invalid even though the form will successfully submit it.

34. Transaction length-validation messages reference a nonexistent config key.
   - `js/modules/form-events.js:194` and `js/modules/form-events.js:204` build error text with `CONFIG.MAX_TEXT_LENGTH`.
   - The shared config only defines `MAX_DESCRIPTION_LENGTH` and `MAX_NOTES_LENGTH` in `js/modules/config.js:9-13`.
   - Result: when description or notes length validation fails, the user-facing message says `max undefined chars` instead of the actual limit.

35. Deleting a custom category degrades historical transactions to `Unknown`.
   - `app.js:2023-2031` removes the custom category and cleans allocations, but does not migrate or block existing transactions that still reference that category ID.
   - `js/modules/categories.js:80-101` resolves missing categories to a fallback object named `Unknown`.
   - Transaction rendering then displays that fallback label in `js/modules/transactions.js:448-455` and `js/modules/transactions.js:534-540`.
   - The confirmation dialog now warns about this behavior, but the data still is not migrated.
   - Result: historical transactions lose their original category label/emoji after category deletion.

36. Debt type badges render `undefined` instead of the configured emoji.
   - `js/modules/debt-planner.js:41-47` defines debt type display metadata with an `emoji` property.
   - `js/modules/debt-ui-handlers.js:63-68` still reads `typeInfo.icon` when rendering each debt row.
   - Result: known debt types display `undefined` where the leading debt emoji should appear.

37. Saved/imported currency does not update the amount-field prefix on initial load.
   - The amount input prefix in `index.html:571` defaults to `$`.
   - The settings save and import flows now update `currency-display` in `js/modules/modal-events.js:297-300` and `js/modules/import-export-events.js:166-168`, `js/modules/import-export-events.js:230-232`, `js/modules/import-export-events.js:255-257`.
   - Startup still only loads currency into state and the settings dropdown; it does not initialize that DOM element from persisted currency before first render.
   - Result: non-USD users who simply reopen the app can still see a stale `$` prefix until they save settings again or import data.

38. Analytics year-tab markup contains duplicate `class` attributes.
   - `index.html:1332-1334`.
   - Result: malformed initial tab styling until JS rewrites the row.

39. Backup reminder visibility only moves in one direction during normal app use.
   - `js/modules/backup-reminder.js:28-38` shows the banner when the backup age threshold is met and transactions exist, but it never hides the banner when those conditions become false.
   - The normal event flow calls `checkBackupReminder()` on startup, import, and transaction add in `app.js:1293`, `app.js:1359`, and `app.js:1546`, but transaction delete does not reevaluate it and the only explicit hide path is export in `js/modules/import-export-events.js:57` and `js/modules/import-export-events.js:73`.
   - Result: once the banner appears, it can remain visible after the user deletes all transactions or otherwise stops meeting the show conditions.

40. Dismissed budget alerts can suppress unrelated future alerts in the same session.
   - `js/modules/alerts.js:40` filters visible alerts by checking whether their rendered text is present in `dismissedAlerts`.
   - `js/modules/alerts.js:57-60` stores dismissed alerts using only that display string, such as `🍔 Food: 80% spent`.
   - `dismissedAlerts` is session-scoped state in `js/modules/state.js:163`, so it survives month changes until reload.
   - Result: dismissing one month's alert can hide a later month's alert if it renders to the same text.

## Test Coverage Risk

41. The current test suite skews toward copied logic and isolated helpers rather than live browser/module integration.
   - `npm run test:run` passed previously, but the confirmed failures above sit mostly in DOM wiring, storage event handling, CSP compatibility, modal state, and stale module contracts.
   - This suite currently does not provide confidence for those integration paths.
