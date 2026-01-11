# Brainbox Sync Feature - Implementation Plan

## Overview

Enable cross-device synchronization for Brainbox using a "Sync on Close" approach. This works with any file sync service (Syncthing, Dropbox, OneDrive, Google Drive, etc.) - the user simply points Brainbox to a sync folder.

---

## Sync Folder Structure

```
sync_folder/                    # User picks this one directory
├── brainbox.sync               # JSON sync file (vaults, items, metadata)
└── captures/                   # Screenshots subfolder (auto-created)
    ├── screenshot-2026-01-09-123456.png
    └── screenshot-2026-01-08-654321.png
```

User only configures **one path** - we handle the rest.

---

## Decisions Summary

| Aspect | Decision |
|--------|----------|
| Sync trigger | On app open/close (not real-time) |
| Folder structure | Single directory with `brainbox.sync` + `captures/` subfolder |
| Password handling (export) | Export unlocked vaults; prompt for locked ones |
| Password mismatch (import) | Skip vault, warn user |
| Deleted items | Soft delete, sync deletions, purge after 30 days |
| Screenshots | Sync in `captures/` subfolder |
| Conflicts | Keep both versions, mark with "[Conflict]" |
| Vault scope | Always all vaults |
| Device name | Auto-detect hostname |
| Sync file format | Plain JSON |

---

## Sync File Format

```json
{
  "format_version": "1.0",
  "device_id": "uuid-v4",
  "device_name": "DESKTOP-ABC123",
  "exported_at": "2026-01-09T12:00:00Z",
  "vaults": [
    {
      "uuid": "vault-uuid",
      "name": "My Vault",
      "created_at": "...",
      "updated_at": "...",
      "deleted_at": null,
      "cover_image": "...",
      "has_password": true,
      "items": [
        {
          "uuid": "item-uuid",
          "title": "...",
          "content": "decrypted plaintext content",
          "created_at": "...",
          "updated_at": "...",
          "deleted_at": null,
          "image": "...",
          "summary": "...",
          "sort_order": 1
        }
      ]
    }
  ],
  "captures": [
    {
      "filename": "screenshot-2026-01-09-123456.png",
      "created_at": "...",
      "size_bytes": 123456
    }
  ]
}
```

---

## Database Schema Changes

```sql
-- Add to vaults table
ALTER TABLE vaults ADD COLUMN uuid TEXT UNIQUE;
ALTER TABLE vaults ADD COLUMN updated_at TEXT;
ALTER TABLE vaults ADD COLUMN deleted_at TEXT;  -- soft delete

-- Add to vault_items table
ALTER TABLE vault_items ADD COLUMN uuid TEXT UNIQUE;
ALTER TABLE vault_items ADD COLUMN deleted_at TEXT;  -- soft delete

-- New sync_settings table
CREATE TABLE sync_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
-- Keys: sync_folder, device_id, device_name, last_sync_at, auto_sync_enabled, purge_deleted_after_days
```

---

## Implementation Phases

### Phase 1: Schema & Foundation (Rust)

**Goal:** Add UUID tracking, soft deletes, and sync settings to database

| Task | Description |
|------|-------------|
| 1.1 | Add `uuid`, `updated_at`, `deleted_at` columns to `vaults` table |
| 1.2 | Add `uuid`, `deleted_at` columns to `vault_items` table |
| 1.3 | Create `sync_settings` table (key-value store) |
| 1.4 | Migration: generate UUIDs for existing vaults/items |
| 1.5 | Auto-set `uuid` on create, update `updated_at` on every modification |

---

### Phase 2: Sync Export (Rust)

**Goal:** Export database + captures to sync folder

| Task | Description |
|------|-------------|
| 2.1 | Create `sync_export(passwords: Map<vault_id, key>)` Tauri command |
| 2.2 | Validate sync folder is configured |
| 2.3 | Create `captures/` subfolder if missing |
| 2.4 | For each vault: decrypt content if password provided, skip if locked and no password |
| 2.5 | Include soft-deleted items (for deletion sync) |
| 2.6 | Copy local captures to `sync_folder/captures/` |
| 2.7 | Write `brainbox.sync` JSON file |
| 2.8 | Update `last_sync_at` in sync_settings |

---

### Phase 3: Sync Import & Merge (Rust)

**Goal:** Import sync file, merge with local database

