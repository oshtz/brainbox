use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;

use crate::paths::brainbox_db_path;
use crate::vault::{Vault, VaultItem};

#[tauri::command]
pub fn create_vault(
    name: String,
    password: String,
    has_password: Option<bool>,
) -> Result<Vault, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;

    // Determine if this vault should have password protection
    // Default to false (no password) if not specified
    let should_have_password = has_password.unwrap_or(false) && !password.is_empty();

    let now = chrono::Utc::now().to_rfc3339();
    let new_uuid = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO vaults (name, encrypted_password, created_at, cover_image, has_password, uuid, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)",
        rusqlite::params![name, Vec::<u8>::new(), now, should_have_password, new_uuid, now],
    ).map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();

    let encrypted = if should_have_password {
        let key = derive_key_from_password(&password, &id.to_string(), 100_000);
        let enc = encrypt_password(&key, &password)?;
        conn.execute(
            "UPDATE vaults SET encrypted_password = ?1 WHERE id = ?2",
            rusqlite::params![enc.clone(), id],
        )
        .map_err(|e| e.to_string())?;
        enc
    } else {
        Vec::new()
    };

    Ok(Vault {
        id,
        name,
        encrypted_password: encrypted,
        created_at: now.clone(),
        cover_image: None,
        has_password: should_have_password,
        uuid: Some(new_uuid),
        updated_at: Some(now),
        deleted_at: None,
    })
}

#[tauri::command]
pub fn list_vaults() -> Result<Vec<Vault>, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    Vault::list(&conn).map_err(|e| e.to_string())
}

// --- Add Tauri commands for vault items ---
// use crate::vault::Vault as VaultModel; // unused

#[tauri::command]
pub fn add_vault_item(
    vault_id: i64,
    title: String,
    content: String,
    key: Vec<u8>,
) -> Result<VaultItem, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 {
        return Err("Key must be 32 bytes".to_string());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    let item =
        VaultItem::insert(&conn, vault_id, &title, &content, &arr).map_err(|e| e.to_string())?;
    // Best-effort: index in search immediately
    let item_type = if content.starts_with("http://") || content.starts_with("https://") {
        "url"
    } else {
        "note"
    };
    let _ = crate::search::index_document(
        item.id.to_string(),
        title.clone(),
        content.clone(),
        item_type.to_string(),
        item.created_at.clone(),
        item.updated_at.clone(),
        Some(format!("vault/{}/item/{}", vault_id, item.id)),
        vec![],
    );
    Ok(item)
}

#[derive(serde::Serialize)]
pub struct VaultItemOut {
    id: i64,
    vault_id: i64,
    title: String,
    content: String,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[allow(dead_code)]
    #[serde(skip_serializing_if = "Option::is_none")]
    sort_order: Option<i64>,
}

fn decrypt_content(key: &[u8; 32], encrypted: &[u8]) -> Result<String, String> {
    use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
    if encrypted.len() < 24 {
        return Err("Invalid ciphertext".into());
    }
    let mut nonce_bytes = [0u8; 24];
    nonce_bytes.copy_from_slice(&encrypted[..24]);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = cipher
        .decrypt(nonce, &encrypted[24..])
        .map_err(|_| "Decryption failed".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "Invalid UTF-8".to_string())
}

fn derive_key_from_password(password: &str, salt: &str, iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt.as_bytes(), iterations, &mut key);
    key
}

fn encrypt_password(key: &[u8; 32], password: &str) -> Result<Vec<u8>, String> {
    use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce_bytes = [0u8; 24];
    let mut rng = OsRng;
    rng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, password.as_bytes())
        .map_err(|_| "Encryption failed".to_string())?;
    let mut encrypted = nonce_bytes.to_vec();
    encrypted.extend(ciphertext);
    Ok(encrypted)
}

/// Check if a vault has password protection
fn vault_has_password(conn: &rusqlite::Connection, vault_id: i64) -> Result<bool, String> {
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT has_password FROM vaults WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let has_pw: i64 = match stmt.query_row([vault_id], |row| row.get(0)) {
        Ok(val) => val,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Err("Vault not found".to_string()),
        Err(e) => return Err(e.to_string()),
    };
    Ok(has_pw != 0)
}

fn verify_vault_key(
    conn: &rusqlite::Connection,
    vault_id: i64,
    key: &[u8; 32],
) -> Result<(), String> {
    Vault::create_table(conn).map_err(|e| e.to_string())?;

    // Check if vault has password protection
    if !vault_has_password(conn, vault_id)? {
        // No password protection - skip verification
        return Ok(());
    }

    let mut stmt = conn
        .prepare("SELECT encrypted_password FROM vaults WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let encrypted: Vec<u8> = match stmt.query_row([vault_id], |row| row.get(0)) {
        Ok(val) => val,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Err("Vault not found".to_string()),
        Err(e) => return Err(e.to_string()),
    };
    decrypt_content(key, &encrypted)
        .map(|_| ())
        .map_err(|_| "Invalid password".to_string())
}

