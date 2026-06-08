# brainbox

Local‑first capture, organize, and search for links and notes. brainbox is a desktop app built with Tauri (Rust) and React that keeps your data on your machine, with fast full‑text search and handy capture flows.

> **⚠️ EDUCATIONAL/LEARNING PROJECT**
> This is an open source learning project demonstrating desktop app development with Tauri, React, and Rust. It is **NOT intended for production use** with sensitive data.

> **📚 Purpose**
> brainbox serves as a comprehensive example of:
> - Building cross-platform desktop apps with Tauri 2
> - Implementing full-text search with Tantivy
> - Local-first data storage with SQLite
> - Client-side encryption with proper key derivation
> - React + TypeScript frontend architecture
> - Auto-updates and protocol handlers

## Features

- Vaults: create, rename, cover images, delete, and reorder items per vault.
- Capture: add notes or URLs; auto-detects URLs and enriches with OpenGraph metadata.
- Previews: YouTube thumbnails, site favicon, and title/description extraction.
- Search: local full‑text search powered by Tantivy (BM25 ranking).
- AI (brainy): intelligent assistant with tool calling capabilities — can create notes, search vaults, fetch web content, and organize items. Supports multiple providers (Ollama, OpenAI, Anthropic, Google, OpenRouter).
- Hotkey: global capture hotkey (Windows) to pop open the capture modal.
- Protocol: `brainbox://capture?url=...&title=...` handler (Windows) for one‑click sends.
- Tray: system tray icon with show/hide/quit actions.
- Auto-Updates: seamless updates via GitHub releases.
- Local‑first: data stored in a local SQLite database; no cloud required.

## Tech Stack

- Desktop: Tauri 2 (Rust), plugins: global_shortcut, shell, single_instance, updater.
- Backend: Rust (`rusqlite`, `tantivy`, `reqwest`, `quick-xml`, `chacha20poly1305`).
- Frontend: React 18, TypeScript, Vite.
- Styling: CSS tokens, themes, and custom component library.

## Getting Started

### Prerequisites

- Node.js 18+ with Corepack/pnpm.
- Rust (stable) and Tauri system prerequisites for your OS:
  - Windows: Visual Studio Build Tools, WebView2.
  - macOS: Xcode Command Line Tools.
  - See: https://tauri.app/start/prerequisites/

### Install

#### For Development

```bash
corepack enable
pnpm install
```

#### For End Users

**Download from Releases**

