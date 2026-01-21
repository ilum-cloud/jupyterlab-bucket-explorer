# Release Guide

Step-by-step: publish to PyPI for `pip install jupyterlab-bucket-explorer`.

1. **Bump versions**

- `package.json` → `"version": "X.Y.Z"`
- `pyproject.toml` → `version = "X.Y.Z"`

1. **Clean build artifacts**

```bash
rm -rf dist build lib jupyterlab_bucket_explorer/labextension
```

1. **Build the packages (sdist + wheel)**

```bash
python -m pip install --upgrade build twine
python -m build
```

1. **Publish to PyPI (Automated via GitHub)**

## Option A: Tag-based Release (Recommended)

Simply push a new tag starting with `v` (e.g., `v0.1.0`) to the repository. The workflow will automatically build and publish to PyPI.

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Option B: Manual Trigger

1. Go to **Actions** tab in GitHub repository.
2. Select **Release** workflow.
3. Click **Run workflow**.
4. Check **Publish to PyPI?** to perform the actual upload (ensure `PYPI_API_TOKEN` secret is set).
5. Click **Run workflow**.

## Manual Publishing (Fallback)

If you prefer to publish manually from your local machine:

1. **Build**:

```bash
rm -rf dist build lib jupyterlab_bucket_explorer/labextension
python -m build
```

1. **Check**:

```bash
python -m twine check dist/*
```

1. **Upload**:

```bash
twine upload dist/*
```

1. **Verify**:

```bash
pip install jupyterlab-bucket-explorer
```
