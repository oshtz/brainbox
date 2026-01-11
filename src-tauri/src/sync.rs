// sync.rs - Sync functionality for brainbox
// Handles export/import of vaults to sync folder for cross-device synchronization

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use crate::vault::{Vault, VaultItem, SyncSettings};
use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, Key, XNonce};

/// Sync file format version
pub const SYNC_FORMAT_VERSION: &str = "1.0";

/// Sync file name
pub const SYNC_FILE_NAME: &str = "brainbox.sync";

/// Captures subfolder name
pub const CAPTURES_FOLDER_NAME: &str = "captures";

// --- Sync Data Structures ---

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncFile {
    pub format_version: String,
    pub device_id: String,
    pub device_name: String,
    pub exported_at: String,
    pub vaults: Vec<SyncVault>,
    pub captures: Vec<SyncCapture>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncVault {
    pub uuid: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_image: Option<String>,
    pub has_password: bool,
    pub items: Vec<SyncItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncItem {
    pub uuid: String,
    pub title: String,
    pub content: String, // decrypted plaintext content
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncCapture {
    pub filename: String,
    pub created_at: String,
    pub size_bytes: u64,
}

// --- Export Result ---

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncExportResult {
    pub exported_vaults: usize,
    pub exported_items: usize,
    pub exported_captures: usize,
    pub skipped_vaults: Vec<String>, // Names of vaults skipped due to missing password
    pub warnings: Vec<String>,
}

// --- Import Result ---

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncImportResult {
    pub imported_vaults: usize,
    pub imported_items: usize,
    pub imported_captures: usize,
    pub conflicts: Vec<String>, // Item titles that had conflicts
    pub warnings: Vec<String>,
    pub skipped_vaults: Vec<String>, // Names of vaults skipped due to password mismatch
}

// --- Helper Functions ---

/// Decrypt content using XChaCha20-Poly1305
fn decrypt_content(key: &[u8; 32], encrypted: &[u8]) -> Result<String, String> {
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

/// Get or create device ID
fn get_or_create_device_id(conn: &Connection) -> Result<String, String> {
    if let Some(id) = SyncSettings::get(conn, "device_id").map_err(|e| e.to_string())? {
        return Ok(id);
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    SyncSettings::set(conn, "device_id", &new_id).map_err(|e| e.to_string())?;
    Ok(new_id)
}

/// Get device name (hostname or custom name)
fn get_device_name(conn: &Connection) -> Result<String, String> {
    if let Some(name) = SyncSettings::get(conn, "device_name").map_err(|e| e.to_string())? {
        return Ok(name);
    }
    // Default to hostname
    Ok(whoami::fallible::hostname().unwrap_or_else(|_| "Unknown".to_string()))
}

/// Get sync folder path from settings
pub fn get_sync_folder(conn: &Connection) -> Result<Option<String>, String> {
    SyncSettings::get(conn, "sync_folder").map_err(|e| e.to_string())
}

/// Set sync folder path in settings
pub fn set_sync_folder(conn: &Connection, path: &str) -> Result<(), String> {
    SyncSettings::set(conn, "sync_folder", path).map_err(|e| e.to_string())
}

/// Get captures folder path (from app data directory)
fn get_captures_folder() -> Result<PathBuf, String> {
    let app_dir = dirs::data_local_dir().ok_or("Failed to get app data dir")?;
    Ok(app_dir.join("brainbox_captures"))
}

// --- Export Functions ---

/// Export all vaults and captures to sync folder
/// passwords: Map of vault_id -> decryption key (32 bytes)
pub fn sync_export(
    conn: &Connection,
    passwords: HashMap<i64, Vec<u8>>,
) -> Result<SyncExportResult, String> {
    // Ensure tables exist
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;

    // Get sync folder
    let sync_folder_str = get_sync_folder(conn)?
        .ok_or("Sync folder not configured. Please set a sync folder in settings.")?;
    let sync_folder = Path::new(&sync_folder_str);

    // Validate sync folder exists
    if !sync_folder.exists() {
        return Err(format!("Sync folder does not exist: {}", sync_folder_str));
    }

    // Create captures subfolder if missing
    let captures_dest = sync_folder.join(CAPTURES_FOLDER_NAME);
    if !captures_dest.exists() {
        fs::create_dir_all(&captures_dest)
            .map_err(|e| format!("Failed to create captures folder: {}", e))?;
    }

    // Get device info
    let device_id = get_or_create_device_id(conn)?;
    let device_name = get_device_name(conn)?;

    // Get all vaults (including soft-deleted for sync)
    let vaults = Vault::list_all_for_sync(conn).map_err(|e| e.to_string())?;

    let mut sync_vaults = Vec::new();
    let mut skipped_vaults = Vec::new();
    let mut exported_items = 0;
    let mut warnings = Vec::new();

    for vault in vaults {
        let vault_uuid = vault.uuid.clone().unwrap_or_else(|| {
            warnings.push(format!("Vault '{}' has no UUID, generating one", vault.name));
            uuid::Uuid::new_v4().to_string()
        });

        // Check if vault has password and we have the key
        let key: Option<[u8; 32]> = if vault.has_password {
            if let Some(key_vec) = passwords.get(&vault.id) {
                if key_vec.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(key_vec);
                    Some(arr)
                } else {
                    skipped_vaults.push(vault.name.clone());
                    warnings.push(format!("Skipped vault '{}': invalid key length", vault.name));
                    continue;
                }
            } else {
                skipped_vaults.push(vault.name.clone());
                warnings.push(format!("Skipped vault '{}': password required but not provided", vault.name));
                continue;
            }
        } else {
            // No password protection - derive key from empty password and vault ID
            // This matches how the frontend derives keys for passwordless vaults
            Some(derive_key_from_password("", &vault.id.to_string(), 100_000))
        };

        let key = key.unwrap();

        // Get all items for this vault (including soft-deleted)
        let items = VaultItem::list_all_by_vault_for_sync(conn, vault.id)
            .map_err(|e| e.to_string())?;

        let mut sync_items = Vec::new();
        for item in items {
            let item_uuid = item.uuid.clone().unwrap_or_else(|| {
                warnings.push(format!("Item '{}' has no UUID, generating one", item.title));
                uuid::Uuid::new_v4().to_string()
            });

            // Decrypt content
            let content = if vault.has_password {
                decrypt_content(&key, &item.content)?
            } else {
                // For non-password vaults, content might still be "encrypted" with empty key
                // Try to decrypt, fall back to treating as plaintext
                decrypt_content(&key, &item.content)
                    .unwrap_or_else(|_| String::from_utf8_lossy(&item.content).to_string())
            };

            sync_items.push(SyncItem {
                uuid: item_uuid,
                title: item.title,
                content,
                created_at: item.created_at,
                updated_at: item.updated_at,
                deleted_at: item.deleted_at,
                image: item.image,
                summary: item.summary,
                sort_order: item.sort_order,
            });
            exported_items += 1;
        }

        sync_vaults.push(SyncVault {
            uuid: vault_uuid,
            name: vault.name,
            created_at: vault.created_at,
            updated_at: vault.updated_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            deleted_at: vault.deleted_at,
            cover_image: vault.cover_image,
            has_password: vault.has_password,
            items: sync_items,
        });
    }

    // Copy captures to sync folder
    let mut sync_captures = Vec::new();
    let local_captures_folder = get_captures_folder()?;
    if local_captures_folder.exists() {
        if let Ok(entries) = fs::read_dir(&local_captures_folder) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                        let dest_path = captures_dest.join(filename);
                        
                        // Only copy if file doesn't exist or is newer
                        let should_copy = if dest_path.exists() {
                            if let (Ok(src_meta), Ok(dest_meta)) = (fs::metadata(&path), fs::metadata(&dest_path)) {
                                src_meta.modified().ok() > dest_meta.modified().ok()
                            } else {
                                true
                            }
                        } else {
                            true
                        };

                        if should_copy {
                            if let Err(e) = fs::copy(&path, &dest_path) {
                                warnings.push(format!("Failed to copy capture '{}': {}", filename, e));
                            }
                        }

                        // Get file metadata for sync file
                        if let Ok(meta) = fs::metadata(&path) {
                            sync_captures.push(SyncCapture {
                                filename: filename.to_string(),
                                created_at: meta.created()
                                    .ok()
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                                        .map(|dt| dt.to_rfc3339())
                                        .unwrap_or_default())
                                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                                size_bytes: meta.len(),
                            });
                        }
                    }
                }
            }
        }
    }

    // Create sync file
    let sync_file = SyncFile {
        format_version: SYNC_FORMAT_VERSION.to_string(),
        device_id,
        device_name: device_name.clone(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        vaults: sync_vaults.clone(),
        captures: sync_captures.clone(),
    };

    // Write sync file
    let sync_file_path = sync_folder.join(SYNC_FILE_NAME);
    let json = serde_json::to_string_pretty(&sync_file)
        .map_err(|e| format!("Failed to serialize sync file: {}", e))?;
    fs::write(&sync_file_path, json)
        .map_err(|e| format!("Failed to write sync file: {}", e))?;

    // Update last_sync_at
    let now = chrono::Utc::now().to_rfc3339();
    SyncSettings::set(conn, "last_sync_at", &now).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "last_sync_device", &device_name).map_err(|e| e.to_string())?;

    Ok(SyncExportResult {
        exported_vaults: sync_vaults.len(),
        exported_items,
        exported_captures: sync_captures.len(),
        skipped_vaults,
        warnings,
    })
}

