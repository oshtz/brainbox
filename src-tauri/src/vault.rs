// vault.rs - Vault management for brainbox
// Handles creation, encryption, and storage of vaults in SQLite

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use chacha20poly1305::{aead::{Aead, KeyInit}, XChaCha20Poly1305, Key, XNonce};
use rand::{rngs::OsRng, RngCore};
use chrono;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Vault {
    pub id: i64,
    pub name: String,
    pub encrypted_password: Vec<u8>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_image: Option<String>,
    /// Whether the vault is password-protected. If false, the vault can be accessed without a password.
    #[serde(default)]
    pub has_password: bool,
    /// Unique identifier for sync
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Last update timestamp for sync
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Soft delete timestamp for sync
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

impl Vault {
    pub fn create_table(conn: &Connection) -> Result<()> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS vaults (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                encrypted_password BLOB NOT NULL,
                created_at TEXT NOT NULL
            )",
            [],
        )?;
        // Add columns if missing (migration support)
        let mut has_cover = false;
        let mut has_password_col = false;
        let mut has_uuid = false;
        let mut has_updated_at = false;
        let mut has_deleted_at = false;
        let mut stmt = conn.prepare("PRAGMA table_info(vaults)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let col_name: String = row.get(1)?;
            if col_name == "cover_image" { has_cover = true; }
            if col_name == "has_password" { has_password_col = true; }
            if col_name == "uuid" { has_uuid = true; }
            if col_name == "updated_at" { has_updated_at = true; }
            if col_name == "deleted_at" { has_deleted_at = true; }
        }
        if !has_cover {
            let _ = conn.execute("ALTER TABLE vaults ADD COLUMN cover_image TEXT", []);
        }
        if !has_password_col {
            // Default to true for existing vaults (they were created with password encryption)
            let _ = conn.execute("ALTER TABLE vaults ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1", []);
        }
        // Sync-related columns
        if !has_uuid {
            conn.execute("ALTER TABLE vaults ADD COLUMN uuid TEXT", [])?;
            // Create unique index separately (SQLite doesn't support UNIQUE in ALTER TABLE ADD COLUMN)
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_uuid ON vaults(uuid)", [])?;
            // Generate UUIDs for existing vaults
            Self::migrate_generate_uuids(conn)?;
        }
        if !has_updated_at {
            conn.execute("ALTER TABLE vaults ADD COLUMN updated_at TEXT", [])?;
            // Set updated_at to created_at for existing vaults
            conn.execute("UPDATE vaults SET updated_at = created_at WHERE updated_at IS NULL", [])?;
        }
        if !has_deleted_at {
            conn.execute("ALTER TABLE vaults ADD COLUMN deleted_at TEXT", [])?;
        }
        Ok(())
    }

    /// Generate UUIDs for existing vaults that don't have one
    fn migrate_generate_uuids(conn: &Connection) -> Result<()> {
        let mut stmt = conn.prepare("SELECT id FROM vaults WHERE uuid IS NULL")?;
        let ids: Vec<i64> = stmt.query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        for id in ids {
            let new_uuid = Uuid::new_v4().to_string();
            conn.execute("UPDATE vaults SET uuid = ?1 WHERE id = ?2", params![new_uuid, id])?;
        }
        Ok(())
    }

    pub fn insert(conn: &Connection, name: &str, password: &str, key: &[u8; 32], has_password: bool) -> Result<Vault> {
        let (encrypted, has_pw) = if has_password && !password.is_empty() {
            // Encrypt the password using XChaCha20-Poly1305
            let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
            let mut nonce_bytes = [0u8; 24];
            let mut rng = OsRng;
            rng.fill_bytes(&mut nonce_bytes);
            let nonce = XNonce::from_slice(&nonce_bytes);
            let ciphertext = cipher.encrypt(nonce, password.as_bytes())
                .map_err(|_| rusqlite::Error::ExecuteReturnedResults)?;
            let mut enc = nonce_bytes.to_vec();
            enc.extend(ciphertext);
            (enc, true)
        } else {
            // No password protection - store empty vec
            (Vec::new(), false)
        };
        let now = chrono::Utc::now().to_rfc3339();
        let new_uuid = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO vaults (name, encrypted_password, created_at, cover_image, has_password, uuid, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)",
            params![name, encrypted, now, has_pw, new_uuid, now],
        )?;
        let id = conn.last_insert_rowid();
        Ok(Vault {
            id,
            name: name.to_string(),
            encrypted_password: encrypted,
            created_at: now.clone(),
            cover_image: None,
            has_password: has_pw,
            uuid: Some(new_uuid),
            updated_at: Some(now),
            deleted_at: None,
        })
    }

    /// Fetch all non-deleted vaults from the database
    pub fn list(conn: &Connection) -> Result<Vec<Vault>> {
        let mut stmt = conn.prepare("SELECT id, name, encrypted_password, created_at, cover_image, has_password, uuid, updated_at, deleted_at FROM vaults WHERE deleted_at IS NULL ORDER BY created_at DESC")?;
        let vault_iter = stmt.query_map([], |row| {
            Ok(Vault {
                id: row.get(0)?,
                name: row.get(1)?,
                encrypted_password: row.get(2)?,
                created_at: row.get(3)?,
                cover_image: row.get(4).ok(),
                has_password: row.get::<_, i64>(5).unwrap_or(1) != 0, // Default to true for safety
                uuid: row.get(6).ok(),
                updated_at: row.get(7).ok(),
                deleted_at: row.get(8).ok(),
            })
        })?;
        let mut vaults = Vec::new();
        for vault in vault_iter {
            vaults.push(vault?);
        }
        Ok(vaults)
    }

    /// Fetch all vaults including soft-deleted ones (for sync)
    pub fn list_all_for_sync(conn: &Connection) -> Result<Vec<Vault>> {
        let mut stmt = conn.prepare("SELECT id, name, encrypted_password, created_at, cover_image, has_password, uuid, updated_at, deleted_at FROM vaults ORDER BY created_at DESC")?;
        let vault_iter = stmt.query_map([], |row| {
            Ok(Vault {
                id: row.get(0)?,
                name: row.get(1)?,
                encrypted_password: row.get(2)?,
                created_at: row.get(3)?,
                cover_image: row.get(4).ok(),
                has_password: row.get::<_, i64>(5).unwrap_or(1) != 0,
                uuid: row.get(6).ok(),
                updated_at: row.get(7).ok(),
                deleted_at: row.get(8).ok(),
            })
        })?;
        let mut vaults = Vec::new();
        for vault in vault_iter {
            vaults.push(vault?);
        }
        Ok(vaults)
    }

    /// Soft delete a vault and all its items (marks as deleted rather than removing)
    pub fn delete(conn: &Connection, vault_id: i64) -> Result<()> {
        // Ensure tables exist
        Self::create_table(conn)?;
        VaultItem::create_table(conn)?;
        let now = chrono::Utc::now().to_rfc3339();
        // Start a transaction to keep things consistent
        conn.execute("BEGIN IMMEDIATE", [])?;
        // Soft delete items first
        conn.execute("UPDATE vault_items SET deleted_at = ?1 WHERE vault_id = ?2 AND deleted_at IS NULL", params![now, vault_id])?;
        // Then soft delete the vault
        conn.execute("UPDATE vaults SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3", params![now, now, vault_id])?;
        conn.execute("COMMIT", [])?;
        Ok(())
    }

    /// Hard delete a vault and all its items (permanent removal, used for purging)
    pub fn hard_delete(conn: &Connection, vault_id: i64) -> Result<()> {
        Self::create_table(conn)?;
        VaultItem::create_table(conn)?;
        conn.execute("BEGIN IMMEDIATE", [])?;
        conn.execute("DELETE FROM vault_items WHERE vault_id = ?1", [vault_id])?;
        conn.execute("DELETE FROM vaults WHERE id = ?1", [vault_id])?;
        conn.execute("COMMIT", [])?;
        Ok(())
    }

    pub fn rename(conn: &Connection, vault_id: i64, name: &str) -> Result<()> {
        Self::create_table(conn)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE vaults SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now, vault_id],
        )?;
        Ok(())
    }

    pub fn update_cover_image(conn: &Connection, vault_id: i64, cover_image: Option<&str>) -> Result<()> {
        Self::create_table(conn)?;
        let now = chrono::Utc::now().to_rfc3339();
        match cover_image {
            Some(img) => conn.execute(
                "UPDATE vaults SET cover_image = ?1, updated_at = ?2 WHERE id = ?3",
                params![img, now, vault_id],
            )?,
            None => conn.execute(
                "UPDATE vaults SET cover_image = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, vault_id],
            )?,
        };
        Ok(())
    }

    /// Get a vault by its UUID (for sync operations)
    pub fn get_by_uuid(conn: &Connection, uuid: &str) -> Result<Option<Vault>> {
        let mut stmt = conn.prepare("SELECT id, name, encrypted_password, created_at, cover_image, has_password, uuid, updated_at, deleted_at FROM vaults WHERE uuid = ?1")?;
        let mut rows = stmt.query([uuid])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Vault {
                id: row.get(0)?,
                name: row.get(1)?,
                encrypted_password: row.get(2)?,
                created_at: row.get(3)?,
                cover_image: row.get(4).ok(),
                has_password: row.get::<_, i64>(5).unwrap_or(1) != 0,
                uuid: row.get(6).ok(),
                updated_at: row.get(7).ok(),
                deleted_at: row.get(8).ok(),
            }))
        } else {
            Ok(None)
        }
    }

    /// Get a vault by its ID
    pub fn get_by_id(conn: &Connection, vault_id: i64) -> Result<Option<Vault>> {
        let mut stmt = conn.prepare("SELECT id, name, encrypted_password, created_at, cover_image, has_password, uuid, updated_at, deleted_at FROM vaults WHERE id = ?1")?;
        let mut rows = stmt.query([vault_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Vault {
                id: row.get(0)?,
                name: row.get(1)?,
                encrypted_password: row.get(2)?,
                created_at: row.get(3)?,
                cover_image: row.get(4).ok(),
                has_password: row.get::<_, i64>(5).unwrap_or(1) != 0,
                uuid: row.get(6).ok(),
                updated_at: row.get(7).ok(),
                deleted_at: row.get(8).ok(),
            }))
        } else {
            Ok(None)
        }
    }
}

