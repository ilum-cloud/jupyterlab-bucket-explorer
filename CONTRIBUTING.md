# Contributing to JupyterLab Bucket Explorer

Thank you for your interest in contributing to the JupyterLab Bucket Explorer extension! This guide will help you get started.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Code Style](#code-style)
- [Submitting Changes](#submitting-changes)
- [Release Process](#release-process)

---

## Code of Conduct

Please be respectful and professional when contributing to this project. We aim to foster an inclusive and welcoming community.

---

## Getting Started

### Prerequisites

- **Python** 3.8 or higher
- **Node.js** 18 or higher
- **JupyterLab** 4.4 or higher
- **Git**

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:

```bash
git clone https://github.com/YOUR_USERNAME/jupyter-bucket-explorer.git
cd jupyter-bucket-explorer
```

---

## Development Setup

### 1. Create a Virtual Environment

```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
```

### 2. Install Python Dependencies

```bash
pip install -e ".[dev]"
```

### 3. Install Node Dependencies

```bash
jlpm install
```

### 4. Build the Extension

```bash
jlpm run build
```

### 5. Link the Extension

The extension should be automatically linked if you installed it with `pip install -e .`. Verify with:

```bash
jupyter labextension list
jupyter server extension list
```

### 6. Start JupyterLab in Development Mode

```bash
# Terminal 1: Watch for changes and rebuild automatically
jlpm run watch

# Terminal 2: Start JupyterLab with watch mode
jupyter lab --watch
```

Now any changes you make to the TypeScript source will trigger a rebuild, and JupyterLab will reload automatically.

---

## Project Structure

```
jupyter-bucket-explorer/
├── src/                          # TypeScript source files
│   ├── browser.ts                # Main Bucket Explorer widget
│   ├── contents.ts               # S3 Contents Manager
│   ├── handler.ts                # HTTP handlers
│   ├── icons.ts                  # SVG icons
│   └── index.ts                  # Extension entry point
├── style/                        # CSS styles
│   ├── base.css                  # Main styles
│   └── icons/                    # SVG icon files
├── jupyterlab_bucket_explorer/        # Python backend
│   ├── handlers.py               # HTTP request handlers
│   └── utils.py                  # Utility functions
├── lib/                          # Compiled JavaScript (generated)
├── dist/                         # Distribution files (generated)
├── .github/workflows/            # CI/CD workflows
├── pyproject.toml                # Python package configuration
├── package.json                  # Node package configuration
└── tsconfig.json                 # TypeScript configuration
```

---

## Development Workflow

### Making Changes

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** in the appropriate files

3. **Test your changes** (see [Testing](#testing))

4. **Commit your changes**:

   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

5. **Push to your fork**:

   ```bash
   git push origin feature/your-feature-name
   ```

6. **Open a Pull Request** on GitHub

### Commit Message Convention

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

**Examples:**

```
feat: add file upload dialog
fix: resolve connection timeout issues
docs: update README installation instructions
style: format code with prettier
```

---

## Testing

### Running Tests Locally

Currently, the project uses manual testing. We recommend:

1. **Test with MinIO** (local S3 server):

   ```bash
   # Start MinIO using docker-compose
   docker-compose -f .devcontainer/docker-compose.yaml up -d
   ```

2. **Test basic operations**:
   - Connect to S3
   - Browse buckets and objects
   - Upload files
   - Create folders
   - Delete objects
   - Filter files

3. **Test with AWS S3** (if you have access)

### Integration Tests

The project includes Playwright-based UI tests in the `ui-tests/` directory (currently under development).

---

## Code Style

### TypeScript/JavaScript

- Use **TypeScript** for all new code
- Follow the existing code style
- Use **ESLint** for linting:

  ```bash
  jlpm run lint:check
  ```

### Python

- Follow **PEP 8** guidelines
- Use **type hints** where appropriate
- Maximum line length: 88 characters (Black formatter)

### CSS

- Use CSS variables for theming
- Prefix custom classes with `jp-BucketExplorer` or `bucket-explorer-`
- Keep selectors specific to avoid conflicts

---

## Submitting Changes

### Pull Request Process

1. **Ensure all tests pass** (manual testing)
2. **Update documentation** if needed
3. **Describe your changes** clearly in the PR description
4. **Link related issues** using `Fixes #123` or `Closes #456`
5. **Request review** from maintainers

### PR Checklist

- [ ] Code follows project conventions
- [ ] Changes have been tested locally
- [ ] Documentation updated (if applicable)
- [ ] Commit messages follow convention
- [ ] No merge conflicts

---

## 🚢 Release Process

(For maintainers only)

1. **Update version** in `package.json`, `pyproject.toml`, and `_version.py`
2. **Update CHANGELOG.md** with release notes
3. **Create a git tag**:

   ```bash
   git tag -a v0.2.0 -m "Release version 0.2.0"
   git push origin v0.2.0
   ```

4. **Build and publish**:

   ```bash
   jlpm run build
   python -m build
   ```

---

## Tips for Contributors

- **Start small**: Fix a typo, improve docs, or fix a small bug
- **Ask questions**: Open an issue if you're unsure about something
- **Be patient**: Reviews may take time
- **Stay updated**: Sync your fork regularly with the main repository

---

## Reporting Bugs

Use the [GitHub issue tracker](https://github.com/ilum-cloud/jupyter-bucket-explorer/issues) to report bugs.

**Include**:

- JupyterLab version
- Extension version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Screenshots (if applicable)

---

## Feature Requests

We welcome feature ideas! Open an issue with the `enhancement` label and describe:

- The problem you're trying to solve
- Your proposed solution
- Alternative solutions you've considered

---

## Additional Resources

- [JupyterLab Extension Developer Guide](https://jupyterlab.readthedocs.io/en/stable/extension/extension_dev.html)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Boto3 S3 Documentation](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/s3.html)

---

## 🙏 Thank You

Your contributions make this project better for everyone. We appreciate your time and effort!

---

<div align="center">

**Questions?** Open an issue or reach out to the [Ilum Labs LLC](https://ilum.cloud) maintainers.

</div>