/// Get sync status information
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncStatus {
    pub sync_enabled: bool,
    pub sync_folder: Option<String>,
    pub device_name: String,
    pub last_sync_at: Option<String>,
    pub last_sync_device: Option<String>,
    pub remote_file_exists: bool,
    pub remote_exported_at: Option<String>,
    pub remote_device_name: Option<String>,
    pub has_changes: bool,
}

pub fn check_sync_status(conn: &Connection) -> Result<SyncStatus, String> {
    // Ensure tables exist and are migrated before any queries
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;

    let sync_folder = get_sync_folder(conn)?;
    let device_name = get_device_name(conn)?;
    let last_sync_at = SyncSettings::get(conn, "last_sync_at").map_err(|e| e.to_string())?;
    let last_sync_device = SyncSettings::get(conn, "last_sync_device").map_err(|e| e.to_string())?;

    let mut remote_file_exists = false;
    let mut remote_exported_at = None;
    let mut remote_device_name = None;
    let mut has_changes = false;

    if let Some(ref folder) = sync_folder {
        let sync_file_path = Path::new(folder).join(SYNC_FILE_NAME);
        if sync_file_path.exists() {
            remote_file_exists = true;
            
            // Try to read the sync file to get metadata
            if let Ok(contents) = fs::read_to_string(&sync_file_path) {
                if let Ok(sync_file) = serde_json::from_str::<SyncFile>(&contents) {
                    remote_exported_at = Some(sync_file.exported_at.clone());
                    remote_device_name = Some(sync_file.device_name.clone());
                    
                    // Check if remote is newer than last sync
                    if let Some(ref last) = last_sync_at {
                        has_changes = sync_file.exported_at > *last;
                    } else {
                        has_changes = true; // Never synced before
                    }
                }
            }
        }
    }

    Ok(SyncStatus {
        sync_enabled: sync_folder.is_some(),
        sync_folder,
        device_name,
        last_sync_at,
        last_sync_device,
        remote_file_exists,
        remote_exported_at,
        remote_device_name,
        has_changes,
    })
}

