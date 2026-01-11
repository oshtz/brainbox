// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod search;
mod capture;
mod vault;
mod sync;

use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use rand::{rngs::OsRng, RngCore};

#[cfg(target_os = "windows")]
use tauri::Runtime;

// Only import what's actually used
#[cfg(target_os = "windows")]
use urlencoding;

use tauri::State;

// Store the current hotkey in memory
struct HotkeyState {
    current_hotkey: Mutex<Option<String>>,
}

// Queue for pending protocol captures when the window isn't ready yet
struct ProtocolState {
    pending: Mutex<Option<(String, String)>>, // (url, title)
}

// Keep the tray icon alive (otherwise events may not fire)
struct TrayState {
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

// FIX: Import the required trait for global_shortcut()
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri::Emitter;

use vault::Vault;
use dirs;
use tiny_http::{Server, Response};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn register_capture_hotkey(app: tauri::AppHandle, state: State<HotkeyState>, hotkey: String) -> Result<(), String> {
    let global_shortcut = app.global_shortcut();
    // Unregister previous hotkey if any
    if let Some(prev) = state.current_hotkey.lock().unwrap().clone() {
        let shortcut: Shortcut = prev.parse().map_err(|e| format!("Invalid shortcut: {e}"))?;
        let _ = global_shortcut.unregister(shortcut);
    }
    // Register new hotkey
    let shortcut: Shortcut = hotkey.parse().map_err(|e| format!("Invalid shortcut: {e}"))?;
    let app_clone = app.clone();
    global_shortcut.on_shortcut(shortcut, move |_app, _shortcut, _event| {
        // Focus the main window when the hotkey is pressed
        if let Some(window) = app_clone.get_webview_window("main") {
            let _ = window.set_focus();
        }
        let _ = app_clone.emit("capture-hotkey-pressed", ());
    }).map_err(|e| format!("Failed to register hotkey: {e}"))?;
    *state.current_hotkey.lock().unwrap() = Some(hotkey);
    Ok(())
}

#[tauri::command]
fn unregister_capture_hotkey(app: tauri::AppHandle, state: State<HotkeyState>) -> Result<(), String> {
    let global_shortcut = app.global_shortcut();
    if let Some(prev) = state.current_hotkey.lock().unwrap().clone() {
        let shortcut: Shortcut = prev.parse().map_err(|e| format!("Invalid shortcut: {e}"))?;
        let _ = global_shortcut.unregister(shortcut);
        *state.current_hotkey.lock().unwrap() = None;
    }
    Ok(())
}

#[tauri::command]
fn create_vault(name: String, password: String, has_password: Option<bool>) -> Result<Vault, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
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
        ).map_err(|e| e.to_string())?;
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
fn list_vaults() -> Result<Vec<Vault>, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    Vault::list(&conn).map_err(|e| e.to_string())
}

use crate::search::{search, index_document, delete_document};

// --- Add Tauri commands for vault items ---
use crate::vault::VaultItem;
// use crate::vault::Vault as VaultModel; // unused

#[tauri::command]
fn add_vault_item(vault_id: i64, title: String, content: String, key: Vec<u8>) -> Result<VaultItem, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 {
        return Err("Key must be 32 bytes".to_string());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    let item = VaultItem::insert(&conn, vault_id, &title, &content, &arr).map_err(|e| e.to_string())?;
    // Best-effort: index in search immediately
    let item_type = if content.starts_with("http://") || content.starts_with("https://") { "url" } else { "note" };
    let _ = crate::search::index_document(
        item.id.to_string(),
        title.clone(),
        content.clone(),
        item_type.to_string(),
        item.created_at.clone(),
        item.updated_at.clone(),
        None,
        vec![],
    );
    Ok(item)
}

#[derive(serde::Serialize)]
struct VaultItemOut {
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
    use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, Key, XNonce};
    if encrypted.len() < 24 { return Err("Invalid ciphertext".into()); }
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
    use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, Key, XNonce};
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

fn verify_vault_key(conn: &rusqlite::Connection, vault_id: i64, key: &[u8; 32]) -> Result<(), String> {
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
fn verify_vault_password(vault_id: i64, key: Vec<u8>) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 { return Err("Key must be 32 bytes".into()); }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    verify_vault_key(&conn, vault_id, &arr)?;
    Ok(())
}