// --- VaultItem struct and impl ---
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultItem {
    pub id: i64,
    pub vault_id: i64,
    pub title: String,
    pub content: Vec<u8>, // encrypted
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    // Optional custom ordering per vault
    // Not all databases will have this yet; we handle migration in create_table
    // by creating the column if missing.
    // When absent, sorting falls back to created_at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<i64>,
    /// Unique identifier for sync
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Soft delete timestamp for sync
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

impl VaultItem {
    pub fn create_table(conn: &Connection) -> Result<()> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS vault_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vault_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                content BLOB NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(vault_id) REFERENCES vaults(id)
            )",
            [],
        )?;
        // Add columns if they do not exist (migration support)
        let mut has_sort_order = false;
        let mut has_image = false;
        let mut has_summary = false;
        let mut has_uuid = false;
        let mut has_deleted_at = false;
        let mut stmt = conn.prepare("PRAGMA table_info(vault_items)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let col_name: String = row.get(1)?;
            if col_name == "sort_order" { has_sort_order = true; }
            if col_name == "image" { has_image = true; }
            if col_name == "summary" { has_summary = true; }
            if col_name == "uuid" { has_uuid = true; }
            if col_name == "deleted_at" { has_deleted_at = true; }
        }
        if !has_sort_order {
            let _ = conn.execute("ALTER TABLE vault_items ADD COLUMN sort_order INTEGER", []);
        }
        if !has_image {
            let _ = conn.execute("ALTER TABLE vault_items ADD COLUMN image TEXT", []);
        }
        if !has_summary {
            let _ = conn.execute("ALTER TABLE vault_items ADD COLUMN summary TEXT", []);
        }
        // Sync-related columns
        if !has_uuid {
            conn.execute("ALTER TABLE vault_items ADD COLUMN uuid TEXT", [])?;
            // Create unique index separately (SQLite doesn't support UNIQUE in ALTER TABLE ADD COLUMN)
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_items_uuid ON vault_items(uuid)", [])?;
            // Generate UUIDs for existing items
            Self::migrate_generate_uuids(conn)?;
        }
        if !has_deleted_at {
            let _ = conn.execute("ALTER TABLE vault_items ADD COLUMN deleted_at TEXT", []);
        }
        Ok(())
    }

    /// Generate UUIDs for existing items that don't have one
    fn migrate_generate_uuids(conn: &Connection) -> Result<()> {
        let mut stmt = conn.prepare("SELECT id FROM vault_items WHERE uuid IS NULL")?;
        let ids: Vec<i64> = stmt.query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        for id in ids {
            let new_uuid = Uuid::new_v4().to_string();
            conn.execute("UPDATE vault_items SET uuid = ?1 WHERE id = ?2", params![new_uuid, id])?;
        }
        Ok(())
    }

    pub fn insert(
        conn: &Connection,
        vault_id: i64,
        title: &str,
        content: &str,
        key: &[u8; 32],
    ) -> Result<VaultItem> {
        use chacha20poly1305::{aead::Aead, XChaCha20Poly1305, Key, XNonce};
        use rand::{rngs::OsRng, RngCore};
        let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
        let mut nonce_bytes = [0u8; 24];
        let mut rng = OsRng;
        rng.fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, content.as_bytes())
            .map_err(|_| rusqlite::Error::ExecuteReturnedResults)?;
        let mut encrypted = nonce_bytes.to_vec();
        encrypted.extend(ciphertext);
        let now = chrono::Utc::now().to_rfc3339();
        let new_uuid = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO vault_items (vault_id, title, content, created_at, updated_at, uuid) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![vault_id, title, encrypted, now, now, new_uuid],
        )?;
        let id = conn.last_insert_rowid();
        // Also update the vault's updated_at timestamp
        conn.execute(
            "UPDATE vaults SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, vault_id],
        )?;
        Ok(VaultItem {
            id,
            vault_id,
            title: title.to_string(),
            content: encrypted,
            created_at: now.clone(),
            updated_at: now,
            image: None,
            summary: None,
            sort_order: None,
            uuid: Some(new_uuid),
            deleted_at: None,
        })
    }

    /// List non-deleted items in a vault
    pub fn list_by_vault(conn: &Connection, vault_id: i64) -> Result<Vec<VaultItem>> {
        let mut stmt = conn.prepare(
            "SELECT id, vault_id, title, content, created_at, updated_at, sort_order, image, summary, uuid, deleted_at \
             FROM vault_items WHERE vault_id = ?1 AND deleted_at IS NULL \
             ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, created_at DESC"
        )?;
        let item_iter = stmt.query_map([vault_id], |row| {
            Ok(VaultItem {
                id: row.get(0)?,
                vault_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                sort_order: row.get(6).ok(),
                image: row.get(7).ok(),
                summary: row.get(8).ok(),
                uuid: row.get(9).ok(),
                deleted_at: row.get(10).ok(),
            })
        })?;
        let mut items = Vec::new();
        for item in item_iter {
            items.push(item?);
        }
        Ok(items)
    }

    /// List all items in a vault including soft-deleted ones (for sync)
    pub fn list_all_by_vault_for_sync(conn: &Connection, vault_id: i64) -> Result<Vec<VaultItem>> {
        let mut stmt = conn.prepare(
            "SELECT id, vault_id, title, content, created_at, updated_at, sort_order, image, summary, uuid, deleted_at \
             FROM vault_items WHERE vault_id = ?1 \
             ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, created_at DESC"
        )?;
        let item_iter = stmt.query_map([vault_id], |row| {
            Ok(VaultItem {
                id: row.get(0)?,
                vault_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                sort_order: row.get(6).ok(),
                image: row.get(7).ok(),
                summary: row.get(8).ok(),
                uuid: row.get(9).ok(),
                deleted_at: row.get(10).ok(),
            })
        })?;
        let mut items = Vec::new();
        for item in item_iter {
            items.push(item?);
        }
        Ok(items)
    }

    /// Soft delete an item (marks as deleted rather than removing)
    pub fn delete(conn: &Connection, item_id: i64) -> Result<usize> {
        let now = chrono::Utc::now().to_rfc3339();
        // Get vault_id first so we can update the vault's updated_at
        let vault_id: Option<i64> = conn
            .query_row("SELECT vault_id FROM vault_items WHERE id = ?1", [item_id], |row| row.get(0))
            .ok();
        let affected = conn.execute(
            "UPDATE vault_items SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![now, now, item_id]
        )?;
        // Update vault's updated_at timestamp
        if let Some(vid) = vault_id {
            conn.execute("UPDATE vaults SET updated_at = ?1 WHERE id = ?2", params![now, vid])?;
        }
        Ok(affected)
    }

    /// Hard delete an item (permanent removal, used for purging)
    pub fn hard_delete(conn: &Connection, item_id: i64) -> Result<usize> {
        let affected = conn.execute("DELETE FROM vault_items WHERE id = ?1", [item_id])?;
        Ok(affected)
    }

    pub fn update_summary(conn: &Connection, item_id: i64, summary: &str) -> Result<()> {
        Self::create_table(conn)?;
        let now = chrono::Utc::now().to_rfc3339();
        // Get vault_id to update its updated_at
        let vault_id: Option<i64> = conn
            .query_row("SELECT vault_id FROM vault_items WHERE id = ?1", [item_id], |row| row.get(0))
            .ok();
        conn.execute(
            "UPDATE vault_items SET summary = ?1, updated_at = ?2 WHERE id = ?3",
            params![summary, now, item_id],
        )?;
        if let Some(vid) = vault_id {
            conn.execute("UPDATE vaults SET updated_at = ?1 WHERE id = ?2", params![now, vid])?;
        }
        Ok(())
    }

    pub fn update_order(conn: &Connection, vault_id: i64, ordered_ids: &[i64]) -> Result<()> {
        // Ensure table has sort_order
        Self::create_table(conn)?;
        let now = chrono::Utc::now().to_rfc3339();
        // Manual transaction using SQL to avoid requiring &mut Connection
        conn.execute("BEGIN IMMEDIATE", [])?;
        for (idx, item_id) in ordered_ids.iter().enumerate() {
            if let Err(e) = conn.execute(
                "UPDATE vault_items SET sort_order = ?1, updated_at = ?2 WHERE id = ?3 AND vault_id = ?4",
                rusqlite::params![idx as i64, now, item_id, vault_id],
            ) {
                // attempt rollback then return error
                let _ = conn.execute("ROLLBACK", []);
                return Err(e);
            }
        }
        // Update vault's updated_at
        conn.execute("UPDATE vaults SET updated_at = ?1 WHERE id = ?2", params![now, vault_id])?;
        conn.execute("COMMIT", [])?;
        Ok(())
    }

    pub fn update_title(conn: &Connection, item_id: i64, title: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        // Get vault_id to update its updated_at
        let vault_id: Option<i64> = conn
            .query_row("SELECT vault_id FROM vault_items WHERE id = ?1", [item_id], |row| row.get(0))
            .ok();
        conn.execute(
            "UPDATE vault_items SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![title, now, item_id],
        )?;
        if let Some(vid) = vault_id {
            conn.execute("UPDATE vaults SET updated_at = ?1 WHERE id = ?2", params![now, vid])?;
        }
        Ok(())
    }

    pub fn update_content(conn: &Connection, item_id: i64, content: &str, key: &[u8; 32]) -> Result<()> {
        use chacha20poly1305::{aead::Aead, XChaCha20Poly1305, Key, XNonce};
        use rand::{rngs::OsRng, RngCore};
        let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
        let mut nonce_bytes = [0u8; 24];
        let mut rng = OsRng;
        rng.fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, content.as_bytes())
            .map_err(|_| rusqlite::Error::ExecuteReturnedResults)?;
        let mut encrypted = nonce_bytes.to_vec();
        encrypted.extend(ciphertext);
        let now = chrono::Utc::now().to_rfc3339();
        // Get vault_id to update its updated_at
        let vault_id: Option<i64> = conn
            .query_row("SELECT vault_id FROM vault_items WHERE id = ?1", [item_id], |row| row.get(0))
            .ok();
        conn.execute(
            "UPDATE vault_items SET content = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![encrypted, now, item_id],
        )?;
        if let Some(vid) = vault_id {
            conn.execute("UPDATE vaults SET updated_at = ?1 WHERE id = ?2", params![now, vid])?;
        }
        Ok(())
    }

    pub fn move_to_vault(conn: &Connection, item_id: i64, target_vault_id: i64) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        // Get original vault_id to update its updated_at
        let source_vault_id: Option<i64> = conn
            .query_row("SELECT vault_id FROM vault_items WHERE id = ?1", [item_id], |row| row.get(0))
            .ok();
        conn.execute(
            "UPDATE vault_items SET vault_id = ?1, sort_order = NULL, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![target_vault_id, now, item_id],
        )?;
        // Update both source and target vault's updated_at
        if let Some(vid) = source_vault_id {
            conn.execute("UPDATE vaults SET updated_at = ?1 WHERE id = ?2", params![now, vid])?;
        }
        conn.execute("UPDATE vaults SET updated_at = ?1 WHERE id = ?2", params![now, target_vault_id])?;
        Ok(())
    }

    pub fn update_image(conn: &Connection, item_id: i64, image: Option<&str>) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        // Get vault_id to update its updated_at
        let vault_id: Option<i64> = conn
            .query_row("SELECT vault_id FROM vault_items WHERE id = ?1", [item_id], |row| row.get(0))
            .ok();
        match image {
            Some(img) => conn.execute(
                "UPDATE vault_items SET image = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![img, now, item_id],
            )?,
            None => conn.execute(
                "UPDATE vault_items SET image = NULL, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, item_id],
            )?,
        };
        if let Some(vid) = vault_id {
            conn.execute("UPDATE vaults SET updated_at = ?1 WHERE id = ?2", params![now, vid])?;
        }
        Ok(())
    }

    pub fn get_by_id(conn: &Connection, item_id: i64) -> Result<VaultItem> {
        let mut stmt = conn.prepare(
            "SELECT id, vault_id, title, content, created_at, updated_at, sort_order, image, summary, uuid, deleted_at FROM vault_items WHERE id = ?1"
        )?;
        let mut rows = stmt.query([item_id])?;
        if let Some(row) = rows.next()? {
            Ok(VaultItem {
                id: row.get(0)?,
                vault_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                sort_order: row.get(6).ok(),
                image: row.get(7).ok(),
                summary: row.get(8).ok(),
                uuid: row.get(9).ok(),
                deleted_at: row.get(10).ok(),
            })
        } else {
            Err(rusqlite::Error::QueryReturnedNoRows)
        }
    }

    /// Get an item by its UUID (for sync operations)
    pub fn get_by_uuid(conn: &Connection, uuid: &str) -> Result<Option<VaultItem>> {
        let mut stmt = conn.prepare(
            "SELECT id, vault_id, title, content, created_at, updated_at, sort_order, image, summary, uuid, deleted_at FROM vault_items WHERE uuid = ?1"
        )?;
        let mut rows = stmt.query([uuid])?;
        if let Some(row) = rows.next()? {
            Ok(Some(VaultItem {
                id: row.get(0)?,
                vault_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                sort_order: row.get(6).ok(),
                image: row.get(7).ok(),
                summary: row.get(8).ok(),
                uuid: row.get(9).ok(),
                deleted_at: row.get(10).ok(),
            }))
        } else {
            Ok(None)
        }
    }
}

// --- SyncSettings table and helpers ---
pub struct SyncSettings;

impl SyncSettings {
    pub fn create_table(conn: &Connection) -> Result<()> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sync_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )",
            [],
        )?;
        Ok(())
    }

    pub fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
        Self::create_table(conn)?;
        let mut stmt = conn.prepare("SELECT value FROM sync_settings WHERE key = ?1")?;
        let mut rows = stmt.query([key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
        Self::create_table(conn)?;
        conn.execute(
            "INSERT OR REPLACE INTO sync_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete(conn: &Connection, key: &str) -> Result<()> {
        Self::create_table(conn)?;
        conn.execute("DELETE FROM sync_settings WHERE key = ?1", [key])?;
        Ok(())
    }

    /// Get all sync settings as key-value pairs
    pub fn get_all(conn: &Connection) -> Result<Vec<(String, String)>> {
        Self::create_table(conn)?;
        let mut stmt = conn.prepare("SELECT key, value FROM sync_settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        let mut settings = Vec::new();
        for row in rows {
            settings.push(row?);
        }
        Ok(settings)
    }
}
