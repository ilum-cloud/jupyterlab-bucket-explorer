# JupyterLab Bucket Explorer - Universal Storage Browser for JupyterLab

<div align="center">

![Bucket Explorer Demo](bucket-browser.gif)

**A modern, multi-cloud object storage browser for JupyterLab 4**

Unified interface to browse, manage, and edit files across **AWS S3**, **MinIO**, **Google Cloud Storage**, **Azure Blob Storage**, and **HDFS**.

> **Note**: Currently, **S3** and **MinIO** are fully supported. Initial support for GCS, Azure, and HDFS is in active development.

[![Build Status](https://github.com/ilum-cloud/jupyterlab-bucket-explorer/actions/workflows/build.yml/badge.svg)](https://github.com/ilum-cloud/jupyterlab-bucket-explorer/actions/workflows/build.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![JupyterLab](https://img.shields.io/badge/JupyterLab-4.4-orange.svg)](https://jupyterlab.readthedocs.io/)
[![MinIO](https://img.shields.io/badge/MinIO-Compatible-red.svg)](https://min.io/)

</div>

---

## Features

- **Unified Storage Management** - Manage multiple connections (S3, GCS, Azure, HDFS) from a single Explorer View
- **Multi-Cloud Ready** - Designed for AWS S3, Google Cloud Storage, Azure Blob Storage, and MinIO (S3/Minio available now)
- **Explorer View** - Central hub to view, add, edit, and delete your storage connections
- **JupyterLab 4 Native** - Built specifically for JupyterLab 4.4+ with modern UI components and TypeScript
- **MinIO Optimized** - First-class support for MinIO object storage with region-free configuration
- **Seamless Integration** - Browse buckets and objects using a familiar file-system interface
- **File Upload & Management** - Drag and drop or browse to upload files, create folders, and delete objects
- **Direct File Editing** - Open and edit compatible files (CSV, JSON, Text, etc.) directly in JupyterLab
- **Smart File Filtering** - Toggle filter view to quickly find specific files
- **Flexible Authentication** - Interactive connection manager or environment variable configuration
- **Clean Interface** - Minimalist design that integrates seamlessly with JupyterLab's native UI

---

## Why Bucket Explorer?

### 🚀 High Performance for Large Files

Unlike standard file browsers that download/upload files to move them, Bucket Explorer performs **server-side Copy and Move operations**. This means moving a **100GB** file from one folder to another is **instant** and consumes **zero network bandwidth**.

### 🔌 Native MinIO Integration

Built with **MinIO** as a first-class citizen. It detects your MinIO configuration automatically and handles path styles correctly, so you don't need to fight with generic S3 settings.

### ⚡ Smart Download Strategy

Downloads are handled intelligently to prevent browser crashes using `Blob` URLs and client-side memory management, ensuring smooth handling of larger files that often choke built-in browser viewers.

### 🗑️ Efficient Resource Management

Includes **recursive directory deletion** and batch operations handled on the backend, making cleanup tasks fast and reliable.

---

## Installation

### Prerequisites

- **JupyterLab 4.4 or higher** (required for this extension)
- Python 3.8+

### Using pip

```bash
pip install jupyterlab-bucket-explorer
```

After installation, restart JupyterLab. The extension should be automatically enabled.

> **Note for MinIO users**: This extension works out-of-the-box with MinIO. No additional configuration needed!

### From source (development)

```bash
git clone https://github.com/ilum-cloud/jupyter-bucket-explorer.git
cd jupyter-bucket-explorer
pip install -e ".[dev]"
```

If you install from source (or use `pip install --no-binary`), you need Node.js to build the JupyterLab frontend assets. The build uses `jlpm` (JupyterLab's bundled package manager) automatically. The PyPI wheel already bundles these assets, so a plain `pip install jupyterlab-bucket-explorer` does not require Node.

---

## Configuration

### Interactive Configuration

The extension now features a **Connection Manager** interface:

1. Click **"+ ADD"** to create a new connection.
2. Select **Storage Type** (S3, GCS, WASBS, HDFS).
3. Enter **Name** (alias for the connection).
4. Enter **Endpoint URL** (e.g., `http://localhost:9000` for MinIO) and credentials.
5. Click **"Test Connection"** to verify, then **"Create Connection"**.

> **Note**: Currently, only **S3** (and S3-compatible services) is fully supported. Other storage types are coming soon.

You can manage multiple connections and switch between them easily.

### Environment Variables

You can also configure S3 credentials via environment variables:

```bash
export S3_CONNECTION_NAME="My Env Connection"
export S3_ENDPOINT="https://s3.amazonaws.com"
export S3_ACCESS_KEY="your-access-key"
export S3_SECRET_KEY="your-secret-key"
export S3_REGION="us-east-1"
```

Then restart JupyterLab.

### Provider-Specific Examples

#### AWS S3

```
Endpoint URL: (leave empty or https://s3.amazonaws.com)
Access Key ID: AKIA...
Secret Access Key: wJalr...
Region: us-east-1
```

#### MinIO

```
Endpoint URL: http://localhost:9000
Access Key ID: minioadmin
Secret Access Key: minioadmin
Region: (leave empty)
```


---

## Usage

1. **Open the Bucket Explorer**: Click the bucket explorer icon (bucket icon) in the left sidebar
2. **Explorer View**: You will see a list of your configured connections (or an empty state).
3. **Add Connection**: Click the **"+ ADD"** button to configure a new connection (S3, GCS, etc.).
4. **Connect**: Click on a connection card to open the file browser for that storage.
5. **Browse & Manage**: Navigate buckets, upload files, filter, and delete items.
6. **Switch Connections**: Click the **"<" (Back)** button in the toolbar to return to the Connection List.

---

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development instructions.

### Quick Start

```bash
# Clone the repository
git clone https://github.com/ilum-cloud/jupyter-bucket-explorer.git
cd jupyter-bucket-explorer

# Create a virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -e ".[dev]"
jlpm install

# Build the extension
jlpm run build

# Start JupyterLab in watch mode
jupyter lab --watch
```

---

## Tests

Below are the exact commands to run the tests (assuming you are in the repository root).

### 1) Backend tests (pytest + moto)

```bash
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -e ".[test]"
pytest -q
```

### 2) Frontend unit tests (Jest)

```bash
jlpm install
jlpm test
```

### 3) E2E / UI tests (Playwright + Galata)

```bash
# First build the extension
jlpm install
jlpm run build:prod

# Install test dependencies and run UI tests
cd ui-tests
jlpm install
jlpm playwright install
jlpm playwright test
```

Full end-to-end coverage (including MinIO integration for listing buckets and files) runs on GitHub Actions runners in CI; locally, the MinIO E2E test is skipped unless you explicitly set the required MinIO environment variables.

---

## Troubleshooting

### Extension not showing up

- Ensure the server extension is enabled: `jupyter server extension list`
- Check that JupyterLab can find the extension: `jupyter labextension list`
- Try rebuilding: `jupyter lab build`

### Connection issues

- Verify your endpoint URL is correct (include `http://` or `https://`)
- Check that your access credentials are valid
- For MinIO, ensure the server is running and accessible

### CORS errors

- If using MinIO locally, you may need to configure CORS settings

---

### Development and Formatting

To ensure code quality and consistency, we use **Ruff** for Python and **Prettier** for TypeScript/CSS.

#### Formatting Code Manually

**Python:**

```bash
# Format and lint Python code
ruff check . --fix
ruff format .
```

**TypeScript / CSS / JSON / Markdown:**

```bash
# Format frontend assets
jlpm prettier
```

#### Automating with pre-commit

We recommend using `pre-commit` to automate these checks:

1. Install pre-commit: `pip install pre-commit`
2. Install hooks: `pre-commit install`

Now, every time you commit, the code will be automatically checked and formatted.

## License

This project is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE) for details.

---

## Acknowledgments

Developed with ❤️ by **[Ilum Labs LLC](https://ilum.cloud)**

---

## Related Projects

- [Sparkmagic (Ilum fork)](https://github.com/ilum-cloud/sparkmagic/tree/ilum) - Internal developed version integrated with **Ilum API** for enhanced session management and specialized features


---

## Roadmap & Feature Support

### Current Feature Support

| Feature                    | Status             | Notes                          |
| -------------------------- | ------------------ | ------------------------------ |
| **Platform Compatibility** |                    |                                |
| JupyterLab 4.4+            | ✅ Fully Supported | Native integration             |
| **Storage Providers**      |                    |                                |
| AWS S3                     | ✅ Fully Supported | Production-ready               |
| MinIO                      | ✅ Fully Supported | Optimized, first-class support |
| S3-Compatible APIs         | ✅ Supported       | Google Cloud Storage, etc.     |
| Google Cloud Storage       | 🔜 Planned         | Direct GCS API integration     |
| Azure Blob Storage         | 🔜 Planned         | Native Azure support           |
| HDFS                       | 🔜 Planned         | Native Hadoop support          |
| **Core Operations**        |                    |                                |
| Browse buckets & folders   | ✅ Supported       |                                |
| Upload files               | ✅ Supported       | Single & batch upload          |
| Download files             | ✅ Supported       | Smart memory management        |
| Delete files/folders       | ✅ Supported       | Recursive deletion             |
| Create folders             | ✅ Supported       |                                |
| Move/Copy files            | ✅ Supported       | Server-side operations         |
| File filtering/search      | ✅ Supported       | Toggle filter view             |
| **Advanced Features**      |                    |                                |
| Direct file editing        | ✅ Supported       | CSV, JSON, text files          |
| Drag & drop upload         | ⚠️ Partial         | Browser-click upload works     |
| Multipart upload           | 🔜 Planned         | For files >5GB                 |
| Versioning support         | 🔜 Planned         | Object version history         |
| Metadata editing           | 🔜 Planned         | Custom object metadata         |
| ACL/Permissions            | 🔜 Planned         | Manage object permissions      |
| **Authentication**         |                    |                                |
| Access Key/Secret          | ✅ Supported       |                                |
| Environment variables      | ✅ Supported       |                                |
| IAM roles                  | ⚠️ Partial         | Works with instance profiles   |
| STS temporary credentials  | 🔜 Planned         |                                |
| OAuth/OIDC                 | 🔜 Planned         |                                |

**Legend:**

- ✅ **Fully Supported** - Production-ready and tested
- ⚠️ **Partial** - Works with limitations
- 🔜 **Planned** - Coming in future releases
- 🚧 **In Progress** - Currently under development

---

### Contributing to the Roadmap

Have ideas or want to prioritize a feature? We'd love to hear from you!

- 💡 **Suggest features**: Open an issue with the `enhancement` label
- 🗳️ **Vote on features**: React with 👍 on existing feature requests
- 🤝 **Contribute**: Check out [CONTRIBUTING.md](CONTRIBUTING.md) to get started

---

<div align="center">

**[Report Bug](https://github.com/ilum-cloud/jupyter-bucket-explorer/issues)** · **[Request Feature](https://github.com/ilum-cloud/jupyter-bucket-explorer/issues)**

</div>

## Releasing

To release a new version of the extension and make it visible in the JupyterLab Extension Manager, follow these steps:

### 1. Update Version Numbers

Ensure the version numbers are consistent across the following files:

- `package.json`: `"version": "X.Y.Z"`
- `pyproject.toml`: `version = "X.Y.Z"`

### 2. Clean and Build

Clean previous builds and create the distribution packages (source tarball and wheel).

```bash
# Clean artifacts
rm -rf dist build lib jupyterlab_bucket_explorer/labextension

# Install build dependencies
pip install build twine

# Build the package (this triggers the npm build automatically)
python -m build
```

### 3. Publish to PyPI

The JupyterLab Extension Manager discovers extensions published to PyPI with the specific classifiers (which are already configured in `pyproject.toml`).

```bash
# Upload to PyPI
twine upload dist/*
```

Once published:

1. The extension will appear in the **JupyterLab Extension Manager**.
2. Users can install it via `pip install jupyterlab-bucket-explorer`.

### 4. Step-by-step publishing guide

See `RELEASE.md`.
