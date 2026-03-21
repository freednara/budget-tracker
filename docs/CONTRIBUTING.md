# Contributing to Budget Tracker Elite

First off, thank you for considering contributing to Budget Tracker Elite! It's people like you that make Budget Tracker Elite such a great tool for the privacy-conscious finance community.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Process](#development-process)
- [Style Guidelines](#style-guidelines)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Community](#community)

## 📜 Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code:

- **Be Respectful**: Treat everyone with respect. No harassment, discrimination, or inappropriate behavior.
- **Be Constructive**: Provide constructive feedback and be open to receiving it.
- **Be Inclusive**: Welcome newcomers and help them get started.
- **Be Professional**: Keep discussions focused on improving the project.

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and npm 8+
- Git
- A code editor (VS Code recommended)
- Basic knowledge of JavaScript, HTML, and CSS

### Setting Up Your Development Environment

1. **Fork the Repository**
   ```bash
   # Click the 'Fork' button on GitHub, then:
   git clone https://github.com/YOUR_USERNAME/budget-tracker.git
   cd budget-tracker
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Run Development Server**
   ```bash
   npm run dev
   # Open http://localhost:5173
   ```

4. **Run Tests**
   ```bash
   npm test
   ```

5. **Create a Branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```

## 💡 How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues. When you create a bug report, include:

- **Clear Title**: Summarize the issue
- **Description**: What happened vs. what you expected
- **Steps to Reproduce**: List exact steps
- **Environment**: Browser, OS, version
- **Screenshots**: If applicable
- **Console Errors**: Include any error messages

**Template:**
```markdown
## Bug Description
Brief description of the bug

## Steps to Reproduce
1. Go to '...'
2. Click on '....'
3. Scroll to '....'
4. See error

## Expected Behavior
What should happen

## Actual Behavior
What actually happens

## Environment
- Browser: Chrome 120
- OS: Windows 11
- Version: 2.5.0
```

### Suggesting Features

We love feature suggestions! Please:

1. Check if the feature already exists
2. Check if it's already suggested in issues
3. Create a detailed proposal including:
   - Use case and benefits
   - Possible implementation approach
   - Mockups or examples (if applicable)

### Contributing Code

#### Good First Issues

Look for issues labeled `good first issue` or `help wanted`. These are great for newcomers!

#### Areas We Need Help

- **Performance**: Optimizing for 10k+ transactions
- **Accessibility**: WCAG compliance improvements
- **Testing**: Increasing test coverage
- **Documentation**: Tutorials and guides
- **Translations**: i18n support
- **Features**: See our [roadmap](IMPROVEMENT_ROADMAP.md)

## 🔄 Development Process

### 1. Branch Naming

- Features: `feature/description`
- Fixes: `fix/issue-number-description`
- Docs: `docs/description`
- Performance: `perf/description`
- Refactor: `refactor/description`

### 2. Making Changes

1. **Write Tests First** (TDD preferred)
   ```javascript
   // tests/feature.test.js
   describe('New Feature', () => {
     it('should do something', () => {
       // Test implementation
     });
   });
   ```

2. **Implement Feature**
   - Follow existing patterns
   - Keep functions small and focused
   - Add JSDoc comments

3. **Update Documentation**
   - Update README if needed
   - Add inline comments for complex logic
   - Update API docs if applicable

### 3. Testing

- **Unit Tests**: Required for all new functions
- **Integration Tests**: For feature interactions
- **Manual Testing**: Test in multiple browsers
- **Performance**: Ensure no regressions

```bash
# Run all tests
npm test

# Run specific test
npm test -- transactions

# Run with coverage
npm run test:coverage
```

## 🎨 Style Guidelines

### JavaScript

```javascript
// ✅ Good
export function calculateBudget(income, expenses) {
  if (!income || income < 0) {
    throw new Error('Invalid income');
  }
  
  const remaining = income - expenses;
  return {
    income,
    expenses,
    remaining,
    percentage: (expenses / income) * 100
  };
}

// ❌ Bad
export function calc(i,e){
  return i-e;
}
```

### Key Principles

- **ES6+**: Use modern JavaScript features
- **Semicolons Required**: All statements must end with semicolons
- **2 Spaces**: For indentation
- **Single Quotes**: For strings (except template literals)
- **Descriptive Names**: Variables and functions should be self-documenting
- **Pure Functions**: Prefer pure functions without side effects
- **Error Handling**: Always handle errors gracefully

### CSS

```css
/* ✅ Good */
.budget-card {
  display: flex;
  padding: 1rem;
  background: var(--surface);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}

/* ❌ Bad */
.bc { display:flex;padding:16px;background:#fff;border-radius:8px; }
```

### HTML

```html
<!-- ✅ Good -->
<button 
  id="add-transaction"
  class="btn btn-primary"
  aria-label="Add new transaction"
  type="button"
>
  Add Transaction
</button>

<!-- ❌ Bad -->
<button id="btn1" class="btn">Add</button>
```

## 📝 Commit Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

### Format
```
type(scope): description

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```bash
# Feature
feat(transactions): add bulk import functionality

# Bug fix
fix(calendar): resolve date overflow in February

# Documentation
docs(api): update transaction module documentation

# Performance
perf(filter): optimize transaction filtering for large datasets

# Multiple changes
feat(budget): add envelope budgeting system

- Add allocation UI
- Implement rollover logic
- Add visual indicators
- Update tests

Closes #123
```

## 🔀 Pull Request Process

### Before Submitting

1. **Update from main**
   ```bash
   git pull origin main
   git rebase main
   ```

2. **Run tests**
   ```bash
   npm test
   npm run lint
   ```

3. **Check performance**
   - Ensure no regressions
   - Test with 1000+ transactions

4. **Update documentation**
   - Add JSDoc comments
   - Update README if needed

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests pass
- [ ] Manual testing completed
- [ ] No console errors

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings
- [ ] Tests added/updated

## Screenshots (if applicable)
[Add screenshots]

## Related Issues
Fixes #(issue number)
```

### Review Process

1. **Automated Checks**: CI/CD runs tests and linting
2. **Code Review**: Maintainer reviews within 48 hours
3. **Feedback**: Address requested changes
4. **Merge**: Once approved, we'll merge using squash commits

### After Merge

- Delete your branch
- Pull the latest main
- Celebrate! 🎉

## 🧪 Testing Guidelines

### Test Structure

```javascript
describe('Module Name', () => {
  describe('functionName', () => {
    it('should handle normal cases', () => {
      // Arrange
      const input = { amount: 100 };
      
      // Act
      const result = functionName(input);
      
      // Assert
      expect(result).toBe(100);
    });

    it('should handle edge cases', () => {
      // Test boundaries, nulls, errors
    });
  });
});
```

### Coverage Requirements

- New code: Minimum 80% coverage
- Critical paths: 100% coverage
- UI components: Snapshot tests

## 🛡️ Security

### Reporting Security Issues

**DO NOT** open a public issue for security vulnerabilities. Instead:

1. Email: security@budgettracker.app
2. Include: Description, steps to reproduce, impact
3. Wait for response (within 48 hours)

### Security Guidelines

- Never commit secrets or API keys
- Sanitize all user inputs
- Use HTTPS everywhere
- Follow OWASP best practices
- Hash sensitive data (like PINs)

## 📚 Resources

### Documentation

- [Architecture Guide](ARCHITECTURE.md)
- [API Reference](API.md)
- [Testing Guide](TESTING.md)
- [Deployment Guide](DEPLOYMENT.md)

### Learning Resources

- [MDN Web Docs](https://developer.mozilla.org/)
- [JavaScript Info](https://javascript.info/)
- [Web.dev PWA Guide](https://web.dev/progressive-web-apps/)
- [WCAG Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)

### Tools

- [VS Code](https://code.visualstudio.com/) - Recommended editor
- [Chrome DevTools](https://developer.chrome.com/docs/devtools/) - Debugging
- [Lighthouse](https://developers.google.com/web/tools/lighthouse) - Performance
- [Wave](https://wave.webaim.org/) - Accessibility testing

## 🤝 Community

### Communication Channels

- **GitHub Discussions**: Questions and ideas
- **Discord**: Real-time chat (coming soon)
- **Twitter**: [@budgettracker](https://twitter.com/budgettracker)
- **Blog**: [blog.budgettracker.app](https://blog.budgettracker.app)

### Recognition

We recognize contributors in our:
- README.md contributors section
- Release notes
- Annual contributor spotlight

## ❓ FAQ

**Q: I'm new to open source. Can I still contribute?**
A: Absolutely! Look for `good first issue` labels and don't hesitate to ask questions.

**Q: What if I break something?**
A: That's what tests and code review are for! We'll help you fix any issues.

**Q: How long until my PR is reviewed?**
A: We aim to review within 48 hours, usually faster.

**Q: Can I work on multiple issues?**
A: Yes, but please communicate to avoid duplicate work.

**Q: Do I need to sign a CLA?**
A: No, we don't require a CLA for contributions.

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

## 🙏 Thank You!

Every contribution helps make Budget Tracker Elite better for everyone. Whether it's fixing a typo, adding a feature, or improving documentation, we appreciate your help!

**Happy Coding!** 🚀

---

*Questions?* Open a [discussion](https://github.com/yourusername/budget-tracker/discussions) or reach out on [Discord](#).

*Last Updated: March 11, 2026*