#[tauri::command]
fn list_vault_items(vault_id: i64, key: Vec<u8>) -> Result<Vec<VaultItemOut>, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 { return Err("Key must be 32 bytes".into()); }
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
fn get_vault_item(item_id: i64, key: Vec<u8>) -> Result<VaultItemOut, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    crate::vault::VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 { return Err("Key must be 32 bytes".into()); }
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
fn delete_vault(vault_id: i64) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::delete(&conn, vault_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_vault(vault_id: i64, name: String) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::rename(&conn, vault_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_vault_cover(vault_id: i64, cover_image: Option<String>) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::update_cover_image(&conn, vault_id, cover_image.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_vault_item(item_id: i64) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::delete(&conn, item_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_vault_items_order(vault_id: i64, ordered_ids: Vec<i64>) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::update_order(&conn, vault_id, &ordered_ids).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_vault_item_title(item_id: i64, title: String) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::update_title(&conn, item_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
fn move_vault_item(item_id: i64, target_vault_id: i64) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::move_to_vault(&conn, item_id, target_vault_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_vault_item_image(item_id: i64, image: Option<String>) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::update_image(&conn, item_id, image.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_vault_item_content(item_id: i64, content: String, key: Vec<u8>) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    crate::vault::VaultItem::create_table(&conn).map_err(|e| e.to_string())?;
    if key.len() != 32 { return Err("Key must be 32 bytes".into()); }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    crate::vault::VaultItem::update_content(&conn, item_id, &content, &arr).map_err(|e| e.to_string())?;
    // Best-effort: update search index
    let it = crate::vault::VaultItem::get_by_id(&conn, item_id).map_err(|e| e.to_string())?;
    let item_type = if content.starts_with("http://") || content.starts_with("https://") { "url" } else { "note" };
    let _ = crate::search::index_document(
        item_id.to_string(),
        it.title.clone(),
        content.clone(),
        item_type.to_string(),
        it.created_at.clone(),
        it.updated_at.clone(),
        None,
        vec![]
    );
    Ok(())
}

#[tauri::command]
fn update_vault_item_summary(item_id: i64, summary: String) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
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
fn export_vaults(vault_ids: Vec<i64>, keys: Vec<Vec<u8>>) -> Result<String, String> {
    if vault_ids.len() != keys.len() {
        return Err("Vault IDs and keys must have the same length".to_string());
    }

    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
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
            .query_row([vault_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2).ok())))
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
fn import_vaults(json_data: String, password: String) -> Result<Vec<i64>, String> {
    let export_data: ExportData = serde_json::from_str(&json_data)
        .map_err(|e| format!("Invalid export format: {}", e))?;

    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
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
        ).map_err(|e| e.to_string())?;

        // Import items
        for item in vault.items {
            // Encrypt content
            use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, Key, XNonce};
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
fn change_vault_password(vault_id: i64, old_key: Vec<u8>, new_password: String, new_has_password: Option<bool>) -> Result<(), String> {
    if old_key.len() != 32 {
        return Err("Old key must be 32 bytes".to_string());
    }
    let mut old_arr = [0u8; 32];
    old_arr.copy_from_slice(&old_key);

    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    Vault::create_table(&conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(&conn).map_err(|e| e.to_string())?;

    // Verify old key works
    verify_vault_key(&conn, vault_id, &old_arr)?;

    // Determine if new vault should have password protection
    let should_have_password = new_has_password.unwrap_or(!new_password.is_empty()) && !new_password.is_empty();

    // Derive new key from new password (empty string if no password)
    let new_key = derive_key_from_password(&new_password, &vault_id.to_string(), 100_000);

    // Get all items for this vault
    let items = VaultItem::list_by_vault(&conn, vault_id).map_err(|e| e.to_string())?;

    // Start transaction
    conn.execute("BEGIN IMMEDIATE", []).map_err(|e| e.to_string())?;

    // Re-encrypt each item
    for item in items {
        // Decrypt with old key
        let plaintext = decrypt_content(&old_arr, &item.content)?;

        // Re-encrypt with new key
        use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, Key, XNonce};
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
        ).map_err(|e| {
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
    ).map_err(|e| {
        let _ = conn.execute("ROLLBACK", []);
        e.to_string()
    })?;

    // Commit transaction
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;

    Ok(())
}

// --- Sync Commands ---

use std::collections::HashMap;

/// Export all vaults to sync folder
#[tauri::command]
fn sync_export_vaults(passwords: HashMap<i64, Vec<u8>>) -> Result<sync::SyncExportResult, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::sync_export(&conn, passwords)
}

/// Get sync status information
#[tauri::command]
fn get_sync_status() -> Result<sync::SyncStatus, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::check_sync_status(&conn)
}

/// Get list of vaults that need passwords for export
#[tauri::command]
fn get_locked_vaults_for_sync() -> Result<Vec<(i64, String)>, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::get_locked_vaults(&conn)
}

/// Get all sync settings
#[tauri::command]
fn get_sync_settings() -> Result<HashMap<String, String>, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::get_sync_settings(&conn)
}

/// Set a sync setting
#[tauri::command]
fn set_sync_setting(key: String, value: String) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::set_sync_setting(&conn, &key, &value)
}

/// Set sync folder path
#[tauri::command]
fn set_sync_folder(path: String) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
    // Validate the path exists
    if !std::path::Path::new(&path).exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    sync::set_sync_folder(&conn, &path)
}

