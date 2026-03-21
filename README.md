# Budget Tracker Elite 💰

> Professional-grade personal finance management with uncompromising privacy

[![Version](https://img.shields.io/badge/version-2.6.2-blue.svg)](https://github.com/yourusername/budget-tracker)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-Ready-purple.svg)](https://web.dev/progressive-web-apps/)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/)

## 🌟 Why Budget Tracker Elite?

**Your finances should be yours alone.** Budget Tracker Elite is a privacy-first, local-first financial management tool. No cloud, no tracking, no subscriptions. Just powerful budgeting that respects your privacy.

### Modernization Highlights
- 🟦 **100% TypeScript** - Robust type safety and developer experience
- 🏗️ **Modular Architecture** - Clean, decoupled service-oriented design
- ⚡ **Signal-based Reactivity** - Fine-grained UI updates with Preact Signals
- 🗄️ **Tiered Storage** - IndexedDB with LocalStorage fallback and automatic migration
- 🔄 **Multi-Tab Sync** - Real-time synchronization across browser tabs
- 🚀 **Off-Main-Thread Processing** - Web Workers for heavy computations

## 🚀 Quick Start

### Try It Now

Visit [budgettracker.app](https://budgettracker.app) and click "Install App" - works on any device!

### Self-Host

```bash
# Clone the repository
git clone https://github.com/yourusername/budget-tracker.git

# Navigate to directory
cd budget-tracker

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
budget-tracker/
├── app.ts              # Application entry point & orchestration
├── js/
│   ├── modules/
│   │   ├── core/           # DI, Signals, EventBus, Multi-tab sync, Performance (43 modules)
│   │   ├── data/           # IndexedDB/LocalStorage adapters, Migration, StorageManager (11 modules)
│   │   ├── ui/             # Base UI components and layout management (23 modules)
│   │   ├── features/       # Business logic (Budget, Debt, Savings, etc.) (24 modules)
│   │   ├── components/     # Lit-style UI components (Charts, Modals, etc.) (19 modules)
│   │   ├── orchestration/  # App lifecycle and feature integration (11 modules)
│   │   ├── transactions/   # Transaction system (4 modules)
│   │   └── types/          # TypeScript type definitions (3 modules)
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

## 📊 Core Features

### Financial Management
- **Envelope Budgeting** - Zero-based budgeting with monthly rollovers
- **Transaction Tracking** - Optimized filtering via Web Workers
- **Tiered Data Persistence** - Robust storage with automatic rollback & migration
- **Multi-Tab Sync** - Atomic data updates across tabs using BroadcastChannel & Mutex

### Performance & Reliability
- **Performance Monitoring** - Real-time tracking of app vitals
- **Error Boundaries** - Standardized error handling & circuit breakers
- **Off-Main-Thread Filtering** - Smooth UI even with 10k+ transactions
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

Current test coverage: **>90%** across 170 tests (8 test files).

## 🔒 Security

- **Privacy First**: All data stays on your device.
- **PIN Protection**: PBKDF2-SHA256 with 100k iterations.
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

- **Lighthouse Score**: 92/100
- **Initial Load**: <2 seconds
- **Time to Interactive**: <3 seconds
- **Bundle Size**: <500KB (minified + gzipped)
- **Offline Ready**: 100% functionality

### Scalability
- Handles up to **10,000 transactions** smoothly
- Optimized for **monthly budgets** up to 5 years
- Support for **unlimited categories** and goals

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](docs/CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Code Style

- ES6+ JavaScript
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

- [User Guide](docs/USER_GUIDE.md) - Getting started and tutorials
- [API Reference](docs/API.md) - Module documentation
- [Architecture](docs/ARCHITECTURE.md) - System design
- [Deployment](docs/DEPLOYMENT.md) - Hosting instructions

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

| Feature | Budget Tracker | YNAB | Mint | PocketGuard |
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

- **Documentation**: [docs.budgettracker.app](https://docs.budgettracker.app)
- **Issues**: [GitHub Issues](https://github.com/yourusername/budget-tracker/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/budget-tracker/discussions)
- **Email**: support@budgettracker.app

## 🌟 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=yourusername/budget-tracker&type=Date)](https://star-history.com/#yourusername/budget-tracker&Date)

---

<div align="center">
  <b>Budget without compromise. Privacy without sacrifice.</b>
  <br><br>
  <a href="https://budgettracker.app">Try It Now</a> •
  <a href="https://github.com/yourusername/budget-tracker/issues">Report Bug</a> •
  <a href="https://github.com/yourusername/budget-tracker/discussions">Request Feature</a>
</div>