/// Get list of vaults that need passwords for export
pub fn get_locked_vaults(conn: &Connection) -> Result<Vec<(i64, String)>, String> {
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    
    let vaults = Vault::list(conn).map_err(|e| e.to_string())?;
    let locked: Vec<(i64, String)> = vaults
        .into_iter()
        .filter(|v| v.has_password)
        .map(|v| (v.id, v.name))
        .collect();
    
    Ok(locked)
}

/// Get all sync settings
pub fn get_sync_settings(conn: &Connection) -> Result<HashMap<String, String>, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    
    let settings = SyncSettings::get_all(conn).map_err(|e| e.to_string())?;
    Ok(settings.into_iter().collect())
}

/// Set a sync setting
pub fn set_sync_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, key, value).map_err(|e| e.to_string())
}

// --- Import Functions ---

use rand::{rngs::OsRng, RngCore};

/// Encrypt content using XChaCha20-Poly1305
fn encrypt_content(key: &[u8; 32], plaintext: &str) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "Encryption failed".to_string())?;
    let mut encrypted = nonce_bytes.to_vec();
    encrypted.extend(ciphertext);
    Ok(encrypted)
}

/// Derive key from password using PBKDF2
fn derive_key_from_password(password: &str, salt: &str, iterations: u32) -> [u8; 32] {
    use pbkdf2::pbkdf2_hmac;
    use sha2::Sha256;
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt.as_bytes(), iterations, &mut key);
    key
}

