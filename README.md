# Harbor Ledger 💰

> Professional-grade personal finance management with uncompromising privacy

[![Version](https://img.shields.io/badge/version-2.6.2-blue.svg)](https://github.com/FrankReed/harbor-ledger)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-Ready-purple.svg)](https://web.dev/progressive-web-apps/)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/)

## 🌟 Why Harbor Ledger?

**Your finances should be yours alone.** Harbor Ledger is a privacy-first, local-first financial management tool. No cloud, no tracking, no subscriptions. Just powerful budgeting that respects your privacy.

### Modernization Highlights
- 🟦 **100% TypeScript** - Robust type safety and developer experience
- 🏗️ **Modular Architecture** - Clean, decoupled service-oriented design
- ⚡ **Signal-based Reactivity** - Fine-grained UI updates with Preact Signals
- 🗄️ **Tiered Storage** - IndexedDB with LocalStorage fallback and automatic migration
- 🔄 **Multi-Tab Sync** - Real-time synchronization across browser tabs
- 🚀 **Off-Main-Thread Processing** - Web Workers for heavy computations

## 🚀 Quick Start

### Try It Now

Visit [harborledger.app](https://harborledger.app) and click "Install App" - works on any device!

### Self-Host

```bash
# Clone the repository
git clone https://github.com/FrankReed/harbor-ledger.git

# Navigate to directory
cd harbor-ledger

# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```

## 🏗️ Architecture

The project has been refactored from a monolithic `app.js` into a modern, modular structure under `js/modules/`, coordinated by a lazy-loading Dependency Injection (DI) container.

```
harbor-ledger/
├── app.ts              # Application entry point & orchestration
├── js/
│   ├── modules/
│   │   ├── core/           # DI, Signals, EventBus, Multi-tab sync, Performance (49 modules)
│   │   ├── data/           # IndexedDB/LocalStorage adapters, Migration, StorageManager (11 modules)
│   │   ├── ui/             # Base UI components and layout management (23 modules)
│   │   ├── features/       # Business logic (Budget, Debt, Savings, etc.) (29 modules)
│   │   ├── components/     # Lit-style UI components (Charts, Modals, etc.) (24 modules)
│   │   ├── orchestration/  # App lifecycle and feature integration (11 modules)
│   │   ├── transactions/   # Transaction system (4 modules)
│   │   └── types/          # TypeScript type definitions (1 module)
│   └── workers/        # Off-main-thread workers (filter-worker-optimized.ts)
└── tests/              # Comprehensive Vitest & Playwright suite
```

### Tech Stack

- **Language**: TypeScript (100%)
- **Reactivity**: Preact Signals
- **Rendering**: lit-html for efficient DOM updates
- **Storage**: IndexedDB (Primary) + LocalStorage (Fallback)
- **Build**: Vite 7+
- **Testing**: Vitest (Unit/Integration) + Playwright (E2E)
- **Architecture**: Modular DI-driven design

### Enforced Internal Contracts

- State mutations default through [`js/modules/core/state-actions.ts`](js/modules/core/state-actions.ts), with only a small test-enforced low-level direct-writer allowlist.
- The transactions ledger surface rerenders through [`js/modules/data/transaction-surface-coordinator.ts`](js/modules/data/transaction-surface-coordinator.ts), not ad hoc renderer imports across the app.
- Core/data layer UI bridges are limited to a documented allowlist and pinned by an architecture contract test.

## 📊 Core Features

### Financial Management
- **Envelope Budgeting** - Zero-based budgeting with monthly rollovers
- **Transaction Tracking** - Optimized filtering via Web Workers
- **Tiered Data Persistence** - IndexedDB-first transaction durability with localStorage fallback for compatibility state
- **Multi-Tab Sync** - Atomic data updates across tabs using BroadcastChannel & Mutex
- **Import / Restore Safety** - Import, restore, and backup recovery route transaction replacement through the same durable data path used by the app

### Performance & Reliability
- **Performance Monitoring** - Real-time tracking of app vitals
- **Error Boundaries** - Standardized error handling & circuit breakers
- **Off-Main-Thread Filtering** - Web Worker support for heavier transaction filtering workloads
- **Lazy Loading** - Services are initialized only when needed via DI

## 🧪 Testing

```bash
# Run unit & integration tests (Vitest)
npm test

# Run E2E tests (Playwright)
npm run test:e2e

# Run with coverage
npm run test:coverage
```

The repository includes both Vitest unit/integration coverage and Playwright end-to-end coverage. Run the commands above to measure the current suite in your environment.

Current enforced guards focus on:
- durable import / restore behavior
- cold-start shell interaction readiness for modal-backed controls
- required browser perf baselines for shell-ready, transactions surface, edit, calendar selection, and dashboard refresh
- architecture contract checks for transaction-surface ownership, approved direct signal writers, and `.js` import consistency

Advisory-only checks:
- larger 1k/5k/10k benchmark runs
- debug telemetry and local investigation tooling

## 🔒 Security

- **Privacy First**: All data stays on your device.
- **PIN Protection**: PBKDF2-SHA256 with 600k iterations.
- **XSS Prevention**: Standardized sanitization and safe DOM operations.
- **Data Atomicity**: Mutex-protected storage operations for multi-tab safety.

### Compliance
- ✅ GDPR Compliant (no data collection)
- ✅ CCPA Compliant (local storage only)
- ✅ WCAG 2.1 AA (with minor fixes needed)
- ✅ COPPA Compliant (no data from minors)

## 🌍 Browser Support

| Browser | Version | Support |
|---------|---------|---------|
| Chrome | 90+ | ✅ Full |
| Firefox | 88+ | ✅ Full |
| Safari | 14+ | ✅ Full |
| Edge | 90+ | ✅ Full |
| Mobile Safari | 14+ | ✅ Full |
| Chrome Android | 90+ | ✅ Full |

## 📈 Performance

- Performance characteristics depend on dataset size, browser, and device class.
- Use debug diagnostics for local investigation, not as a release gate.
- The required browser perf regression check covers shell-ready, transactions-surface readiness, transaction edit, calendar selection, and dashboard chart refresh.
- Larger 1k/5k/10k benchmark runs remain advisory local benchmarks for scale testing.
- Set `PW_PERF_PROFILE=1` to run Playwright against a production-like build instead of the Vite dev server when benchmarking.
- Offline-ready PWA behavior is supported by the service worker build.

### Scalability
- IndexedDB-backed storage keeps larger ledgers usable, but benchmark on target devices instead of relying on a fixed transaction ceiling.
- Optimized for long-running monthly budgeting history and local-first use.
- Support for flexible category and goal counts within browser storage limits.

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](docs/CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Code Style

- TypeScript (strict)
- Prettier formatting
- ESLint rules enforced
- Comprehensive JSDoc comments

## 💰 Pricing

### Open Source (Free)
- Full source code
- Self-host anywhere
- Community support
- MIT License

### Hosted Version ($4.99/month)
- Managed hosting
- Automatic backups
- Priority support
- Cloud sync (coming soon)

### Lifetime License ($99)
- One-time payment
- All future updates
- Premium support
- Early access features

## 📚 Documentation

- [Project Summary](docs/PROJECT_SUMMARY.md) - Overview and feature summary
- [Technical Review](docs/TECHNICAL_REVIEW.md) - Architecture and code quality analysis
- [Feature Inventory](docs/FEATURE_INVENTORY.md) - Complete feature listing
- [DI Migration Guide](docs/DI_MIGRATION_GUIDE.md) - Dependency injection patterns
- [Contributing](docs/CONTRIBUTING.md) - How to contribute
- [Improvement Roadmap](docs/IMPROVEMENT_ROADMAP.md) - Planned enhancements
- [Launch Checklist](docs/LAUNCH_CHECKLIST.md) - Pre-launch verification steps

## 🗺️ Roadmap

### Version 3.0 (Future)
- [ ] Cloud sync with end-to-end encryption
- [ ] Bank integration via Plaid
- [ ] Mobile apps (iOS/Android)
- [ ] Collaborative budgeting

### Version 4.0 (Q4 2026)
- [ ] AI financial advisor
- [ ] Voice commands
- [ ] Receipt scanning with OCR
- [ ] Investment tracking

See the [full roadmap](docs/IMPROVEMENT_ROADMAP.md) for detailed plans.

## 📊 Comparison

| Feature | Harbor Ledger | YNAB | Mint | PocketGuard |
|---------|---------------|------|------|-------------|
| Price | Free/$4.99 | $14.99/mo | Free (ads) | $7.99/mo |
| Privacy First | ✅ | ❌ | ❌ | ❌ |
| Offline Mode | ✅ | ⚠️ | ❌ | ❌ |
| No Ads | ✅ | ✅ | ❌ | ✅ |
| Bank Sync | 🔜 | ✅ | ✅ | ✅ |
| Envelope Budgeting | ✅ | ✅ | ❌ | ❌ |
| Debt Planning | ✅ | ⚠️ | ⚠️ | ❌ |
| Open Source | ✅ | ❌ | ❌ | ❌ |

## 🙏 Acknowledgments

- Icons by [Emoji](https://unicode.org/emoji/)
- Inspiration from YNAB, Mint, and the personal finance community
- Built with ❤️ for privacy-conscious budgeters

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 💬 Support

- **Documentation**: [docs.harborledger.app](https://docs.harborledger.app)
- **Issues**: [GitHub Issues](https://github.com/FrankReed/harbor-ledger/issues)
- **Discussions**: [GitHub Discussions](https://github.com/FrankReed/harbor-ledger/discussions)
- **Email**: support@harborledger.app

## 🌟 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=FrankReed/harbor-ledger&type=Date)](https://star-history.com/#FrankReed/harbor-ledger&Date)

---

<div align="center">
  <b>Budget without compromise. Privacy without sacrifice.</b>
  <br><br>
  <a href="https://harborledger.app">Try It Now</a> •
  <a href="https://github.com/FrankReed/harbor-ledger/issues">Report Bug</a> •
  <a href="https://github.com/FrankReed/harbor-ledger/discussions">Request Feature</a>
</div>
