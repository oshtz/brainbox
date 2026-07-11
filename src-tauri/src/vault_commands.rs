use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;

use crate::paths::open_brainbox_db;
use crate::vault::{Vault, VaultItem};

#[tauri::command]
pub fn create_vault(
    name: String,
    password: String,
    has_password: Option<bool>,
) -> Result<Vault, String> {
    let conn = open_brainbox_db()?;
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
    let conn = open_brainbox_db()?;
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
    let conn = open_brainbox_db()?;
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
        let expected = derive_key_from_password("", &vault_id.to_string(), 100_000);
        return if key == &expected {
            Ok(())
        } else {
            Err("Invalid vault key".to_string())
        };
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
    let conn = open_brainbox_db()?;
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
    let conn = open_brainbox_db()?;
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
    let conn = open_brainbox_db()?;
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
    let conn = open_brainbox_db()?;
    Vault::delete(&conn, vault_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_vault(vault_id: i64, name: String) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    Vault::rename(&conn, vault_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_vault_cover(vault_id: i64, cover_image: Option<String>) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    Vault::update_cover_image(&conn, vault_id, cover_image.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_vault_item(item_id: i64) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::delete(&conn, item_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_vault_items_order(vault_id: i64, ordered_ids: Vec<i64>) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    VaultItem::update_order(&conn, vault_id, &ordered_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_vault_item_title(item_id: i64, title: String) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    VaultItem::update_title(&conn, item_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_vault_item(
    item_id: i64,
    target_vault_id: i64,
    source_key: Vec<u8>,
    target_key: Vec<u8>,
) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    move_vault_item_with_conn(&conn, item_id, target_vault_id, source_key, target_key)
}

fn move_vault_item_with_conn(
    conn: &rusqlite::Connection,
    item_id: i64,
    target_vault_id: i64,
    source_key: Vec<u8>,
    target_key: Vec<u8>,
) -> Result<(), String> {
    let source_key = key_array(source_key)?;
    let target_key = key_array(target_key)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let item = VaultItem::get_by_id(&tx, item_id).map_err(|e| e.to_string())?;
    verify_vault_key(&tx, item.vault_id, &source_key)?;
    verify_vault_key(&tx, target_vault_id, &target_key)?;
    VaultItem::move_to_vault(&tx, item_id, target_vault_id, &source_key, &target_key)
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn key_array(key: Vec<u8>) -> Result<[u8; 32], String> {
    key.try_into()
        .map_err(|_| "Key must be 32 bytes".to_string())
}

#[tauri::command]
pub fn update_vault_item_image(item_id: i64, image: Option<String>) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::update_image(&conn, item_id, image.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_vault_item_content(
    item_id: i64,
    content: String,
    key: Vec<u8>,
) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    let it = update_vault_item_content_with_conn(&conn, item_id, &content, key)?;
    // Best-effort: update search index after the database commit.
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

fn update_vault_item_content_with_conn(
    conn: &rusqlite::Connection,
    item_id: i64,
    content: &str,
    key: Vec<u8>,
) -> Result<VaultItem, String> {
    let arr = key_array(key)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let it = VaultItem::get_by_id(&tx, item_id).map_err(|e| e.to_string())?;
    verify_vault_key(&tx, it.vault_id, &arr)?;
    VaultItem::update_content(&tx, item_id, content, &arr).map_err(|e| e.to_string())?;
    let it = VaultItem::get_by_id(&tx, item_id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(it)
}

#[tauri::command]
pub fn update_vault_item_summary(item_id: i64, summary: String) -> Result<(), String> {
    let conn = open_brainbox_db()?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::update_summary(&conn, item_id, &summary).map_err(|e| e.to_string())
}

/// Export vault data structure
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct ExportedVault {
    name: String,
    created_at: String,
    cover_image: Option<String>,
    items: Vec<ExportedItem>,
}

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct ExportedItem {
    title: String,
    content: String, // plaintext content
    created_at: String,
    updated_at: String,
    image: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct ExportData {
    version: String,
    exported_at: String,
    vaults: Vec<ExportedVault>,
}

const BACKUP_FORMAT_VERSION: &str = "2.0";
const BACKUP_KDF_ITERATIONS: u32 = 200_000;

#[derive(serde::Serialize, serde::Deserialize)]
struct EncryptedBackupEnvelope {
    format_version: String,
    encryption: String,
    kdf: String,
    kdf_iterations: u32,
    exported_at: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

fn backup_bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn backup_hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("Invalid encrypted backup payload".into());
    }
    (0..hex.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&hex[index..index + 2], 16)
                .map_err(|_| "Invalid encrypted backup payload".to_string())
        })
        .collect()
}

fn backup_key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, iterations, &mut key);
    key
}

fn encrypt_backup(data: &ExportData, passphrase: &str) -> Result<String, String> {
    use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};

    if passphrase.trim().is_empty() {
        return Err("A backup passphrase is required".into());
    }
    let plaintext = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_bytes);
    let key = backup_key(passphrase, &salt, BACKUP_KDF_ITERATIONS);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce_bytes), plaintext.as_slice())
        .map_err(|_| "Failed to encrypt backup".to_string())?;
    let envelope = EncryptedBackupEnvelope {
        format_version: BACKUP_FORMAT_VERSION.into(),
        encryption: "XChaCha20-Poly1305".into(),
        kdf: "PBKDF2-HMAC-SHA256".into(),
        kdf_iterations: BACKUP_KDF_ITERATIONS,
        exported_at: data.exported_at.clone(),
        salt: backup_bytes_to_hex(&salt),
        nonce: backup_bytes_to_hex(&nonce_bytes),
        ciphertext: backup_bytes_to_hex(&ciphertext),
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
}

fn decrypt_backup(json: &str, passphrase: &str) -> Result<ExportData, String> {
    use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};

    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid backup format: {e}"))?;
    if value.get("ciphertext").is_none() {
        // One-time compatibility path for exports created by older versions.
        return serde_json::from_value(value).map_err(|e| format!("Invalid export format: {e}"));
    }
    if passphrase.trim().is_empty() {
        return Err("Backup passphrase is required".into());
    }
    let envelope: EncryptedBackupEnvelope =
        serde_json::from_value(value).map_err(|e| format!("Invalid encrypted backup: {e}"))?;
    if envelope.format_version != BACKUP_FORMAT_VERSION
        || envelope.encryption != "XChaCha20-Poly1305"
        || envelope.kdf != "PBKDF2-HMAC-SHA256"
    {
        return Err("Unsupported encrypted backup format".into());
    }
    let salt = backup_hex_to_bytes(&envelope.salt)?;
    let nonce = backup_hex_to_bytes(&envelope.nonce)?;
    let ciphertext = backup_hex_to_bytes(&envelope.ciphertext)?;
    if nonce.len() != 24 {
        return Err("Invalid encrypted backup nonce".into());
    }
    let key = backup_key(passphrase, &salt, envelope.kdf_iterations);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|_| "Could not decrypt backup. Check the passphrase.".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|e| format!("Invalid decrypted backup: {e}"))
}