1. Go to [GitHub Releases](https://github.com/oshtz/brainbox/releases)
2. Download the appropriate artifact for your platform:
   - **Windows**: `brainbox-portable.exe`
   - **macOS**: `.dmg` file (Apple Silicon M1/M2/M3+ only)

**macOS Installation Instructions**

Due to Apple's security requirements, unsigned apps show security warnings. Follow these steps:

1. **Download the DMG** from the releases page
2. **Open the DMG** and drag brainbox to Applications

**If you see "brainbox is damaged and can't be opened":**

This is a common issue with unsigned apps. Try these solutions in order:

**Method 1: Remove Quarantine (Recommended)**
```bash
xattr -dr com.apple.quarantine /Applications/brainbox.app
```

**Method 2: Disable Gatekeeper Temporarily**
```bash
sudo spctl --master-disable
# Launch the app, then re-enable:
sudo spctl --master-enable
```

**Method 3: Allow Specific App**
```bash
sudo spctl --add /Applications/brainbox.app
sudo spctl --enable /Applications/brainbox.app
```

**Method 4: Right-click Method**
1. Right-click the app in Applications and select "Open"
2. Click "Open" when macOS asks for confirmation

**If none of the above work:**
- Try downloading the DMG again (it might have been corrupted)
- Check that you're using an Apple Silicon Mac (M1/M2/M3+)
- Report the issue on GitHub with your macOS version

> **Note**: brainbox is an open source project and the macOS version is unsigned to avoid requiring Apple Developer credentials. These security warnings are normal for unsigned apps.

### Run (desktop)

```bash
pnpm tauri dev
```

Vite is configured for Tauri at `http://127.0.0.1:17340` with strict port matching.

### Run (web only)

```bash
pnpm dev
```

This runs the frontend in a browser without Tauri backend features.

### Build (desktop)

```bash
pnpm tauri build
```

Build artifacts (installers/bundles) are created via Tauri for your platform.

### Verify

```bash
pnpm run verify
```

This runs the frontend production build, unit tests, and Playwright smoke tests.

### Desktop Smoke

```bash
pnpm run smoke:tauri
```

This builds the real Tauri debug binary without bundling, starts the Vite dev server it expects, launches the desktop app with an isolated temporary `BRAINBOX_DATA_DIR`, verifies that the app initializes its SQLite DB and search index, then closes both processes.

Release gates and manual desktop QA are tracked in [docs/release-readiness.md](docs/release-readiness.md).

### Auto-Updates

brainbox includes an automatic update system that keeps your app current without manual downloads:

- **Automatic Checks**: App silently checks for updates on startup
- **Manual Control**: Check for updates anytime in Settings → App Updates
- **Simple Artifacts**: macOS updates use the release DMG, and Windows updates use the portable EXE
- **Cross-Platform**: Works on Windows and macOS
- **Non-Intrusive**: You choose when to install updates

## Usage

### Create a Vault

- Launch the app and create a new vault from the UI.
- Each vault stores items (notes/URLs) encrypted at rest in a local SQLite DB.

### Add Items

- Click Capture to add a note or paste a URL.
- URLs get enriched with title/description and a preview image when available.
- YouTube links automatically use a high‑quality thumbnail.

### Search

- Use the search bar to find items across vaults via Tantivy full‑text search.

### AI (brainy)

brainy is an intelligent assistant built into brainbox with full tool calling capabilities.

**Features:**
- Summarize notes and captured links automatically
- Create, update, and organize vault items via natural language
- Search across your vaults
- Fetch and process web content and YouTube transcripts
- Move items between vaults

**Supported Providers:**

| Provider | Type | Tool Calling |
|----------|------|--------------|
| Ollama | Local | Prompt-based |
| LM Studio | Local | Prompt-based |
| OpenAI | Cloud | Native |
| Anthropic | Cloud | Native |
| Google Gemini | Cloud | Native |
| OpenRouter | Cloud | Native |

**Setup:**
- Configure under Settings → AI: select a provider and enter credentials if needed.
- For local AI (Ollama): set Base URL (default `http://127.0.0.1:11434`) and choose a Model (e.g., `llama3.2`, `mistral`, `qwen2.5`).
- For cloud providers: enter your API key and select a model.
- Customize the system prompt to tune brainy's writing style.

**Usage:**
- Click the brainy button (sparkles icon) in the sidebar to open the chat panel.
- Ask brainy to perform actions like "create a new note about project ideas" or "search for notes about recipes".
- brainy will execute tools automatically and confirm completed actions.

### Capture Flows

- Global Hotkey (Windows): default `Alt+Shift+B` toggles the capture modal.
- Custom Protocol (Windows): open `brainbox://capture?url={URL}&title={TITLE}` to send the current page to brainbox. The app registers the protocol under the current user.
- Bookmarklet: use `examples/bookmarklet-direct.js` to copy the current page’s `{url,title}` as JSON to the clipboard; then paste into brainbox’s capture field.
- Bridge Page: `examples/brainbox-bridge.html` is a small page that redirects to the brainbox protocol; you can host/use it to create links that trigger the app.

## Data & Security

- Storage: database file is created at the OS "local app data" directory as `brainbox.sqlite`.
  - Windows: `%LOCALAPPDATA%` (e.g., `C:\\Users\\<you>\\AppData\\Local`).
  - macOS: `~/Library/Application Support`.
- Index: search index stored under `search_index/` in the same directory.
- Encryption: uses XChaCha20‑Poly1305 (32‑byte key) for item content and vault passwords.
  - **✅ Security Update (v0.0.1)**: Encryption keys are now properly derived from user passwords using PBKDF2 with 100,000 iterations and vault-specific salts.
  - Keys are derived on-demand and cached in memory during the session for performance.
  - Keys are automatically cleared when vaults are closed or the app exits.
  - New sync exports require a sync file passphrase and wrap vault names, item titles, content, summaries, covers, and device name in an encrypted envelope. Legacy plaintext sync files can still be imported for migration.
  - Standalone capture files are not exported by encrypted sync because they sit outside the sync JSON envelope.
  - **⚠️ Educational Purpose**: This implementation demonstrates proper cryptographic practices but is intended for learning. For production use with sensitive data, additional security measures would be required:
    - Hardware-backed key storage (TPM, Secure Enclave)
    - Biometric authentication
    - Key rotation mechanisms
    - Professional security audit
    - Secure key backup and recovery
  - AI can run locally via Ollama or LM Studio for fully offline operation. Cloud providers (OpenAI, Anthropic, Google, OpenRouter) are also supported. Leaving AI unconfigured keeps brainbox fully offline.

## OS Support

| Platform | Status | Notes |
|----------|--------|-------|
| **Windows** | Full Support | Global hotkey, protocol handler |
| **macOS** | Core Features | App runs, hotkey/protocol pending |

## Project Layout

```
brainbox/
├─ src/                    # React app (UI, components, contexts, utils)
│  ├─ components/          # UI components (BrainyChat, Sidebar, etc.)
│  └─ utils/ai/            # AI service layer
│     ├─ service.ts        # Unified AI provider management
│     ├─ types.ts          # TypeScript interfaces
│     ├─ tools.ts          # Tool definitions for brainy
│     ├─ toolExecutor.ts   # Maps tools to Tauri commands
│     ├─ agentLoop.ts      # Hybrid native/prompt-based agent loop
│     └─ providers/        # Provider implementations (Ollama, OpenAI, etc.)
├─ src-tauri/              # Tauri (Rust) backend, commands, tray, protocol
│  ├─ src/lib.rs           # Main Tauri builder and command registration
│  ├─ src/sync_commands.rs # Sync command wrappers
│  ├─ src/paths.rs         # App data path helpers
│  ├─ src/vault.rs         # SQLite models for vaults and items
│  └─ src/search.rs        # Tantivy index and search service
├─ styles/                 # Design tokens, globals, themes
├─ public/                 # Static assets
├─ examples/
│  ├─ bookmarklet-direct.js    # Clipboard-based bookmarklet
│  └─ brainbox-bridge.html     # Protocol bridge page
```

## Scripts

- `dev`: run Vite locally.
- `tauri dev`: run desktop app in dev mode (Vite + Tauri).
- `build`: build frontend assets.
- `tauri build`: produce desktop bundles.

## Development & Deployment

### Branching Strategy

- **`main` branch**: Production-ready code that triggers automatic releases
- **`dev` branch**: Active development (default working branch)

### Workflow

1. Work on features in the `dev` branch
2. Test thoroughly before merging to `main`
3. Merge `dev` → `main` triggers automatic CI/CD pipeline
4. GitHub Actions builds and releases for all platforms

GitHub Actions can be configured to build and release for all platforms automatically.

## Known Issues

**Platform Support**:
- Global hotkey: Windows only (macOS)
- Protocol handler: Windows only (macOS)

## Roadmap / Ideas

- Proper key management and encryption UX.
- Cross‑platform global hotkey and protocol support.
- Richer previews and content extraction.
- Import/export and backup/sync options.
- Plugin API for custom capture/processing flows.

## License

MIT — see `LICENSE` for details.

## Acknowledgements

- Built with [Tauri](https://tauri.app/), [React](https://react.dev/), [Vite](https://vitejs.dev/), and [Tantivy](https://github.com/quickwit-oss/tantivy).