/// Import vaults from sync folder
/// passwords: Map of vault_uuid -> password
#[tauri::command]
fn sync_import_vaults(passwords: HashMap<String, String>) -> Result<sync::SyncImportResult, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::sync_import(&conn, passwords)
}

/// Get preview of sync file before importing
#[tauri::command]
fn get_sync_preview() -> Result<Option<sync::SyncPreview>, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::get_sync_preview(&conn)
}

/// Purge soft-deleted items older than X days
#[tauri::command]
fn purge_deleted_items(days: Option<i32>) -> Result<sync::PurgeResult, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
    // Use provided days or get from settings (default 30)
    let purge_days = match days {
        Some(d) => d,
        None => sync::get_purge_days(&conn)?,
    };
    
    sync::purge_deleted_items(&conn, purge_days)
}

/// Run auto-purge if sync is enabled (called on app startup)
#[tauri::command]
fn auto_purge_if_enabled() -> Result<Option<sync::PurgeResult>, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
    if sync::should_auto_purge(&conn)? {
        let days = sync::get_purge_days(&conn)?;
        Ok(Some(sync::purge_deleted_items(&conn, days)?))
    } else {
        Ok(None)
    }
}

/// Check if "sync on close" is enabled
#[tauri::command]
fn is_sync_on_close_enabled() -> Result<bool, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::is_sync_on_close_enabled(&conn)
}

/// Set "sync on close" setting
#[tauri::command]
fn set_sync_on_close(enabled: bool) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::set_sync_on_close(&conn, enabled)
}

/// Check if "check for sync on startup" is enabled
#[tauri::command]
fn is_check_sync_on_startup_enabled() -> Result<bool, String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::is_check_sync_on_startup_enabled(&conn)
}

/// Set "check for sync on startup" setting
#[tauri::command]
fn set_check_sync_on_startup(enabled: bool) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::set_check_sync_on_startup(&conn, enabled)
}

/// Set device name for sync
#[tauri::command]
fn set_device_name(name: String) -> Result<(), String> {
    let db_path = dirs::data_local_dir().ok_or("Failed to get app data dir")?.join("brainbox.sqlite");
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::set_device_name(&conn, &name)
}

/// Get device hostname (for default device name)
#[tauri::command]
fn get_hostname() -> String {
    whoami::fallible::hostname().unwrap_or_else(|_| "Unknown".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn register_brainbox_protocol() -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    use std::env;

    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe_path.to_str().ok_or("Invalid exe path")?;

    // Use HKEY_CURRENT_USER for per-user protocol registration (no admin rights needed)
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (classes, _) = hkcu.create_subkey("Software\\Classes").map_err(|e| e.to_string())?;
    let (key, _) = classes.create_subkey("brainbox").map_err(|e| e.to_string())?;
    key.set_value("", &"URL:brainbox Protocol").map_err(|e| e.to_string())?;
    key.set_value("URL Protocol", &"").map_err(|e| e.to_string())?;

    // Add "DefaultIcon" (optional but recommended)
    let (icon_key, _) = key.create_subkey("DefaultIcon").map_err(|e| e.to_string())?;
    icon_key.set_value("", &format!("\"{}\",0", exe_str)).map_err(|e| e.to_string())?;

    // Create the command key and set the command to launch your app with the URL
    let shell = key.create_subkey("shell").map_err(|e| e.to_string())?.0;
    let open = shell.create_subkey("open").map_err(|e| e.to_string())?.0;
    let command = open.create_subkey("command").map_err(|e| e.to_string())?.0;
    
    // The key part: Use "--brainbox-protocol" flag to help with multiple instance handling
    command.set_value("", &format!("\"{}\" --brainbox-protocol \"%1\"", exe_str)).map_err(|e| e.to_string())?;

    Ok(())
}

// --- Protocol handler for brainbox://capture?url=...&title=...
#[cfg(target_os = "windows")]
fn handle_protocol_url<R: Runtime>(app: &tauri::AppHandle<R>, url: &str) {
    // Only handle brainbox://capture?url=...&title=...
    if let Some(rest) = url.strip_prefix("brainbox://capture?") {
        let mut capture_url = String::new();
        let mut title = String::new();
        for param in rest.split('&') {
            let mut parts = param.splitn(2, '=');
            match (parts.next(), parts.next()) {
                (Some("url"), Some(val)) => {
                    capture_url = urlencoding::decode(val).unwrap_or_default().to_string();
                }
                (Some("title"), Some(val)) => {
                    title = urlencoding::decode(val).unwrap_or_default().to_string();
                }
                _ => {}
            }
        }
        // Emit event to frontend (or queue if window not ready yet)
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();

            let _ = window.emit("capture-from-protocol", serde_json::json!({
                "url": capture_url,
                "title": title,
            }));

            // no always-on-top (not available on this Webview type)
        } else {
            // queue it for when the window is available; delivery happens on page load
            if let Some(state) = app.try_state::<ProtocolState>() {
                let mut pending = state.pending.lock().unwrap();
                *pending = Some((capture_url, title));
            }
        }
    }
}