/// Export vaults into a passphrase-encrypted backup envelope.
#[tauri::command]
pub fn export_vaults(
    vault_ids: Vec<i64>,
    keys: Vec<Vec<u8>>,
    backup_passphrase: String,
) -> Result<String, String> {
    if vault_ids.len() != keys.len() {
        return Err("Vault IDs and keys must have the same length".to_string());
    }

    let conn = open_brainbox_db()?;
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

    encrypt_backup(&export_data, &backup_passphrase)
}

/// Import an encrypted backup. Legacy plaintext exports remain readable for migration.
#[tauri::command]
pub fn import_vaults(json_data: String, backup_passphrase: String) -> Result<Vec<i64>, String> {
    let export_data = decrypt_backup(&json_data, &backup_passphrase)?;

    let conn = open_brainbox_db()?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let mut imported_vault_ids = Vec::new();

    for vault in export_data.vaults {
        // Create new vault with UUID
        let now = chrono::Utc::now().to_rfc3339();
        let new_uuid = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO vaults (name, encrypted_password, created_at, cover_image, uuid, updated_at, has_password) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            rusqlite::params![vault.name, Vec::<u8>::new(), now, vault.cover_image, new_uuid, now],
        ).map_err(|e| e.to_string())?;

        let vault_id = tx.last_insert_rowid();
        imported_vault_ids.push(vault_id);

        // Derive key for this vault
        let key = derive_key_from_password(&backup_passphrase, &vault_id.to_string(), 100_000);

        // Encrypt and store password verification
        let encrypted_password = encrypt_password(&key, &backup_passphrase)?;
        tx.execute(
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
            tx.execute(
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

    tx.commit().map_err(|e| e.to_string())?;
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

    let conn = open_brainbox_db()?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn setup() -> (Connection, i64, [u8; 32], i64, [u8; 32], i64) {
        let conn = Connection::open_in_memory().expect("in-memory db should open");
        conn.pragma_update(None, "foreign_keys", true)
            .expect("foreign keys should enable");
        Vault::create_table(&conn).expect("vault table should exist");
        VaultItem::create_table(&conn).expect("item table should exist");

        let mut vaults = Vec::new();
        for name in ["Source", "Target"] {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO vaults (name, encrypted_password, created_at, has_password, uuid, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?3)",
                params![name, Vec::<u8>::new(), now, uuid::Uuid::new_v4().to_string()],
            )
            .expect("vault should insert");
            let id = conn.last_insert_rowid();
            vaults.push((id, derive_key_from_password("", &id.to_string(), 100_000)));
        }

        let item = VaultItem::insert(&conn, vaults[0].0, "Item", "secret", &vaults[0].1)
            .expect("item should insert");
        (
            conn,
            vaults[0].0,
            vaults[0].1,
            vaults[1].0,
            vaults[1].1,
            item.id,
        )
    }

    #[test]
    fn cross_vault_move_reencrypts_content_with_target_key() {
        let (conn, _, source_key, target_id, target_key, item_id) = setup();

        move_vault_item_with_conn(
            &conn,
            item_id,
            target_id,
            source_key.to_vec(),
            target_key.to_vec(),
        )
        .expect("move should succeed");

        let moved = VaultItem::get_by_id(&conn, item_id).expect("moved item should exist");
        assert_eq!(moved.vault_id, target_id);
        assert_eq!(
            decrypt_content(&target_key, &moved.content).expect("target key should decrypt"),
            "secret"
        );
        assert!(decrypt_content(&source_key, &moved.content).is_err());
    }

    #[test]
    fn cross_vault_move_rejects_wrong_source_key_without_mutating_item() {
        let (conn, source_id, source_key, target_id, target_key, item_id) = setup();

        let error = move_vault_item_with_conn(
            &conn,
            item_id,
            target_id,
            [7_u8; 32].to_vec(),
            target_key.to_vec(),
        )
        .expect_err("wrong source key should fail");

        assert_eq!(error, "Invalid vault key");
        let item = VaultItem::get_by_id(&conn, item_id).expect("item should remain");
        assert_eq!(item.vault_id, source_id);
        assert_eq!(
            decrypt_content(&source_key, &item.content).expect("source key should still decrypt"),
            "secret"
        );
    }

    #[test]
    fn content_update_rejects_key_for_another_vault() {
        let (conn, _, source_key, _, target_key, item_id) = setup();

        let error =
            update_vault_item_content_with_conn(&conn, item_id, "corrupted", target_key.to_vec())
                .expect_err("wrong vault key should fail");

        assert_eq!(error, "Invalid vault key");
        let item = VaultItem::get_by_id(&conn, item_id).expect("item should remain");
        assert_eq!(
            decrypt_content(&source_key, &item.content).expect("original key should decrypt"),
            "secret"
        );
    }

    #[test]
    fn backup_envelope_hides_plaintext_and_requires_the_passphrase() {
        let data = ExportData {
            version: "1.0".into(),
            exported_at: "2026-07-11T00:00:00Z".into(),
            vaults: vec![ExportedVault {
                name: "Private vault".into(),
                created_at: "2026-07-11T00:00:00Z".into(),
                cover_image: None,
                items: vec![ExportedItem {
                    title: "Secret title".into(),
                    content: "Secret content".into(),
                    created_at: "2026-07-11T00:00:00Z".into(),
                    updated_at: "2026-07-11T00:00:00Z".into(),
                    image: None,
                    summary: None,
                }],
            }],
        };

        let encrypted =
            encrypt_backup(&data, "correct horse battery staple").expect("backup should encrypt");
        assert!(!encrypted.contains("Private vault"));
        assert!(!encrypted.contains("Secret content"));
        assert_eq!(
            decrypt_backup(&encrypted, "correct horse battery staple")
                .expect("backup should decrypt"),
            data
        );
        assert!(decrypt_backup(&encrypted, "wrong passphrase").is_err());
    }
}