/// Encrypt password for vault storage
fn encrypt_password(key: &[u8; 32], password: &str) -> Result<Vec<u8>, String> {
    encrypt_content(key, password)
}

/// Import sync file and merge with local database
/// passwords: Map of vault_uuid -> password (for re-encrypting imported items)
pub fn sync_import(
    conn: &Connection,
    passwords: HashMap<String, String>,
) -> Result<SyncImportResult, String> {
    // Ensure tables exist
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;

    // Get sync folder
    let sync_folder_str = get_sync_folder(conn)?
        .ok_or("Sync folder not configured. Please set a sync folder in settings.")?;
    let sync_folder = Path::new(&sync_folder_str);

    // Read sync file
    let sync_file_path = sync_folder.join(SYNC_FILE_NAME);
    if !sync_file_path.exists() {
        return Err("Sync file not found. No sync data available.".to_string());
    }

    let contents = fs::read_to_string(&sync_file_path)
        .map_err(|e| format!("Failed to read sync file: {}", e))?;
    let sync_file: SyncFile = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse sync file: {}", e))?;

    // Validate format version
    if sync_file.format_version != SYNC_FORMAT_VERSION {
        return Err(format!(
            "Unsupported sync file format version: {}. Expected: {}",
            sync_file.format_version, SYNC_FORMAT_VERSION
        ));
    }

    let last_sync_at = SyncSettings::get(conn, "last_sync_at").map_err(|e| e.to_string())?;

    let mut imported_vaults = 0;
    let mut imported_items = 0;
    let mut conflicts = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped_vaults = Vec::new();

    // Process each vault from sync file
    for sync_vault in &sync_file.vaults {
        // Check if we have a password for this vault (if it has password protection)
        let password_opt = passwords.get(&sync_vault.uuid);
        
        // Check if vault exists locally by UUID
        let local_vault = Vault::get_by_uuid(conn, &sync_vault.uuid).map_err(|e| e.to_string())?;

        match local_vault {
            Some(existing_vault) => {
                // Vault exists - check if we need to update
                let local_updated_at = existing_vault.updated_at.clone().unwrap_or_default();
                
                // Handle soft delete sync
                if sync_vault.deleted_at.is_some() && existing_vault.deleted_at.is_none() {
                    // Remote is deleted, apply locally
                    let now = chrono::Utc::now().to_rfc3339();
                    conn.execute(
                        "UPDATE vaults SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![sync_vault.deleted_at, now, existing_vault.id],
                    ).map_err(|e| e.to_string())?;
                    
                    // Also soft-delete all items
                    conn.execute(
                        "UPDATE vault_items SET deleted_at = ?1 WHERE vault_id = ?2 AND deleted_at IS NULL",
                        rusqlite::params![sync_vault.deleted_at, existing_vault.id],
                    ).map_err(|e| e.to_string())?;
                    
                    imported_vaults += 1;
                    continue;
                }

                // Check if remote is newer
                if sync_vault.updated_at > local_updated_at {
                    // Update vault metadata
                    conn.execute(
                        "UPDATE vaults SET name = ?1, cover_image = ?2, updated_at = ?3 WHERE id = ?4",
                        rusqlite::params![
                            sync_vault.name,
                            sync_vault.cover_image,
                            sync_vault.updated_at,
                            existing_vault.id
                        ],
                    ).map_err(|e| e.to_string())?;
                    imported_vaults += 1;
                }

                // Get local key for re-encryption
                let local_key = if existing_vault.has_password {
                    if let Some(pwd) = password_opt {
                        derive_key_from_password(pwd, &existing_vault.id.to_string(), 100_000)
                    } else {
                        skipped_vaults.push(sync_vault.name.clone());
                        warnings.push(format!("Skipped vault '{}': password required but not provided", sync_vault.name));
                        continue;
                    }
                } else {
                    // No password protection - derive key from empty password and vault ID
                    // This matches how the frontend derives keys for passwordless vaults
                    derive_key_from_password("", &existing_vault.id.to_string(), 100_000)
                };

                // Process items
                for sync_item in &sync_vault.items {
                    let import_result = import_item(
                        conn,
                        existing_vault.id,
                        sync_item,
                        &local_key,
                        &last_sync_at,
                    )?;
                    
                    match import_result {
                        ImportItemResult::Imported => imported_items += 1,
                        ImportItemResult::Updated => imported_items += 1,
                        ImportItemResult::Conflict(title) => {
                            conflicts.push(title);
                            imported_items += 1;
                        }
                        ImportItemResult::Skipped => {}
                        ImportItemResult::Deleted => imported_items += 1,
                    }
                }
            }
            None => {
                // New vault - create it
                if sync_vault.deleted_at.is_some() {
                    // Don't import deleted vaults that don't exist locally
                    continue;
                }

                // Get password for new vault
                // For passwordless vaults, we'll derive the key after we have the vault ID
                let (temp_key, has_password, encrypted_password) = if sync_vault.has_password {
                    if let Some(pwd) = password_opt {
                        // Create new vault with the provided password
                        let now = chrono::Utc::now();
                        let temp_id = now.timestamp_nanos_opt().unwrap_or(0);
                        let key = derive_key_from_password(pwd, &temp_id.to_string(), 100_000);
                        let enc_pwd = encrypt_password(&key, pwd)?;
                        (key, true, enc_pwd)
                    } else {
                        skipped_vaults.push(sync_vault.name.clone());
                        warnings.push(format!("Skipped vault '{}': password required for new vault", sync_vault.name));
                        continue;
                    }
                } else {
                    // Temporary key - will be replaced after vault creation with proper derivation
                    ([0u8; 32], false, Vec::new())
                };

                // Insert new vault
                let now = chrono::Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT INTO vaults (name, encrypted_password, created_at, cover_image, has_password, uuid, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        sync_vault.name,
                        encrypted_password,
                        sync_vault.created_at,
                        sync_vault.cover_image,
                        has_password,
                        sync_vault.uuid,
                        now
                    ],
                ).map_err(|e| e.to_string())?;

                let vault_id = conn.last_insert_rowid();

                // Re-derive key with actual vault ID
                let final_key = if has_password {
                    if let Some(pwd) = password_opt {
                        let key = derive_key_from_password(pwd, &vault_id.to_string(), 100_000);
                        // Update encrypted password with correct key
                        let enc_pwd = encrypt_password(&key, pwd)?;
                        conn.execute(
                            "UPDATE vaults SET encrypted_password = ?1 WHERE id = ?2",
                            rusqlite::params![enc_pwd, vault_id],
                        ).map_err(|e| e.to_string())?;
                        key
                    } else {
                        temp_key
                    }
                } else {
                    // No password protection - derive key from empty password and vault ID
                    // This matches how the frontend derives keys for passwordless vaults
                    derive_key_from_password("", &vault_id.to_string(), 100_000)
                };

                imported_vaults += 1;

                // Import all items
                for sync_item in &sync_vault.items {
                    if sync_item.deleted_at.is_some() {
                        continue; // Don't import deleted items for new vaults
                    }

                    // Encrypt content with local key
                    let encrypted_content = encrypt_content(&final_key, &sync_item.content)?;

                    // Insert item
                    conn.execute(
                        "INSERT INTO vault_items (vault_id, title, content, created_at, updated_at, image, summary, sort_order, uuid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        rusqlite::params![
                            vault_id,
                            sync_item.title,
                            encrypted_content,
                            sync_item.created_at,
                            sync_item.updated_at,
                            sync_item.image,
                            sync_item.summary,
                            sync_item.sort_order,
                            sync_item.uuid
                        ],
                    ).map_err(|e| e.to_string())?;

                    imported_items += 1;
                }
            }
        }
    }

    // Copy captures from sync folder
    let captures_src = sync_folder.join(CAPTURES_FOLDER_NAME);
    let local_captures_folder = get_captures_folder()?;
    let mut imported_captures = 0;

    if captures_src.exists() {
        // Create local captures folder if it doesn't exist
        if !local_captures_folder.exists() {
            fs::create_dir_all(&local_captures_folder)
                .map_err(|e| format!("Failed to create local captures folder: {}", e))?;
        }

        if let Ok(entries) = fs::read_dir(&captures_src) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                        let dest_path = local_captures_folder.join(filename);
                        
                        // Only copy if file doesn't exist locally
                        if !dest_path.exists() {
                            if let Err(e) = fs::copy(&path, &dest_path) {
                                warnings.push(format!("Failed to copy capture '{}': {}", filename, e));
                            } else {
                                imported_captures += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    // Update last_sync_at
    let now = chrono::Utc::now().to_rfc3339();
    SyncSettings::set(conn, "last_sync_at", &now).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "last_sync_device", &sync_file.device_name).map_err(|e| e.to_string())?;

    // Note: Search index rebuild should be triggered by the frontend after import

    Ok(SyncImportResult {
        imported_vaults,
        imported_items,
        imported_captures,
        conflicts,
        warnings,
        skipped_vaults,
    })
}

/// Result of importing a single item
enum ImportItemResult {
    Imported,
    Updated,
    Conflict(String),
    Skipped,
    Deleted,
}

/// Import a single item, handling merge logic
fn import_item(
    conn: &Connection,
    vault_id: i64,
    sync_item: &SyncItem,
    key: &[u8; 32],
    last_sync_at: &Option<String>,
) -> Result<ImportItemResult, String> {
    // Check if item exists locally by UUID
    let local_item = VaultItem::get_by_uuid(conn, &sync_item.uuid).map_err(|e| e.to_string())?;

    match local_item {
        Some(existing_item) => {
            // Handle soft delete sync
            if sync_item.deleted_at.is_some() && existing_item.deleted_at.is_none() {
                // Remote is deleted, apply locally
                conn.execute(
                    "UPDATE vault_items SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                    rusqlite::params![sync_item.deleted_at, sync_item.updated_at, existing_item.id],
                ).map_err(|e| e.to_string())?;
                return Ok(ImportItemResult::Deleted);
            }

            // Skip if remote item is deleted (already handled above if local wasn't)
            if sync_item.deleted_at.is_some() {
                return Ok(ImportItemResult::Skipped);
            }

            let local_updated_at = existing_item.updated_at.clone();
            let remote_updated_at = &sync_item.updated_at;

            // Check for conflict: both modified since last sync
            let is_conflict = if let Some(ref last) = last_sync_at {
                local_updated_at > *last && *remote_updated_at > *last && local_updated_at != *remote_updated_at
            } else {
                false
            };

            if is_conflict {
                // Create conflict copy
                let conflict_title = format!("{} [Conflict]", sync_item.title);
                let encrypted_content = encrypt_content(key, &sync_item.content)?;
                let new_uuid = uuid::Uuid::new_v4().to_string();

                conn.execute(
                    "INSERT INTO vault_items (vault_id, title, content, created_at, updated_at, image, summary, sort_order, uuid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    rusqlite::params![
                        vault_id,
                        conflict_title,
                        encrypted_content,
                        sync_item.created_at,
                        sync_item.updated_at,
                        sync_item.image,
                        sync_item.summary,
                        sync_item.sort_order,
                        new_uuid
                    ],
                ).map_err(|e| e.to_string())?;

                return Ok(ImportItemResult::Conflict(sync_item.title.clone()));
            }

            // Check if remote is newer
            if *remote_updated_at > local_updated_at {
                // Update with remote content
                let encrypted_content = encrypt_content(key, &sync_item.content)?;

                conn.execute(
                    "UPDATE vault_items SET title = ?1, content = ?2, updated_at = ?3, image = ?4, summary = ?5, sort_order = ?6 WHERE id = ?7",
                    rusqlite::params![
                        sync_item.title,
                        encrypted_content,
                        sync_item.updated_at,
                        sync_item.image,
                        sync_item.summary,
                        sync_item.sort_order,
                        existing_item.id
                    ],
                ).map_err(|e| e.to_string())?;

                return Ok(ImportItemResult::Updated);
            }

            Ok(ImportItemResult::Skipped)
        }
        None => {
            // New item
            if sync_item.deleted_at.is_some() {
                // Don't import deleted items that don't exist locally
                return Ok(ImportItemResult::Skipped);
            }

            // Encrypt content with local key
            let encrypted_content = encrypt_content(key, &sync_item.content)?;

            conn.execute(
                "INSERT INTO vault_items (vault_id, title, content, created_at, updated_at, image, summary, sort_order, uuid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    vault_id,
                    sync_item.title,
                    encrypted_content,
                    sync_item.created_at,
                    sync_item.updated_at,
                    sync_item.image,
                    sync_item.summary,
                    sync_item.sort_order,
                    sync_item.uuid
                ],
            ).map_err(|e| e.to_string())?;

            Ok(ImportItemResult::Imported)
        }
    }
}