// Platform-specific builder functions
#[cfg(not(target_os = "windows"))]
fn create_app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .on_page_load(|window, _| {
            // Deliver any queued protocol capture when the main window finishes loading
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            if let Some(state) = app.try_state::<ProtocolState>() {
                let mut pending = state.pending.lock().unwrap();
                if let Some((url, title)) = pending.take() {
                    // ensure visibility
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("capture-from-protocol", serde_json::json!({
                        "url": url,
                        "title": title,
                    }));
                    // no always-on-top toggle in this build
                }
            }
        })
        .plugin(
            tauri_plugin_shell::init()
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("Alt+Shift+B")
                .expect("Failed to register shortcut")
                .build()
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Forward protocol URLs to the existing instance
            for arg in args.iter() {
                if arg.starts_with("brainbox://capture?") {
                    #[cfg(target_os = "windows")]
                    {
                        handle_protocol_url(&app, arg);
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    break;
                }
            }
        }))
}

#[cfg(target_os = "windows")]
fn create_app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .on_page_load(|window, _| {
            // Deliver any queued protocol capture when the main window finishes loading
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            if let Some(state) = app.try_state::<ProtocolState>() {
                let mut pending = state.pending.lock().unwrap();
                if let Some((url, title)) = pending.take() {
                    // ensure visibility
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("capture-from-protocol", serde_json::json!({
                        "url": url,
                        "title": title,
                    }));
                    // no always-on-top toggle in this build
                }
            }
        })
        .plugin(
            tauri_plugin_shell::init()
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("Alt+Shift+B")
                .expect("Failed to register shortcut")
                .build()
        )
        // Note: Single instance plugin disabled on Windows due to null pointer bug
        // Users can run multiple instances, but protocol handling will still work
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    create_app_builder()
        .setup(|app| {
            // Initialize the search service with a path for the index
            let app_dir = dirs::data_local_dir().ok_or("Failed to get app data dir")?;
            let index_dir = app_dir.join("search_index");
            
            eprintln!("brainbox: Creating search index directory: {:?}", index_dir);
            
            // Create directory with better error handling
            if let Err(e) = std::fs::create_dir_all(&index_dir) {
                eprintln!("brainbox: Failed to create index directory: {}", e);
                eprintln!("brainbox: App will continue without search functionality");
            } else {
                eprintln!("brainbox: Initializing search service...");
                
                // Try to initialize search service with graceful fallback
                match search::init_search_service(&index_dir) {
                    Ok(_) => {
                        eprintln!("brainbox: Search service initialized successfully");
                    },
                    Err(e) => {
                        eprintln!("brainbox: Failed to initialize search service: {}", e);
                        
                        // Only attempt recovery on macOS where the issue is known to occur
                        #[cfg(target_os = "macos")]
                        {
                            eprintln!("brainbox: Attempting automatic recovery (macOS-specific fix)...");
                            
                            // Try to recover by clearing the corrupted index
                            if let Err(recovery_err) = search::SearchService::recover_index(&index_dir) {
                                eprintln!("brainbox: Index recovery failed: {}", recovery_err);
                            } else {
                                eprintln!("brainbox: Index recovery completed, retrying initialization...");
                                
                                // Retry initialization after recovery
                                match search::init_search_service(&index_dir) {
                                    Ok(_) => {
                                        eprintln!("brainbox: Search service initialized successfully after recovery");
                                        return Ok(());
                                    },
                                    Err(retry_err) => {
                                        eprintln!("brainbox: Search service initialization failed even after recovery: {}", retry_err);
                                    }
                                }
                            }
                        }
                        
                        eprintln!("brainbox: This may be due to:");
                        #[cfg(target_os = "macos")]
                        eprintln!("  - Memory mapping issues on macOS M4 systems");
                        #[cfg(not(target_os = "macos"))]
                        eprintln!("  - Corrupted search index");
                        eprintln!("  - Insufficient disk space or permissions");
                        eprintln!("brainbox: App will continue without search functionality");
                    }
                }
            }

            // Initialize hotkey state
            app.manage(HotkeyState {
                current_hotkey: Mutex::new(Some("Alt+Shift+B".to_string())),
            });

            // Initialize protocol state (pending capture queue)
            app.manage(ProtocolState {
                pending: Mutex::new(None),
            });
            // Register default hotkey
            let app_handle = app.handle();
            let hotkey_state = app.state::<HotkeyState>();
            let _ = register_capture_hotkey(app_handle.clone(), hotkey_state, "Alt+Shift+B".to_string());

            // spawn HTTP server to receive captures
            let app_handle_http = app.handle().clone();
            std::thread::spawn(move || {
                let server = Server::http("127.0.0.1:51234").unwrap();
                for request in server.incoming_requests() {
                    if let Some(q) = request.url().strip_prefix("/capture?") {
                        let mut url = String::new();
                        let mut title = String::new();
                        for param in q.split('&') {
                            let mut parts = param.splitn(2, '=');
                            match (parts.next(), parts.next()) {
                                (Some("url"), Some(v)) => url = urlencoding::decode(v).unwrap_or_default().to_string(),
                                (Some("title"), Some(v)) => title = urlencoding::decode(v).unwrap_or_default().to_string(),
                                _ => {}
                            }
                        }
                        if let Some(window) = app_handle_http.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("capture-from-protocol", serde_json::json!({ "url": url, "title": title }));
                        }
                    }
                    // Respond with a tiny page that attempts to close itself if it was opened by script
                    let html = r#"<!doctype html><meta charset=\"utf-8\"><title>brainbox Capture</title>
<style>body{font:13px system-ui;margin:24px;color:#222}</style>
<body>Captured to brainbox. This tab will close.
<script>
  (function(){
    try{ if (window.opener) { try{ window.opener.focus(); }catch(e){} } }catch(e){}
    try{ window.close(); }catch(e){}
    setTimeout(function(){
      try{ window.close(); }catch(e){ try{ location.replace('about:blank'); }catch(_){} }
    }, 200);
  })();
</script>
"#;
                    let mut resp = Response::from_string(html);
                    resp.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                    let _ = request.respond(resp);
                }
            });

            // Handle protocol URLs
            #[cfg(target_os = "windows")]
            {
                // Register custom protocol handler
                if let Err(e) = register_brainbox_protocol() {
                    eprintln!("Failed to register protocol: {}", e);
                }
                
                // Handle command line arguments at startup for protocol URLs
                // Check for our protocol URLs in the right format
                let args: Vec<String> = std::env::args().collect();
                
                // Look for protocol URLs in arguments
                let mut has_protocol_url = false;
                let mut protocol_url = String::new();
                
                for i in 1..args.len() {
                    if args[i] == "--brainbox-protocol" && i + 1 < args.len() && args[i + 1].starts_with("brainbox://capture?") {
                        protocol_url = args[i + 1].clone();
                        has_protocol_url = true;
                        break;
                    } else if args[i].starts_with("brainbox://capture?") {
                        protocol_url = args[i].clone();
                        has_protocol_url = true;
                        break;
                    }
                }
                
                if has_protocol_url {
                    // Process the URL immediately; if the window isn't ready yet, it will be queued
                    handle_protocol_url(&app.handle(), &protocol_url);
                }
            }

            // Initialize system tray in Rust so it works even when the webview is hidden/suspended
            #[allow(unused_variables)]
            {
                use tauri::Manager;
                // Create a simple menu with Show / Hide / Quit
                #[allow(unused_imports)]
                use tauri::menu::{Menu, MenuItem};
                #[allow(unused_imports)]
                use tauri::tray::{TrayIconBuilder, TrayIconEvent};
                #[allow(unused_imports)]
                use tauri::image::Image as TauriImage;

                // Build menu and tray using current Tauri 2 API
                let show = MenuItem::new(app, "show", true, None::<&str>)?;
                show.set_text("Show Brainbox")?;
                let hide = MenuItem::new(app, "hide", true, None::<&str>)?;
                hide.set_text("Hide to Tray")?;
                let quit = MenuItem::new(app, "quit", true, None::<&str>)?;
                quit.set_text("Quit")?;

                let menu = Menu::new(app)?;
                menu.append(&show)?;
                menu.append(&hide)?;
                menu.append(&quit)?;

                // Capture stable IDs for menu event comparison
                let show_id = show.id().clone();
                let hide_id = hide.id().clone();
                let quit_id = quit.id().clone();
                // Prefer the app's default window icon (honors platform formats: .ico on Windows, .icns on macOS)
                let mut tray_builder = TrayIconBuilder::new();
                if let Some(img) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(img.clone());
                } else if let Ok(img) = TauriImage::from_path("icons/icon.png") {
                    // Fallback to our bundled PNG if default icon isn't available
                    tray_builder = tray_builder.icon(img);
                }

                let tray = tray_builder
                    .menu(&menu)
                    .on_menu_event(move |app, event| {
                        let id = event.id();
                        eprintln!("[tray] menu event: {:?}", id);
                        if id == &show_id {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        } else if id == &hide_id {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        } else if id == &quit_id {
                            app.exit(0);
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        // Show on double click
                        if let TrayIconEvent::DoubleClick { .. } = event {
                            eprintln!("[tray] double click");
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)
                    .expect("Failed to build tray icon");

                // store tray handle so callbacks stay alive
                app.manage(TrayState { tray: Mutex::new(Some(tray)) });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            search,
            index_document,
            delete_document,
            register_capture_hotkey,
            unregister_capture_hotkey,
            create_vault,
            list_vaults,
            delete_vault,
            rename_vault,
            update_vault_cover,
            add_vault_item,
            list_vault_items,
            verify_vault_password,
            delete_vault_item,
            update_vault_items_order,
            update_vault_item_title,
            update_vault_item_content,
            move_vault_item,
            update_vault_item_image,
            update_vault_item_summary,
            change_vault_password,
            export_vaults,
            import_vaults,
            get_vault_item,
            // Sync commands
            sync_export_vaults,
            sync_import_vaults,
            get_sync_status,
            get_sync_preview,
            get_locked_vaults_for_sync,
            get_sync_settings,
            set_sync_setting,
            set_sync_folder,
            purge_deleted_items,
            auto_purge_if_enabled,
            is_sync_on_close_enabled,
            set_sync_on_close,
            is_check_sync_on_startup_enabled,
            set_check_sync_on_startup,
            set_device_name,
            get_hostname,
            fetch_url_metadata,
            // Scraping helpers
            fetch_url_text,
            fetch_youtube_transcript,
            // Ollama integration
            ollama_list_models,
            ollama_generate,
            ollama_generate_stream,
            quit_app,
            // Auto-updater commands (custom GitHub releases implementation)
            get_current_version,
            check_for_updates,
            download_update,
            apply_update,
            install_update,
            #[cfg(target_os = "windows")]
            register_brainbox_protocol,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(serde::Serialize)]
struct UrlMetadata {
    final_url: String,
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
    favicon: Option<String>,
}

#[tauri::command]
fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    use regex::Regex;
    use reqwest::blocking::Client;
    use reqwest::header::{USER_AGENT, ACCEPT, ACCEPT_LANGUAGE};

    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36")
        .header(ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
        .header(ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .send()
        .map_err(|e| e.to_string())?;

    let final_url = resp.url().to_string();
    let text = resp.text().map_err(|e| e.to_string())?;

    // Simple regex-based extraction to avoid heavy dependencies
    let re_meta = |name: &str| -> Regex {
        Regex::new(&format!(r#"<meta[^>]+(?:property|name)=[\"']{}[\"'][^>]*content=[\"']([^\"']+)[\"'][^>]*>"#, regex::escape(name))).unwrap()
    };
    let re_title = Regex::new(r#"<title[^>]*>([^<]+)</title>"#).unwrap();
    let get = |re: &Regex| re.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string()));

    let og_title = get(&re_meta("og:title"));
    let og_desc = get(&re_meta("og:description"));
    let og_image = get(&re_meta("og:image")).or(get(&re_meta("og:image:secure_url")));
    let tw_image = get(&re_meta("twitter:image")).or(get(&re_meta("twitter:image:src")));
    let site_name = get(&re_meta("og:site_name"));
    let title_fallback = re_title.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string()));

    // Build favicon via Google S2 as a robust default
    let favicon = (|| {
        let host = reqwest::Url::parse(&final_url).ok()?.host_str()?.to_string();
        Some(format!("https://www.google.com/s2/favicons?sz=64&domain={}", host))
    })();

    // Prefer og:image, fall back to twitter:image, and resolve relative URLs
    let image = (|| {
        let img = og_image.or(tw_image)?;
        if let Ok(base) = reqwest::Url::parse(&final_url) {
            if let Ok(joined) = base.join(&img) { return Some(joined.to_string()); }
        }
        Some(img)
    })();

    Ok(UrlMetadata {
        final_url,
        title: og_title.or(title_fallback),
        description: og_desc,
        image,
        site_name,
        favicon,
    })
}

// Extract readable text from a web page (best-effort)
#[tauri::command]
fn fetch_url_text(url: String) -> Result<String, String> {
    use reqwest::blocking::Client;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    let html = resp.text().map_err(|e| e.to_string())?;
    let document = scraper::Html::parse_document(&html);
    let selector = scraper::Selector::parse("body").unwrap();
    let mut out = String::new();
    for el in document.select(&selector) {
        for txt in el.text() {
            let t = txt.trim();
            if !t.is_empty() {
                out.push_str(t);
                out.push('\n');
            }
        }
    }
    Ok(out)
}

// Fetch YouTube transcript if available by scraping captionTracks
#[tauri::command]
fn fetch_youtube_transcript(url: String) -> Result<Option<String>, String> {
    use regex::Regex;
    use reqwest::blocking::Client;
    let u = match reqwest::Url::parse(&url) { Ok(u) => u, Err(_) => return Ok(None) };
    let host = u.host_str().unwrap_or("");
    if !host.contains("youtube.com") && !host.contains("youtu.be") { return Ok(None); }

    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(u.clone()).send().map_err(|e| e.to_string())?;
    let page = resp.text().map_err(|e| e.to_string())?;
    // Find captionTracks JSON array
    let re = Regex::new(r#""captionTracks"\s*:\s*(\[[^\]]+\])"#).map_err(|e| e.to_string())?;
    let caps = match re.captures(&page) { Some(c) => c, None => return Ok(None) };
    let tracks_json = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    let val: serde_json::Value = match serde_json::from_str(tracks_json) { Ok(v) => v, Err(_) => return Ok(None) };
    let base = match val.get(0).and_then(|t| t.get("baseUrl")).and_then(|v| v.as_str()) { Some(s) => s, None => return Ok(None) };
    let base_url = base.replace("\\u0026", "&");
    let tr_resp = client.get(&base_url).send().map_err(|e| e.to_string())?;
    let xml = tr_resp.text().map_err(|e| e.to_string())?;
    // Parse XML transcript: collect <text> nodes
    let mut reader = quick_xml::Reader::from_str(&xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    let mut acc = String::new();
    loop {
        use quick_xml::events::Event;
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Text(t)) => {
                let txt = t.unescape().unwrap_or_default().to_string();
                if !txt.trim().is_empty() {
                    acc.push_str(&txt);
                    acc.push('\n');
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
        buf.clear();
    }
    if acc.trim().is_empty() { Ok(None) } else { Ok(Some(acc)) }
}

// --- Ollama Integration ---
#[derive(serde::Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModelInfo>,
}

#[derive(serde::Deserialize)]
struct OllamaModelInfo {
    name: String,
}

fn sanitize_base_url(input: Option<String>) -> String {
    let default_url = "http://127.0.0.1:11434".to_string();
    let raw = input.unwrap_or(default_url);
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() { "http://127.0.0.1:11434".to_string() } else { trimmed }
}

#[tauri::command]
fn ollama_list_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    use reqwest::blocking::Client;
    let base = sanitize_base_url(base_url);
    let url = format!("{}/api/tags", base);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned status {}", resp.status()));
    }
    let tags: OllamaTagsResponse = resp.json().map_err(|e| e.to_string())?;
    Ok(tags.models.into_iter().map(|m| m.name).collect())
}

#[derive(serde::Serialize)]
struct OllamaGenerateRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
}

#[derive(serde::Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

#[tauri::command]
fn ollama_generate(model: String, prompt: String, base_url: Option<String>, system: Option<String>) -> Result<String, String> {
    use reqwest::blocking::Client;
    let base = sanitize_base_url(base_url);
    let url = format!("{}/api/generate", base);
    let body = OllamaGenerateRequest { model: &model, prompt: &prompt, stream: false, system: system.as_deref() };
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned status {}", resp.status()));
    }
    let gen: OllamaGenerateResponse = resp.json().map_err(|e| e.to_string())?;
    Ok(gen.response)
}

#[derive(serde::Serialize, Clone)]
struct StreamEvent { streamId: String, #[serde(skip_serializing_if = "Option::is_none")] delta: Option<String>, done: bool }

// Stream generate via events: emits "ollama-stream" with {streamId, delta} and a final {done:true}
#[tauri::command]
fn ollama_generate_stream(app: tauri::AppHandle, model: String, prompt: String, base_url: Option<String>, system: Option<String>, stream_id: String) -> Result<(), String> {
    use reqwest::blocking::Client;
    use std::io::{BufRead, BufReader};
    let base = sanitize_base_url(base_url);
    let url = format!("{}/api/generate", base);
    let body = OllamaGenerateRequest { model: &model, prompt: &prompt, stream: true, system: system.as_deref() };
    let client = Client::builder().build().map_err(|e| e.to_string())?;
    let resp = client.post(&url).json(&body).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("Ollama returned status {}", resp.status())); }
    let mut reader = BufReader::new(resp);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                let _ = app.emit("ollama-stream", StreamEvent { streamId: stream_id.clone(), delta: None, done: true });
                break;
            }
            if let Some(delta) = v.get("response").and_then(|s| s.as_str()) {
                let _ = app.emit("ollama-stream", StreamEvent { streamId: stream_id.clone(), delta: Some(delta.to_string()), done: false });
            }
        }
    }
    Ok(())
}