| Task | Description |
|------|-------------|
| 3.1 | Create `sync_import(passwords: Map<vault_id, key>)` Tauri command |
| 3.2 | Read and validate `brainbox.sync` file |
| 3.3 | **Vault merge logic:** |
|     | - Match by UUID |
|     | - New vault (UUID not in local) → insert |
|     | - Existing vault, remote `updated_at` > local → update metadata |
|     | - Password mismatch (can't decrypt) → skip, add to warnings |
| 3.4 | **Item merge logic:** |
|     | - Match by UUID |
|     | - New item → insert, encrypt with local vault password |
|     | - Remote newer → update, re-encrypt |
|     | - Both modified (local and remote `updated_at` differ from last sync) → conflict |
| 3.5 | **Conflict handling:** duplicate item with "[Conflict]" title suffix |
| 3.6 | **Deletion sync:** if remote has `deleted_at`, apply locally |
| 3.7 | Copy new captures from `sync_folder/captures/` to local captures folder |
| 3.8 | Rebuild Tantivy search index |
| 3.9 | Return import result: `{ imported_vaults, imported_items, conflicts, warnings, skipped_vaults }` |

---

### Phase 4: Purge Deleted Items (Rust)

**Goal:** Clean up old soft-deleted items

| Task | Description |
|------|-------------|
| 4.1 | Create `purge_deleted_items(days: i32)` command |
| 4.2 | Delete items/vaults where `deleted_at` is older than X days |
| 4.3 | Run on app startup (if sync enabled) |
| 4.4 | Default: purge after 30 days (configurable) |

---

### Phase 5: Sync Check & Auto-Triggers (Rust + React)

**Goal:** Automatically check and trigger sync

| Task | Description |
|------|-------------|
| 5.1 | Create `check_sync_status()` command → returns `{ local_modified_at, remote_modified_at, has_changes }` |
| 5.2 | On app startup: if sync enabled, check for newer remote file |
| 5.3 | If remote newer: show notification/modal "Sync available from [device_name]" |
| 5.4 | On app close (`tauri::RunEvent::Exit`): trigger export if auto-sync enabled |
| 5.5 | Create `get_locked_vaults()` command → returns vaults that need password for export |
| 5.6 | Auto-detect device hostname for `device_name` default |

---

### Phase 6: Settings UI (React)

**Goal:** User interface for sync configuration

| Task | Description |
|------|-------------|
| 6.1 | Add "Sync" section to Settings page |
| 6.2 | Folder picker: "Sync Folder" (uses Tauri dialog) |
| 6.3 | Text input: "Device Name" (auto-filled with hostname) |
| 6.4 | Toggle: "Sync on close" |
| 6.5 | Toggle: "Check for sync on startup" |
| 6.6 | Number input: "Purge deleted items after X days" |
| 6.7 | Button: "Sync Now" |
| 6.8 | Display: "Last synced: [timestamp] from [device]" |
| 6.9 | Display: sync folder path with "Change" button |

---

### Phase 7: Sync Flow UI (React)

**Goal:** Handle sync interactions and feedback

| Task | Description |
|------|-------------|
| 7.1 | **Pre-export flow:** detect locked vaults, prompt for passwords |
| 7.2 | **Export progress:** show "Exporting... X vaults, Y items" |
| 7.3 | **Import prompt:** "Sync available from [Device B]. Import?" with summary |
| 7.4 | **Import progress:** show "Importing... X vaults, Y items" |
| 7.5 | **Import result:** show summary (imported, conflicts, warnings) |
| 7.6 | **Warning display:** "Skipped vault [name] - password mismatch" |

---

### Phase 8: Conflict Resolution UI (React)

**Goal:** Let users resolve sync conflicts

| Task | Description |
|------|-------------|
| 8.1 | After import, if conflicts exist, show conflict modal |
| 8.2 | List conflicting items with timestamps |
| 8.3 | "View Conflicts" button in vault view (filter `[Conflict]` items) |
| 8.4 | Side-by-side comparison view (optional, nice-to-have) |
| 8.5 | Quick actions: delete conflict copy, rename, merge manually |

---

## File Changes Overview

| File | Changes |
|------|---------|
| `src-tauri/src/lib.rs` | Add sync commands, app close handler |
| `src-tauri/src/vault.rs` | Add UUID/timestamp/soft-delete fields, update queries |
| `src-tauri/src/sync.rs` | **New file:** sync export/import/merge logic |
| `src/components/Settings/` | Add Sync settings section |
| `src/components/SyncModal/` | **New:** sync prompts, progress, conflict UI |
| `src/contexts/SyncContext.tsx` | **New:** sync state management |
| `src/types/index.ts` | Add sync-related types |

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Schema | ~2-3 hours |
| Phase 2: Export | ~3-4 hours |
| Phase 3: Import/Merge | ~5-6 hours (most complex) |
| Phase 4: Purge | ~1 hour |
| Phase 5: Auto-triggers | ~2-3 hours |
| Phase 6: Settings UI | ~2-3 hours |
| Phase 7: Sync Flow UI | ~3-4 hours |
| Phase 8: Conflict UI | ~2-3 hours |
| **Total** | **~20-26 hours** |

---

## Security Note

The sync file contains **decrypted content** (plaintext). Users should be warned:

> "Your sync file contains unencrypted vault data. Ensure your sync folder is secured (e.g., encrypted drive, trusted sync service, or local network only)."

---

## Future Enhancements (Out of Scope)

- Sync file encryption with separate sync password
- Selective vault sync (choose which vaults to sync)
- Real-time sync via WebSocket/P2P
- Sync history/versioning
- Automatic conflict resolution for text (3-way merge)