/// Get information about the remote sync file (preview before import)
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncPreview {
    pub device_name: String,
    pub exported_at: String,
    pub vault_count: usize,
    pub item_count: usize,
    pub capture_count: usize,
    pub vaults_needing_password: Vec<String>, // Names of vaults that need passwords
}

// --- Purge Functions ---

/// Result of purging deleted items
#[derive(Debug, Serialize, Deserialize)]
pub struct PurgeResult {
    pub purged_vaults: usize,
    pub purged_items: usize,
}

/// Purge items and vaults that have been soft-deleted for more than X days
pub fn purge_deleted_items(conn: &Connection, days: i32) -> Result<PurgeResult, String> {
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(conn).map_err(|e| e.to_string())?;

    // Calculate cutoff date
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let cutoff_str = cutoff.to_rfc3339();

    // First, hard delete items that were soft-deleted before cutoff
    let purged_items = conn.execute(
        "DELETE FROM vault_items WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        rusqlite::params![cutoff_str],
    ).map_err(|e| e.to_string())?;

    // Then, hard delete vaults (and their remaining items) that were soft-deleted before cutoff
    // First get the vault IDs to delete
    let mut stmt = conn.prepare("SELECT id FROM vaults WHERE deleted_at IS NOT NULL AND deleted_at < ?1")
        .map_err(|e| e.to_string())?;
    let vault_ids: Vec<i64> = stmt.query_map([&cutoff_str], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let purged_vaults = vault_ids.len();

    // Delete items belonging to these vaults, then the vaults themselves
    for vault_id in vault_ids {
        conn.execute("DELETE FROM vault_items WHERE vault_id = ?1", [vault_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM vaults WHERE id = ?1", [vault_id])
            .map_err(|e| e.to_string())?;
    }

    Ok(PurgeResult {
        purged_vaults,
        purged_items,
    })
}

/// Get the configured purge days (default 30)
pub fn get_purge_days(conn: &Connection) -> Result<i32, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    
    if let Some(days_str) = SyncSettings::get(conn, "purge_deleted_after_days").map_err(|e| e.to_string())? {
        days_str.parse().map_err(|_| "Invalid purge days value".to_string())
    } else {
        Ok(30) // Default
    }
}

/// Set the configured purge days
pub fn set_purge_days(conn: &Connection, days: i32) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "purge_deleted_after_days", &days.to_string()).map_err(|e| e.to_string())
}