// Command to quit the app from the frontend (e.g. tray menu)
#[tauri::command]
fn quit_app(app: tauri::AppHandle) -> Result<(), ()> {
    app.exit(0);
    Ok(())
}

// ============================================================================
// Custom Auto-Updater (GitHub Releases)
// ============================================================================

const GITHUB_REPO: &str = "oshtz/brainbox";

#[derive(serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(serde::Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct UpdateInfo {
    version: String,
    download_url: String,
    asset_name: String,
}

/// Parse version string (strips 'v' prefix) and returns (major, minor, patch)
fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let v = version.trim().trim_start_matches(|c| c == 'v' || c == 'V');
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() >= 3 {
        let major = parts[0].parse().ok()?;
        let minor = parts[1].parse().ok()?;
        let patch = parts[2].parse().ok()?;
        Some((major, minor, patch))
    } else {
        None
    }
}

/// Compare two versions, returns true if new_version > current_version
fn is_newer_version(current: &str, new_version: &str) -> bool {
    match (parse_version(current), parse_version(new_version)) {
        (Some((c_maj, c_min, c_pat)), Some((n_maj, n_min, n_pat))) => {
            (n_maj, n_min, n_pat) > (c_maj, c_min, c_pat)
        }
        _ => false,
    }
}

/// Get the appropriate asset name for the current platform
fn get_platform_asset_pattern() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "x64-setup.exe"
    }
    #[cfg(target_os = "macos")]
    {
        ".app.tar.gz"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        ""
    }
}

