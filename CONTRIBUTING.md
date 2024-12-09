# Contributing to Gerolamo

First off, thanks for your interest in contributing to Gerolamo! This is an open-source implementation of the Cardano Node in TypeScript, and having more hands on deck helps us move faster, improve quality, and make the project more accessible. Whether you’re new to Cardano, TypeScript, or open-source in general, we’re happy to have you.

## Table of Contents
- [Setting Up Your Environment](#setting-up-your-environment)
- [How We Work](#how-we-work)
- [Code Style & Standards](#code-style--standards)
- [Pull Requests](#pull-requests)
- [Issues & Roadmap](#issues--roadmap)
- [Communication](#communication)
- [Code of Conduct](#code-of-conduct)
- [License](#license)

## Setting Up Your Environment

1. **Clone the Repo:**  
   ```bash
   git clone https://github.com/HarmonicLabs/gerolamo.git
   cd gerolamo
   ```

2. **Install Dependencies:**  
   We use Node.js and npm. Make sure you have Node.js (LTS recommended) installed, then run:  
   ```bash
   npm install
   ```

3. **Run the Project:**  
   Check the README for instructions on running the node. Typically:  
   ```bash
   npm run build
   npm run start
   ```

4. **Explore the Docs:**  
   See the `docs/` folder (if available) or the wiki for internal architecture, design decisions, and additional setup notes.

## How We Work

- **Asynchronous First:**  
  We prefer async communication over scheduled meetings. This means fewer stand-ups and more updates via issues, PR comments, and chat messages. Contribute at your own pace—no pressure.

- **Incremental Improvements:**  
  Start small. Maybe tackle a simple issue or add a test. As you get comfortable, feel free to dive into bigger tasks.

## Code Style & Standards

- **TypeScript & Linting:**  
  We rely on ESLint and Prettier to keep the code consistent. Run `npm run lint` before submitting a PR.  
  Please use TypeScript features (types, interfaces, generics) whenever possible to keep the codebase robust.

- **Testing:**  
  If you’re adding a new feature or fixing a bug, add or update tests. This helps ensure we don’t break something unintentionally. We use [Jest](https://jestjs.io/) (or another testing framework if specified in the repo), so check the `tests/` directory for examples.

## Pull Requests

- **Branching:**  
  Create a feature branch from `main` to keep the commit history clean.

- **Commit Messages:**  
  Write clear, concise commit messages. Something like:  
  ```
  Add support for X in the ledger state
  ```
  Avoid vague messages like “Fix stuff” or “Changes.”

- **Small, Focused Changes:**  
  Try to keep your PRs scoped and easy to review. If you find yourself adding multiple unrelated changes, consider splitting them into separate PRs.

- **Reviews & Feedback:**  
  We do code reviews to maintain quality and share knowledge. Don’t worry if we ask questions or request changes—it’s all part of making the code stronger.

## Issues & Roadmap

- **Issue Tracking:**  
  We use GitHub Issues to track bugs, features, and tasks. If you see something you want to work on, feel free to comment on the issue to let others know you’re on it.

- **Good First Issues:**  
  Look for issues labeled “good first issue” if you’re just getting started. These are simpler tasks that are ideal for newcomers.

- **Roadmap:**  
  Check out our roadmap file or GitHub Projects board (if we have one) to see what’s planned. This can give you a sense of what’s coming next and where you might contribute.

## Communication

Consider opening an issue or propose a pull request if you:
- Found a bug
- Want to propose a new feature
- Think something can be improved

For everything else consider using the [Cardano stack exchange](https://cardano.stackexchange.com/) using the `gerolamo` tag alongside other tags relevant to your question (e.g. `on-chain`, `off-chain`, `smart-contract`, etc. )

**Pull Request and Issue Comments:**  
  Don’t hesitate to ask for help or clarification in comments. We’re all here to help each other out.

## Code of Conduct

We want this to be a welcoming, inclusive community. By participating, you’re agreeing to follow our [Code of Conduct](CODEOFCONDUCT.md). In short, be respectful, considerate, and open-minded.

## License

By contributing, you agree that your contributions will be licensed under the [LICENSE](LICENSE) used by the project.

---

Thanks again for your interest in contributing. We can’t wait to see what you’ll build!