/// Check if sync is enabled and auto-purge should run
pub fn should_auto_purge(conn: &Connection) -> Result<bool, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    
    // Purge is only relevant if sync is enabled
    let sync_folder = get_sync_folder(conn)?;
    Ok(sync_folder.is_some())
}

// --- Auto-trigger settings ---

/// Check if "sync on close" is enabled
pub fn is_sync_on_close_enabled(conn: &Connection) -> Result<bool, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    
    if let Some(val) = SyncSettings::get(conn, "sync_on_close").map_err(|e| e.to_string())? {
        Ok(val == "true" || val == "1")
    } else {
        Ok(false) // Default to disabled
    }
}

/// Set "sync on close" setting
pub fn set_sync_on_close(conn: &Connection, enabled: bool) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "sync_on_close", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

/// Check if "check for sync on startup" is enabled
pub fn is_check_sync_on_startup_enabled(conn: &Connection) -> Result<bool, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    
    if let Some(val) = SyncSettings::get(conn, "check_sync_on_startup").map_err(|e| e.to_string())? {
        Ok(val == "true" || val == "1")
    } else {
        Ok(true) // Default to enabled
    }
}

/// Set "check for sync on startup" setting  
pub fn set_check_sync_on_startup(conn: &Connection, enabled: bool) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "check_sync_on_startup", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