#[tauri::command]
fn get_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
async fn check_for_updates() -> Result<Option<UpdateInfo>, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    
    let client = reqwest::Client::builder()
        .user_agent("brainbox-updater")
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }
    
    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;
    
    let new_version = release.tag_name.trim_start_matches('v');
    
    if !is_newer_version(current_version, new_version) {
        return Ok(None);
    }
    
    // Find the appropriate asset for this platform
    let pattern = get_platform_asset_pattern();
    if pattern.is_empty() {
        return Err("Auto-update not supported on this platform".to_string());
    }
    
    let asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(pattern))
        .ok_or_else(|| format!("No suitable update asset found for this platform"))?;
    
    Ok(Some(UpdateInfo {
        version: new_version.to_string(),
        download_url: asset.browser_download_url.clone(),
        asset_name: asset.name.clone(),
    }))
}

#[tauri::command]
async fn download_update(app: tauri::AppHandle, update_info: UpdateInfo) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("brainbox-updater")
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client
        .get(&update_info.download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }
    
    let total_size = response.content_length();
    
    // Get temp directory for download
    let temp_dir = std::env::temp_dir();
    let download_path = temp_dir.join(&update_info.asset_name);
    
    // Stream download with progress
    let mut file = std::fs::File::create(&download_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| format!("Failed to write chunk: {}", e))?;
        
        downloaded += chunk.len() as u64;
        
        if let Some(total) = total_size {
            let progress = (downloaded as f64 / total as f64) * 100.0;
            let _ = app.emit("update-progress", progress);
        }
    }
    
    let _ = app.emit("update-downloaded", ());
    
    Ok(download_path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn escape_powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "macos")]