#[tauri::command]
pub fn verify_vault_password(vault_id: i64, key: Vec<u8>) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 {
        return Err("Key must be 32 bytes".into());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    verify_vault_key(&conn, vault_id, &arr)?;
    Ok(())
}

#[tauri::command]
pub fn list_vault_items(vault_id: i64, key: Vec<u8>) -> Result<Vec<VaultItemOut>, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 {
        return Err("Key must be 32 bytes".into());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    verify_vault_key(&conn, vault_id, &arr)?;
    let items = VaultItem::list_by_vault(&conn, vault_id).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(items.len());
    for it in items.into_iter() {
        let content = decrypt_content(&arr, &it.content)?;
        out.push(VaultItemOut {
            id: it.id,
            vault_id: it.vault_id,
            title: it.title,
            content,
            created_at: it.created_at,
            updated_at: it.updated_at,
            image: it.image,
            summary: it.summary,
            sort_order: it.sort_order,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn get_vault_item(item_id: i64, key: Vec<u8>) -> Result<VaultItemOut, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    crate::vault::VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 {
        return Err("Key must be 32 bytes".into());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    let it = crate::vault::VaultItem::get_by_id(&conn, item_id).map_err(|e| e.to_string())?;
    let content = decrypt_content(&arr, &it.content)?;
    Ok(VaultItemOut {
        id: it.id,
        vault_id: it.vault_id,
        title: it.title,
        content,
        created_at: it.created_at,
        updated_at: it.updated_at,
        image: it.image,
        summary: it.summary,
        sort_order: it.sort_order,
    })
}

#[tauri::command]
pub fn delete_vault(vault_id: i64) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::delete(&conn, vault_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_vault(vault_id: i64, name: String) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::rename(&conn, vault_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_vault_cover(vault_id: i64, cover_image: Option<String>) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::update_cover_image(&conn, vault_id, cover_image.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_vault_item(item_id: i64) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::delete(&conn, item_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_vault_items_order(vault_id: i64, ordered_ids: Vec<i64>) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::update_order(&conn, vault_id, &ordered_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_vault_item_title(item_id: i64, title: String) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::update_title(&conn, item_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_vault_item(item_id: i64, target_vault_id: i64) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::move_to_vault(&conn, item_id, target_vault_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_vault_item_image(item_id: i64, image: Option<String>) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::update_image(&conn, item_id, image.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_vault_item_content(
    item_id: i64,
    content: String,
    key: Vec<u8>,
) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    crate::vault::VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 {
        return Err("Key must be 32 bytes".into());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    crate::vault::VaultItem::update_content(&conn, item_id, &content, &arr)
        .map_err(|e| e.to_string())?;
    // Best-effort: update search index
    let it = crate::vault::VaultItem::get_by_id(&conn, item_id).map_err(|e| e.to_string())?;
    let item_type = if content.starts_with("http://") || content.starts_with("https://") {
        "url"
    } else {
        "note"
    };
    let _ = crate::search::index_document(
        item_id.to_string(),
        it.title.clone(),
        content.clone(),
        item_type.to_string(),
        it.created_at.clone(),
        it.updated_at.clone(),
        Some(format!("vault/{}/item/{}", it.vault_id, item_id)),
        vec![],
    );
    Ok(())
}

#[tauri::command]
pub fn update_vault_item_summary(item_id: i64, summary: String) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::update_summary(&conn, item_id, &summary).map_err(|e| e.to_string())
}

/// Export vault data structure
#[derive(serde::Serialize, serde::Deserialize)]
struct ExportedVault {
    name: String,
    created_at: String,
    cover_image: Option<String>,
    items: Vec<ExportedItem>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ExportedItem {
    title: String,
    content: String, // plaintext content
    created_at: String,
    updated_at: String,
    image: Option<String>,
    summary: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ExportData {
    version: String,
    exported_at: String,
    vaults: Vec<ExportedVault>,
}

/// Export vaults to JSON (decrypts all items)
#[tauri::command]
pub fn export_vaults(vault_ids: Vec<i64>, keys: Vec<Vec<u8>>) -> Result<String, String> {
    if vault_ids.len() != keys.len() {
        return Err("Vault IDs and keys must have the same length".to_string());
    }

    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;

    let mut exported_vaults = Vec::new();

    for (vault_id, key) in vault_ids.iter().zip(keys.iter()) {
        if key.len() != 32 {
            return Err(format!("Key for vault {} must be 32 bytes", vault_id));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(key);

        // Get vault info
        let mut stmt = conn
            .prepare("SELECT name, created_at, cover_image FROM vaults WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let (name, created_at, cover_image): (String, String, Option<String>) = stmt
            .query_row([vault_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2).ok()))
            })
            .map_err(|e| e.to_string())?;

        // Get and decrypt items
        let items = VaultItem::list_by_vault(&conn, *vault_id).map_err(|e| e.to_string())?;
        let mut exported_items = Vec::new();

        for item in items {
            let content = decrypt_content(&arr, &item.content)?;
            exported_items.push(ExportedItem {
                title: item.title,
                content,
                created_at: item.created_at,
                updated_at: item.updated_at,
                image: item.image,
                summary: item.summary,
            });
        }

        exported_vaults.push(ExportedVault {
            name,
            created_at,
            cover_image,
            items: exported_items,
        });
    }

    let export_data = ExportData {
        version: "1.0".to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        vaults: exported_vaults,
    };

    serde_json::to_string_pretty(&export_data).map_err(|e| e.to_string())
}

/// Import vaults from JSON
#[tauri::command]
pub fn import_vaults(json_data: String, password: String) -> Result<Vec<i64>, String> {
    let export_data: ExportData =
        serde_json::from_str(&json_data).map_err(|e| format!("Invalid export format: {}", e))?;

    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;

    let mut imported_vault_ids = Vec::new();

    for vault in export_data.vaults {
        // Create new vault with UUID
        let now = chrono::Utc::now().to_rfc3339();
        let new_uuid = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO vaults (name, encrypted_password, created_at, cover_image, uuid, updated_at, has_password) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            rusqlite::params![vault.name, Vec::<u8>::new(), now, vault.cover_image, new_uuid, now],
        ).map_err(|e| e.to_string())?;

        let vault_id = conn.last_insert_rowid();
        imported_vault_ids.push(vault_id);

        // Derive key for this vault
        let key = derive_key_from_password(&password, &vault_id.to_string(), 100_000);

        // Encrypt and store password verification
        let encrypted_password = encrypt_password(&key, &password)?;
        conn.execute(
            "UPDATE vaults SET encrypted_password = ?1 WHERE id = ?2",
            rusqlite::params![encrypted_password, vault_id],
        )
        .map_err(|e| e.to_string())?;

        // Import items
        for item in vault.items {
            // Encrypt content
            use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
            let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
            let mut nonce_bytes = [0u8; 24];
            OsRng.fill_bytes(&mut nonce_bytes);
            let nonce = XNonce::from_slice(&nonce_bytes);
            let ciphertext = cipher
                .encrypt(nonce, item.content.as_bytes())
                .map_err(|_| "Encryption failed".to_string())?;
            let mut encrypted = nonce_bytes.to_vec();
            encrypted.extend(ciphertext);

            let item_uuid = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO vault_items (vault_id, title, content, created_at, updated_at, image, summary, uuid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    vault_id,
                    item.title,
                    encrypted,
                    item.created_at,
                    item.updated_at,
                    item.image,
                    item.summary,
                    item_uuid
                ],
            ).map_err(|e| e.to_string())?;
        }
    }

    Ok(imported_vault_ids)
}

/// Change vault password: re-encrypts all items with the new key
/// If new_has_password is false, the vault will have password protection removed
#[tauri::command]
pub fn change_vault_password(
    vault_id: i64,
    old_key: Vec<u8>,
    new_password: String,
    new_has_password: Option<bool>,
) -> Result<(), String> {
    if old_key.len() != 32 {
        return Err("Old key must be 32 bytes".to_string());
    }
    let mut old_arr = [0u8; 32];
    old_arr.copy_from_slice(&old_key);

    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;

    // Verify old key works
    verify_vault_key(&conn, vault_id, &old_arr)?;

    // Determine if new vault should have password protection
    let should_have_password =
        new_has_password.unwrap_or(!new_password.is_empty()) && !new_password.is_empty();

    // Derive new key from new password (empty string if no password)
    let new_key = derive_key_from_password(&new_password, &vault_id.to_string(), 100_000);

    // Get all items for this vault
    let items = VaultItem::list_by_vault(&conn, vault_id).map_err(|e| e.to_string())?;

    // Start transaction
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;

    // Re-encrypt each item
    for item in items {
        // Decrypt with old key
        let plaintext = decrypt_content(&old_arr, &item.content)?;

        // Re-encrypt with new key
        use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&new_key));
        let mut nonce_bytes = [0u8; 24];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|_| "Re-encryption failed".to_string())?;
        let mut encrypted = nonce_bytes.to_vec();
        encrypted.extend(ciphertext);

        // Update item content
        conn.execute(
            "UPDATE vault_items SET content = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![encrypted, chrono::Utc::now().to_rfc3339(), item.id],
        )
        .map_err(|e| {
            let _ = conn.execute("ROLLBACK", []);
            e.to_string()
        })?;
    }

    // Update vault's encrypted_password and has_password flag
    let (new_encrypted_password, new_has_pw) = if should_have_password {
        (encrypt_password(&new_key, &new_password)?, true)
    } else {
        (Vec::new(), false)
    };

    conn.execute(
        "UPDATE vaults SET encrypted_password = ?1, has_password = ?2 WHERE id = ?3",
        rusqlite::params![new_encrypted_password, new_has_pw, vault_id],
    )
    .map_err(|e| {
        let _ = conn.execute("ROLLBACK", []);
        e.to_string()
    })?;

    // Commit transaction
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;

    Ok(())
}