/// Set device name
pub fn set_device_name(conn: &Connection, name: &str) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "device_name", name).map_err(|e| e.to_string())
}

pub fn get_sync_preview(conn: &Connection) -> Result<Option<SyncPreview>, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;

    let sync_folder_str = match get_sync_folder(conn)? {
        Some(f) => f,
        None => return Ok(None),
    };
    let sync_folder = Path::new(&sync_folder_str);
    let sync_file_path = sync_folder.join(SYNC_FILE_NAME);

    if !sync_file_path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&sync_file_path)
        .map_err(|e| format!("Failed to read sync file: {}", e))?;
    let sync_file: SyncFile = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse sync file: {}", e))?;

    let item_count: usize = sync_file.vaults.iter().map(|v| v.items.len()).sum();
    
    // Find vaults that need passwords (either new vaults with password or existing with password)
    let local_vaults = Vault::list(conn).map_err(|e| e.to_string())?;
    let local_vault_uuids: std::collections::HashSet<String> = local_vaults
        .iter()
        .filter_map(|v| v.uuid.clone())
        .collect();

    let vaults_needing_password: Vec<String> = sync_file.vaults
        .iter()
        .filter(|v| {
            v.has_password && v.deleted_at.is_none() && (
                // New vault with password
                !local_vault_uuids.contains(&v.uuid) ||
                // Existing vault with password
                local_vaults.iter().any(|lv| lv.uuid.as_ref() == Some(&v.uuid) && lv.has_password)
            )
        })
        .map(|v| v.name.clone())
        .collect();

    Ok(Some(SyncPreview {
        device_name: sync_file.device_name,
        exported_at: sync_file.exported_at,
        vault_count: sync_file.vaults.iter().filter(|v| v.deleted_at.is_none()).count(),
        item_count,
        capture_count: sync_file.captures.len(),
        vaults_needing_password,
    }))
}