fn escape_bash_literal(value: &str) -> String {
    value.replace('\'', "'\\''")
}

#[tauri::command]
fn apply_update(app: tauri::AppHandle, update_path: String) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Auto-update is disabled in dev builds.".to_string());
    }

    let update_file = Path::new(&update_path);
    if !update_file.exists() {
        return Err("Update file not found.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // For Windows NSIS installer, just run it and exit
        Command::new(&update_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let pid = std::process::id();
        
        // Get the .app bundle path (current_exe is inside .app/Contents/MacOS/)
        let app_bundle = current_exe
            .parent()  // MacOS/
            .and_then(|p| p.parent())  // Contents/
            .and_then(|p| p.parent())  // .app bundle
            .ok_or("Could not determine app bundle path")?;

        // Extract the tar.gz and replace the app
        let temp_dir = std::env::temp_dir();
        let extract_dir = temp_dir.join("brainbox-update");
        
        // Clean up any previous extract
        let _ = std::fs::remove_dir_all(&extract_dir);
        std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

        let script = format!(
            r#"
            pid={}
            archive='{}'
            extract_dir='{}'
            target='{}'
            
            # Wait for app to exit
            while kill -0 $pid 2>/dev/null; do sleep 0.2; done
            
            # Extract update
            tar -xzf "$archive" -C "$extract_dir"
            
            # Find the .app bundle in extracted files
            app_path=$(find "$extract_dir" -name "*.app" -maxdepth 1 | head -1)
            
            if [ -n "$app_path" ]; then
                rm -rf "$target"
                mv -f "$app_path" "$target"
                xattr -cr "$target" 2>/dev/null || true
                open "$target"
            fi
            
            # Cleanup
            rm -rf "$extract_dir"
            rm -f "$archive"
            "#,
            pid,
            escape_bash_literal(&update_path),
            escape_bash_literal(&extract_dir.to_string_lossy()),
            escape_bash_literal(&app_bundle.to_string_lossy()),
        );

        Command::new("bash")
            .args(["-c", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        return Err("Auto-update is not supported on this platform.".to_string());
    }

    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    // Check for update
    let update_info = check_for_updates()
        .await?
        .ok_or("No update available")?;
    
    // Download update
    let update_path = download_update(app.clone(), update_info).await?;
    
    // Apply update
    apply_update(app, update_path)
}
