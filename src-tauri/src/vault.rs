// vault.rs - Vault management for brainbox
// Handles creation, encryption, and storage of vaults in SQLite

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use chacha20poly1305::{aead::{Aead, KeyInit}, XChaCha20Poly1305, Key, XNonce};
use rand::{rngs::OsRng, RngCore};
use chrono;

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
        // Add cover_image and has_password columns if missing
        let mut has_cover = false;
        let mut has_password_col = false;
        let mut stmt = conn.prepare("PRAGMA table_info(vaults)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let col_name: String = row.get(1)?;
            if col_name == "cover_image" { has_cover = true; }
            if col_name == "has_password" { has_password_col = true; }
        }
        if !has_cover {
            let _ = conn.execute("ALTER TABLE vaults ADD COLUMN cover_image TEXT", []);
        }
        if !has_password_col {
            // Default to true for existing vaults (they were created with password encryption)
            let _ = conn.execute("ALTER TABLE vaults ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1", []);
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
        conn.execute(
            "INSERT INTO vaults (name, encrypted_password, created_at, cover_image, has_password) VALUES (?1, ?2, ?3, NULL, ?4)",
            params![name, encrypted, now, has_pw],
        )?;
        let id = conn.last_insert_rowid();
        Ok(Vault {
            id,
            name: name.to_string(),
            encrypted_password: encrypted,
            created_at: now,
            cover_image: None,
            has_password: has_pw,
        })
    }

    // Fetch all vaults from the database
    pub fn list(conn: &Connection) -> Result<Vec<Vault>> {
        let mut stmt = conn.prepare("SELECT id, name, encrypted_password, created_at, cover_image, has_password FROM vaults ORDER BY created_at DESC")?;
        let vault_iter = stmt.query_map([], |row| {
            Ok(Vault {
                id: row.get(0)?,
                name: row.get(1)?,
                encrypted_password: row.get(2)?,
                created_at: row.get(3)?,
                cover_image: row.get(4).ok(),
                has_password: row.get::<_, i64>(5).unwrap_or(1) != 0, // Default to true for safety
            })
        })?;
        let mut vaults = Vec::new();
        for vault in vault_iter {
            vaults.push(vault?);
        }
        Ok(vaults)
    }

    // Delete a vault and all its items
    pub fn delete(conn: &Connection, vault_id: i64) -> Result<()> {
        // Ensure tables exist
        Self::create_table(conn)?;
        VaultItem::create_table(conn)?;
        // Start a transaction to keep things consistent
        conn.execute("BEGIN IMMEDIATE", [])?;
        // Delete items first
        conn.execute("DELETE FROM vault_items WHERE vault_id = ?1", [vault_id])?;
        // Then delete the vault
        conn.execute("DELETE FROM vaults WHERE id = ?1", [vault_id])?;
        conn.execute("COMMIT", [])?;
        Ok(())
    }

    pub fn rename(conn: &Connection, vault_id: i64, name: &str) -> Result<()> {
        Self::create_table(conn)?;
        conn.execute(
            "UPDATE vaults SET name = ?1 WHERE id = ?2",
            params![name, vault_id],
        )?;
        Ok(())
    }

    pub fn update_cover_image(conn: &Connection, vault_id: i64, cover_image: Option<&str>) -> Result<()> {
        Self::create_table(conn)?;
        match cover_image {
            Some(img) => conn.execute(
                "UPDATE vaults SET cover_image = ?1 WHERE id = ?2",
                params![img, vault_id],
            )?,
            None => conn.execute(
                "UPDATE vaults SET cover_image = NULL WHERE id = ?1",
                params![vault_id],
            )?,
        };
        Ok(())
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
        // Add sort_order, image, and summary columns if they do not exist
        let mut has_sort_order = false;
        let mut has_image = false;
        let mut has_summary = false;
        let mut stmt = conn.prepare("PRAGMA table_info(vault_items)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let col_name: String = row.get(1)?;
            if col_name == "sort_order" { has_sort_order = true; }
            if col_name == "image" { has_image = true; }
            if col_name == "summary" { has_summary = true; }
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
        conn.execute(
            "INSERT INTO vault_items (vault_id, title, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![vault_id, title, encrypted, now, now],
        )?;
        let id = conn.last_insert_rowid();
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
        })
    }

    pub fn list_by_vault(conn: &Connection, vault_id: i64) -> Result<Vec<VaultItem>> {
        let mut stmt = conn.prepare(
            "SELECT id, vault_id, title, content, created_at, updated_at, sort_order, image, summary \
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
            })
        })?;
        let mut items = Vec::new();
        for item in item_iter {
            items.push(item?);
        }
        Ok(items)
    }

    pub fn delete(conn: &Connection, item_id: i64) -> Result<usize> {
        let affected = conn.execute("DELETE FROM vault_items WHERE id = ?1", [item_id])?;
        Ok(affected)
    }

    pub fn update_summary(conn: &Connection, item_id: i64, summary: &str) -> Result<()> {
        Self::create_table(conn)?;
        conn.execute(
            "UPDATE vault_items SET summary = ?1, updated_at = ?2 WHERE id = ?3",
            params![summary, chrono::Utc::now().to_rfc3339(), item_id],
        )?;
        Ok(())
    }

    pub fn update_order(conn: &Connection, vault_id: i64, ordered_ids: &[i64]) -> Result<()> {
        // Ensure table has sort_order
        Self::create_table(conn)?;
        // Manual transaction using SQL to avoid requiring &mut Connection
        conn.execute("BEGIN IMMEDIATE", [])?;
        for (idx, item_id) in ordered_ids.iter().enumerate() {
            if let Err(e) = conn.execute(
                "UPDATE vault_items SET sort_order = ?1 WHERE id = ?2 AND vault_id = ?3",
                rusqlite::params![idx as i64, item_id, vault_id],
            ) {
                // attempt rollback then return error
                let _ = conn.execute("ROLLBACK", []);
                return Err(e);
            }
        }
        conn.execute("COMMIT", [])?;
        Ok(())
    }

    pub fn update_title(conn: &Connection, item_id: i64, title: &str) -> Result<()> {
        conn.execute(
            "UPDATE vault_items SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![title, chrono::Utc::now().to_rfc3339(), item_id],
        )?;
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
        conn.execute(
            "UPDATE vault_items SET content = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![encrypted, chrono::Utc::now().to_rfc3339(), item_id],
        )?;
        Ok(())
    }

    pub fn move_to_vault(conn: &Connection, item_id: i64, target_vault_id: i64) -> Result<()> {
        conn.execute(
            "UPDATE vault_items SET vault_id = ?1, sort_order = NULL, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![target_vault_id, chrono::Utc::now().to_rfc3339(), item_id],
        )?;
        Ok(())
    }

    pub fn update_image(conn: &Connection, item_id: i64, image: Option<&str>) -> Result<()> {
        match image {
            Some(img) => conn.execute(
                "UPDATE vault_items SET image = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![img, chrono::Utc::now().to_rfc3339(), item_id],
            )?,
            None => conn.execute(
                "UPDATE vault_items SET image = NULL, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![chrono::Utc::now().to_rfc3339(), item_id],
            )?,
        };
        Ok(())
    }

    pub fn get_by_id(conn: &Connection, item_id: i64) -> Result<VaultItem> {
        let mut stmt = conn.prepare(
            "SELECT id, vault_id, title, content, created_at, updated_at, sort_order, image, summary FROM vault_items WHERE id = ?1"
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
            })
        } else {
            Err(rusqlite::Error::QueryReturnedNoRows)
        }
    }
}
