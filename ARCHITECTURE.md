# brainbox Architecture

This document provides a comprehensive overview of brainbox's architecture, including the frontend React application, the Rust backend, and how they interact.

## Table of Contents

- [Overview](#overview)
- [Technology Stack](#technology-stack)
- [Frontend Architecture](#frontend-architecture)
- [Backend Architecture](#backend-architecture)
- [Data Flows](#data-flows)
- [Security Architecture](#security-architecture)
- [Data Storage](#data-storage)

---

## Overview

brainbox is a local-first desktop application for capturing, organizing, and searching knowledge. It uses a Tauri (Rust) backend for system integration, encryption, and storage, with a React frontend for the user interface.

```
+------------------+     IPC (invoke/listen)     +------------------+
|                  | <-------------------------> |                  |
|  React Frontend  |                             |   Rust Backend   |
|  (TypeScript)    |                             |   (Tauri 2.0)    |
|                  |                             |                  |
+------------------+                             +------------------+
        |                                                 |
        v                                                 v
   localStorage                                    +-------------+
   (preferences)                                   |   SQLite    |
                                                   |  (encrypted)|
                                                   +-------------+
                                                         |
                                                         v
                                                   +-------------+
                                                   |   Tantivy   |
                                                   |   (search)  |
                                                   +-------------+
```

---

## Technology Stack

### Frontend
- **React 18** - UI framework
- **TypeScript** - Type-safe JavaScript
- **Vite** - Build tool and dev server
- **CSS Modules** - Component-scoped styling
- **@tauri-apps/api** - IPC with Rust backend

### Backend
- **Tauri 2.0** - Desktop app framework (Rust)
- **rusqlite** - SQLite database
- **tantivy** - Full-text search (BM25 ranking)
- **chacha20poly1305** - XChaCha20-Poly1305 encryption
- **reqwest** - HTTP client for metadata fetching
- **Tauri Plugins**: global_shortcut, shell, updater, single_instance

### Testing
- **Vitest** - Unit testing
- **Playwright** - E2E testing
- **React Testing Library** - Component testing

---

## Frontend Architecture

### Directory Structure

```
src/
├── components/          # React components
│   ├── Button/         # Reusable UI components
│   ├── CaptureModal/   # Item capture dialog
│   ├── CreateVaultModal/
│   ├── Header/
│   ├── ItemPanel/      # Item detail view
│   ├── Library/        # All-items grid view
│   ├── Masonry/        # Responsive grid layout
│   ├── SearchBar/
│   ├── Settings/
│   ├── Sidebar/
│   ├── Toast/          # Notification system
│   ├── VaultCard/
│   └── ...
├── contexts/           # React Context providers
│   ├── ThemeContext.tsx
│   ├── ToastContext.tsx
│   ├── HotkeyContext.tsx
│   ├── VaultPasswordContext.tsx
│   └── ...
├── utils/              # Utility functions
│   ├── crypto.ts       # Key derivation (PBKDF2)
│   ├── meshGradient.ts # Procedural cover images
│   ├── ollama.ts       # AI integration
│   ├── searchIndexer.ts
│   ├── urlPreview.ts   # URL metadata extraction
│   └── validation.ts
├── styles/             # Global styles
│   ├── tokens.css      # Design tokens
│   ├── global.css      # Base styles
│   └── themes/         # Theme overrides
├── App.tsx             # Main application
├── main.tsx            # Entry point with providers
└── types.ts            # TypeScript definitions
```

### Context Providers

The app uses React Context for state management, layered in `main.tsx`:

```tsx
<ErrorBoundary>
  <HotkeyProvider>
    <ThemeProvider>
      <ToastProvider>
        <VaultPasswordProvider>
          <App />
        </VaultPasswordProvider>
      </ToastProvider>
    </ThemeProvider>
  </HotkeyProvider>
</ErrorBoundary>
```

| Context | Purpose |
|---------|---------|
| `HotkeyProvider` | Global keyboard shortcuts |
| `ThemeProvider` | Light/dark theme, accent colors |
| `ToastProvider` | Toast notifications |
| `VaultPasswordProvider` | Vault password caching and key derivation |

### Component Hierarchy

```
App
├── Titlebar
├── Sidebar
│   └── Navigation (vaults, search, library, connections, settings)
├── Header
│   └── Action buttons (New Note, New Vault)
└── Content Area
    ├── Vaults View
    │   ├── VaultCard (grid)
    │   └── Vault Items (Masonry)
    │       └── ItemPanel (slide-in detail)
    ├── Search View
    │   ├── SearchBar
    │   └── Search Results (Masonry)
    ├── Library View
    │   └── All Items (Masonry)
    ├── Connections View
    └── Settings View
```

### Styling Approach

- **CSS Modules**: Each component has a `.module.css` file for scoped styles
- **Design Tokens**: Variables in `styles/tokens.css` for colors, spacing, typography
- **Theming**: CSS variables updated dynamically via `ThemeContext`
- **Dark Mode**: Overrides in `styles/themes/dark.css`

---

## Backend Architecture

### Module Structure

```
src-tauri/src/
├── lib.rs          # Main entry, Tauri commands, app setup
├── vault.rs        # Vault & item management, encryption
├── search.rs       # Tantivy search service
└── capture.rs      # Screenshot capture (Windows)
```

### Tauri Commands

Commands are the primary IPC mechanism between frontend and backend:

#### Vault Management
| Command | Description |
|---------|-------------|
| `create_vault` | Create encrypted vault |
| `list_vaults` | Get all vaults |
| `delete_vault` | Delete vault and items |
| `rename_vault` | Update vault name |
| `update_vault_cover` | Set/clear cover image |

#### Item Management
| Command | Description |
|---------|-------------|
| `add_vault_item` | Create encrypted item |
| `list_vault_items` | Get items (decrypted) |
| `get_vault_item` | Get single item |
| `delete_vault_item` | Remove item |
| `update_vault_item_*` | Update title/content/image/summary |
| `move_vault_item` | Move to different vault |

#### Search
| Command | Description |
|---------|-------------|
| `search` | Full-text search with BM25 |
| `index_document` | Add to search index |
| `delete_document` | Remove from index |

#### Platform-Specific
| Command | Description |
|---------|-------------|
| `register_capture_hotkey` | Register global shortcut |
| `register_brainbox_protocol` | Register `brainbox://` handler (Windows) |
| `capture_screenshot_metadata` | Capture screen (Windows) |

### Database Schema

SQLite database with two main tables:

```sql
-- Vaults table
CREATE TABLE vaults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    encrypted_password BLOB NOT NULL,
    created_at TEXT NOT NULL,
    cover_image TEXT  -- Added via ALTER TABLE
);

-- Vault items table
CREATE TABLE vault_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_id INTEGER NOT NULL REFERENCES vaults(id),
    title TEXT NOT NULL,
    content BLOB NOT NULL,  -- Encrypted
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sort_order INTEGER,     -- Added via ALTER TABLE
    image TEXT,             -- Added via ALTER TABLE
    summary TEXT            -- Added via ALTER TABLE
);
```

### Search Service (Tantivy)

The search service uses Tantivy for BM25-ranked full-text search:

```rust
pub struct SearchFields {
    pub id: Field,
    pub title: Field,       // Searchable + stored
    pub content: Field,     // Searchable + stored
    pub item_type: Field,   // Stored
    pub created_at: Field,  // Stored
    pub updated_at: Field,  // Stored
    pub path: Field,        // Stored
    pub tags: Field,        // Searchable + stored
}
```

**Index Location**: `{app_data_dir}/brainbox/search_index`

**Features**:
- BM25 relevance ranking
- Multi-field queries
- Timeout protection (macOS)
- Index recovery for corruption

---

## Data Flows

### Vault Creation

```
1. User enters name + password in CreateVaultModal
2. Frontend derives key: PBKDF2-SHA256(password, vaultId, 100000 iterations)
3. Frontend invokes 'create_vault' with name, password, derived key
4. Backend encrypts password with XChaCha20-Poly1305
5. Backend stores vault in SQLite
6. Frontend caches derived key in VaultPasswordContext
7. Frontend emits 'vaults-changed' event
```

### Item Capture

```
1. User opens CaptureModal (via button or global hotkey)
2. User enters title and content (URL or text)
3. If URL: LinkPreview fetches OpenGraph metadata
4. Frontend invokes 'add_vault_item' with vault key
5. Backend encrypts content with XChaCha20-Poly1305
6. Backend stores item in SQLite
7. Backend indexes item in Tantivy
8. Frontend updates UI and shows confirmation
```

### Item Retrieval

```
1. User selects vault (selectedVaultId changes)
2. If key not cached: prompt for password, derive key
3. Frontend invokes 'list_vault_items' with vault key
4. Backend decrypts each item's content
5. Backend returns decrypted items
6. Frontend renders in Masonry grid
7. Frontend generates mesh gradients for missing images
```

### Search

```
1. User enters query in SearchBar
2. Frontend invokes 'search' with query and limit
3. Backend parses query with Tantivy QueryParser
4. Backend searches index with BM25 ranking
5. Backend returns results with title, preview, score
6. Frontend displays results
7. User clicks result: opens ItemPanel with full content
```

---

## Security Architecture

### Encryption

| Component | Implementation |
|-----------|----------------|
| **Algorithm** | XChaCha20-Poly1305 (AEAD) |
| **Key Size** | 256 bits (32 bytes) |
| **Nonce Size** | 192 bits (24 bytes, random per encryption) |
| **Key Derivation** | PBKDF2-SHA256, 100,000 iterations |
| **Salt** | Vault ID (deterministic for reproducible keys) |

### What's Encrypted

| Data | Encrypted | Notes |
|------|-----------|-------|
| Vault password | Yes | Stored as encrypted blob |
| Item content | Yes | Text/URL content |
| Vault name | No | Visible in UI |
| Item title | No | Visible in UI, searchable |
| Item metadata | No | Timestamps, sort order |

### Key Lifecycle

```
Session Start:
  └─> User accesses vault
      └─> VaultPasswordContext prompts for password
          └─> PBKDF2 derives 256-bit key
              └─> Key cached in memory (Map<vaultId, key>)

During Session:
  └─> All operations use cached key
      └─> Key passed to Tauri commands as number[]
          └─> Backend converts to [u8; 32]

Session End:
  └─> clearKey(vaultId) or clearAllKeys()
      └─> Keys removed from memory
```

### Security Notes

- **Passwords never stored**: Only derived keys in memory
- **Per-item nonces**: Random 24-byte nonce for each encryption
- **Session-only keys**: Keys cleared on app close
- **No cloud sync**: All data stays local

---

## Data Storage

### File Locations

| Data | Location |
|------|----------|
| Database | `{app_data_dir}/brainbox.sqlite` |
| Search Index | `{app_data_dir}/brainbox/search_index/` |
| Screenshots | `{app_data_dir}/brainbox/captures/` |
| Preferences | Browser localStorage |

### Platform-Specific Paths

| Platform | `{app_data_dir}` |
|----------|------------------|
| Windows | `%LOCALAPPDATA%` (e.g., `C:\Users\<user>\AppData\Local`) |
| macOS | `~/Library/Application Support` |

---

## Platform Support

| Feature | Windows | macOS |
|---------|---------|-------|
| Core app | Yes | Yes |
| Global hotkey | Yes | Partial |
| Protocol handler | Yes | Pending |
| Screenshot capture | Yes | Pending |
| Auto-updates | Yes | Yes |