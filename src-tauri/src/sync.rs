// sync.rs - Sync functionality for brainbox
// Handles export/import of vaults to sync folder for cross-device synchronization

use crate::vault::{SyncSettings, Vault, VaultItem};
use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Sync file format version
pub const SYNC_FORMAT_VERSION: &str = "1.0";

/// Encrypted sync envelope format version
pub const SYNC_ENVELOPE_FORMAT_VERSION: &str = "2.0";

const SYNC_ENVELOPE_ENCRYPTION: &str = "xchacha20poly1305";
const SYNC_ENVELOPE_KDF: &str = "pbkdf2-hmac-sha256";
const SYNC_ENVELOPE_ITERATIONS: u32 = 210_000;

/// Sync file name
pub const SYNC_FILE_NAME: &str = "brainbox.sync";

/// Captures subfolder name
pub const CAPTURES_FOLDER_NAME: &str = "captures";

const DATA_DIR_ENV: &str = "BRAINBOX_DATA_DIR";

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
    pub content: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub content_encrypted: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub summary_encrypted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<i64>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncCapture {
    pub filename: String,
    pub created_at: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EncryptedSyncEnvelope {
    pub format_version: String,
    pub encryption: String,
    pub kdf: String,
    pub kdf_iterations: u32,
    pub exported_at: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

struct LoadedSyncFile {
    sync_file: SyncFile,
    encrypted: bool,
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
    let app_dir = if let Ok(path) = std::env::var(DATA_DIR_ENV) {
        let data_dir = PathBuf::from(path);
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create app data dir override: {}", e))?;
        data_dir
    } else {
        dirs::data_local_dir().ok_or("Failed to get app data dir")?
    };
    Ok(app_dir.join("brainbox_captures"))
}

// --- Export Functions ---

/// Export all vaults and captures to sync folder
/// passwords: Map of vault_id -> vault password. Passwords are used to decrypt local
/// vault items and derive portable per-vault sync keys from vault UUIDs.
pub fn sync_export(
    conn: &Connection,
    passwords: HashMap<i64, String>,
    sync_passphrase: Option<&str>,
) -> Result<SyncExportResult, String> {
    let sync_passphrase = normalize_sync_passphrase(sync_passphrase)?;

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
            warnings.push(format!(
                "Vault '{}' has no UUID, generating one",
                vault.name
            ));
            uuid::Uuid::new_v4().to_string()
        });

        let (local_key, sync_key) = if vault.has_password {
            if let Some(password) = passwords.get(&vault.id) {
                (
                    derive_key_from_password(password, &vault.id.to_string(), 100_000),
                    portable_sync_key(&vault_uuid, password),
                )
            } else {
                skipped_vaults.push(vault.name.clone());
                warnings.push(format!(
                    "Skipped vault '{}': password required but not provided",
                    vault.name
                ));
                continue;
            }
        } else {
            // No password protection - derive key from empty password and vault ID
            // This matches how the frontend derives keys for passwordless vaults
            (
                derive_key_from_password("", &vault.id.to_string(), 100_000),
                portable_sync_key(&vault_uuid, ""),
            )
        };

        // Get all items for this vault (including soft-deleted)
        let items =
            VaultItem::list_all_by_vault_for_sync(conn, vault.id).map_err(|e| e.to_string())?;

        let mut sync_items = Vec::new();
        for item in items {
            let item_uuid = item.uuid.clone().unwrap_or_else(|| {
                warnings.push(format!("Item '{}' has no UUID, generating one", item.title));
                uuid::Uuid::new_v4().to_string()
            });

            // Decrypt content
            let content = if vault.has_password {
                decrypt_content(&local_key, &item.content)?
            } else {
                // For non-password vaults, content might still be "encrypted" with empty key
                // Try to decrypt, fall back to treating as plaintext
                decrypt_content(&local_key, &item.content)
                    .unwrap_or_else(|_| String::from_utf8_lossy(&item.content).to_string())
            };
            let encrypted_content = encrypt_sync_field(&sync_key, &content)?;
            let encrypted_summary = item
                .summary
                .as_deref()
                .map(|summary| encrypt_sync_field(&sync_key, summary))
                .transpose()?;

            sync_items.push(SyncItem {
                uuid: item_uuid,
                title: item.title,
                content: encrypted_content,
                content_encrypted: true,
                created_at: item.created_at,
                updated_at: item.updated_at,
                deleted_at: item.deleted_at,
                image: item.image,
                summary: encrypted_summary,
                summary_encrypted: item.summary.is_some(),
                sort_order: item.sort_order,
            });
            exported_items += 1;
        }

        sync_vaults.push(SyncVault {
            uuid: vault_uuid,
            name: vault.name,
            created_at: vault.created_at,
            updated_at: vault
                .updated_at
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            deleted_at: vault.deleted_at,
            cover_image: vault.cover_image,
            has_password: vault.has_password,
            items: sync_items,
        });
    }

    // Standalone capture files are intentionally not copied for encrypted sync.
    // They live outside the JSON payload, so syncing them plaintext would leak data
    // that the envelope is meant to protect. Images embedded in vault items remain
    // inside the encrypted sync file.
    let sync_captures = Vec::new();

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
    let envelope = encrypt_sync_envelope(&sync_file, sync_passphrase)?;
    let json = serde_json::to_string_pretty(&envelope)
        .map_err(|e| format!("Failed to serialize sync file: {}", e))?;
    fs::write(&sync_file_path, json).map_err(|e| format!("Failed to write sync file: {}", e))?;

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
    let last_sync_device =
        SyncSettings::get(conn, "last_sync_device").map_err(|e| e.to_string())?;

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
                if let Ok((exported_at, device_name, _encrypted)) =
                    read_sync_file_metadata(&contents)
                {
                    remote_exported_at = Some(exported_at.clone());
                    remote_device_name = Some(device_name);

                    // Check if remote is newer than last sync
                    if let Some(ref last) = last_sync_at {
                        has_changes = exported_at > *last;
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

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("Invalid encrypted sync payload".to_string());
    }

    (0..hex.len())
        .step_by(2)
        .map(|idx| {
            u8::from_str_radix(&hex[idx..idx + 2], 16)
                .map_err(|_| "Invalid encrypted sync payload".to_string())
        })
        .collect()
}

fn normalize_sync_passphrase(sync_passphrase: Option<&str>) -> Result<&str, String> {
    sync_passphrase
        .map(str::trim)
        .filter(|passphrase| !passphrase.is_empty())
        .ok_or_else(|| "Sync file passphrase is required for encrypted sync export.".to_string())
}

fn derive_sync_envelope_key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    use pbkdf2::pbkdf2_hmac;
    use sha2::Sha256;
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, iterations, &mut key);
    key
}

fn encrypt_sync_envelope(
    sync_file: &SyncFile,
    sync_passphrase: &str,
) -> Result<EncryptedSyncEnvelope, String> {
    let plaintext = serde_json::to_vec(sync_file)
        .map_err(|e| format!("Failed to serialize sync file: {}", e))?;

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_bytes);

    let key = derive_sync_envelope_key(sync_passphrase, &salt, SYNC_ENVELOPE_ITERATIONS);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_slice())
        .map_err(|_| "Failed to encrypt sync file".to_string())?;

    Ok(EncryptedSyncEnvelope {
        format_version: SYNC_ENVELOPE_FORMAT_VERSION.to_string(),
        encryption: SYNC_ENVELOPE_ENCRYPTION.to_string(),
        kdf: SYNC_ENVELOPE_KDF.to_string(),
        kdf_iterations: SYNC_ENVELOPE_ITERATIONS,
        exported_at: sync_file.exported_at.clone(),
        salt: bytes_to_hex(&salt),
        nonce: bytes_to_hex(&nonce_bytes),
        ciphertext: bytes_to_hex(&ciphertext),
    })
}

fn decrypt_sync_envelope(
    envelope: &EncryptedSyncEnvelope,
    sync_passphrase: &str,
) -> Result<SyncFile, String> {
    if envelope.format_version != SYNC_ENVELOPE_FORMAT_VERSION {
        return Err(format!(
            "Unsupported encrypted sync file format version: {}. Expected: {}",
            envelope.format_version, SYNC_ENVELOPE_FORMAT_VERSION
        ));
    }
    if envelope.encryption != SYNC_ENVELOPE_ENCRYPTION || envelope.kdf != SYNC_ENVELOPE_KDF {
        return Err("Unsupported encrypted sync file parameters.".to_string());
    }

    let salt = hex_to_bytes(&envelope.salt)?;
    let nonce_bytes = hex_to_bytes(&envelope.nonce)?;
    let ciphertext = hex_to_bytes(&envelope.ciphertext)?;
    if nonce_bytes.len() != 24 {
        return Err("Invalid encrypted sync file nonce.".to_string());
    }

    let key = derive_sync_envelope_key(sync_passphrase, &salt, envelope.kdf_iterations);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce = XNonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_slice())
        .map_err(|_| "Failed to decrypt sync file. Check the sync file passphrase.".to_string())?;

    serde_json::from_slice::<SyncFile>(&plaintext)
        .map_err(|e| format!("Failed to parse decrypted sync file: {}", e))
}

fn parse_encrypted_sync_envelope(contents: &str) -> Result<Option<EncryptedSyncEnvelope>, String> {
    let value: serde_json::Value =
        serde_json::from_str(contents).map_err(|e| format!("Failed to parse sync file: {}", e))?;

    if value.get("ciphertext").is_none() {
        return Ok(None);
    }

    serde_json::from_value::<EncryptedSyncEnvelope>(value)
        .map(Some)
        .map_err(|e| format!("Failed to parse encrypted sync file: {}", e))
}

fn read_sync_file(contents: &str, sync_passphrase: Option<&str>) -> Result<LoadedSyncFile, String> {
    if let Some(envelope) = parse_encrypted_sync_envelope(contents)? {
        let passphrase = normalize_sync_passphrase(sync_passphrase).map_err(|_| {
            "Sync file passphrase is required to read this encrypted sync file.".to_string()
        })?;
        let sync_file = decrypt_sync_envelope(&envelope, passphrase)?;
        return Ok(LoadedSyncFile {
            sync_file,
            encrypted: true,
        });
    }

    let sync_file: SyncFile =
        serde_json::from_str(contents).map_err(|e| format!("Failed to parse sync file: {}", e))?;
    Ok(LoadedSyncFile {
        sync_file,
        encrypted: false,
    })
}

fn read_sync_file_metadata(contents: &str) -> Result<(String, String, bool), String> {
    if let Some(envelope) = parse_encrypted_sync_envelope(contents)? {
        return Ok((
            envelope.exported_at,
            "Encrypted sync file".to_string(),
            true,
        ));
    }

    let sync_file: SyncFile =
        serde_json::from_str(contents).map_err(|e| format!("Failed to parse sync file: {}", e))?;
    Ok((sync_file.exported_at, sync_file.device_name, false))
}

fn encrypt_sync_field(sync_key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    encrypt_content(sync_key, plaintext).map(|bytes| bytes_to_hex(&bytes))
}

fn decrypt_sync_field(sync_key: &[u8; 32], ciphertext_hex: &str) -> Result<String, String> {
    let ciphertext = hex_to_bytes(ciphertext_hex)?;
    decrypt_content(sync_key, &ciphertext)
}

fn portable_sync_key(vault_uuid: &str, password: &str) -> [u8; 32] {
    derive_key_from_password(password, vault_uuid, 100_000)
}

fn sync_item_plaintext(
    sync_vault: &SyncVault,
    sync_item: &SyncItem,
    password: Option<&String>,
) -> Result<SyncItem, String> {
    if !sync_item.content_encrypted && !sync_item.summary_encrypted {
        return Ok(sync_item.clone());
    }

    let password: &str = if sync_vault.has_password {
        password
            .map(|value| value.as_str())
            .ok_or_else(|| format!("Password required for vault '{}'", sync_vault.name))?
    } else {
        ""
    };
    let sync_key = portable_sync_key(&sync_vault.uuid, password);
    let mut plain_item = sync_item.clone();

    if sync_item.content_encrypted {
        plain_item.content = decrypt_sync_field(&sync_key, &sync_item.content)?;
        plain_item.content_encrypted = false;
    }

    if sync_item.summary_encrypted {
        if let Some(summary) = &sync_item.summary {
            plain_item.summary = Some(decrypt_sync_field(&sync_key, summary)?);
        }
        plain_item.summary_encrypted = false;
    }

    Ok(plain_item)
}

/// Derive key from password using PBKDF2
fn derive_key_from_password(password: &str, salt: &str, iterations: u32) -> [u8; 32] {
    use pbkdf2::pbkdf2_hmac;
    use sha2::Sha256;
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt.as_bytes(), iterations, &mut key);
    key
}

fn index_sync_item_with_title(item_id: i64, vault_id: i64, title: &str, sync_item: &SyncItem) {
    let item_type =
        if sync_item.content.starts_with("http://") || sync_item.content.starts_with("https://") {
            "url"
        } else {
            "note"
        };

    let _ = crate::search::index_document(
        item_id.to_string(),
        title.to_string(),
        sync_item.content.clone(),
        item_type.to_string(),
        sync_item.created_at.clone(),
        sync_item.updated_at.clone(),
        Some(format!("vault/{}/item/{}", vault_id, item_id)),
        vec![],
    );
}

fn index_sync_item(item_id: i64, vault_id: i64, sync_item: &SyncItem) {
    index_sync_item_with_title(item_id, vault_id, &sync_item.title, sync_item);
}

fn remove_indexed_item(item_id: i64) {
    let _ = crate::search::delete_document(item_id.to_string());
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
    sync_passphrase: Option<&str>,
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
    let loaded_sync = read_sync_file(&contents, sync_passphrase)?;
    let sync_file = loaded_sync.sync_file;

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
                    )
                    .map_err(|e| e.to_string())?;

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
                        warnings.push(format!(
                            "Skipped vault '{}': password required but not provided",
                            sync_vault.name
                        ));
                        continue;
                    }
                } else {
                    // No password protection - derive key from empty password and vault ID
                    // This matches how the frontend derives keys for passwordless vaults
                    derive_key_from_password("", &existing_vault.id.to_string(), 100_000)
                };

                // Process items
                for sync_item in &sync_vault.items {
                    let plain_item = sync_item_plaintext(sync_vault, sync_item, password_opt)?;
                    let import_result = import_item(
                        conn,
                        existing_vault.id,
                        &plain_item,
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
                        warnings.push(format!(
                            "Skipped vault '{}': password required for new vault",
                            sync_vault.name
                        ));
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
                        )
                        .map_err(|e| e.to_string())?;
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
                    let plain_item = sync_item_plaintext(sync_vault, sync_item, password_opt)?;

                    // Encrypt content with local key
                    let encrypted_content = encrypt_content(&final_key, &plain_item.content)?;

                    // Insert item
                    conn.execute(
                        "INSERT INTO vault_items (vault_id, title, content, created_at, updated_at, image, summary, sort_order, uuid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        rusqlite::params![
                            vault_id,
                            &plain_item.title,
                            encrypted_content,
                            &plain_item.created_at,
                            &plain_item.updated_at,
                            &plain_item.image,
                            &plain_item.summary,
                            plain_item.sort_order,
                            &plain_item.uuid
                        ],
                    ).map_err(|e| e.to_string())?;

                    let item_id = conn.last_insert_rowid();
                    index_sync_item(item_id, vault_id, &plain_item);

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
                                warnings
                                    .push(format!("Failed to copy capture '{}': {}", filename, e));
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
    SyncSettings::set(conn, "last_sync_device", &sync_file.device_name)
        .map_err(|e| e.to_string())?;

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
                )
                .map_err(|e| e.to_string())?;
                remove_indexed_item(existing_item.id);
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
                local_updated_at > *last
                    && *remote_updated_at > *last
                    && local_updated_at != *remote_updated_at
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

                let item_id = conn.last_insert_rowid();
                index_sync_item_with_title(item_id, vault_id, &conflict_title, sync_item);

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
                index_sync_item(existing_item.id, vault_id, sync_item);

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

            let item_id = conn.last_insert_rowid();
            index_sync_item(item_id, vault_id, sync_item);

            Ok(ImportItemResult::Imported)
        }
    }
}

/// Vault info for password entry during import
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultPasswordInfo {
    pub uuid: String,
    pub name: String,
}

/// Get information about the remote sync file (preview before import)
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncPreview {
    pub device_name: String,
    pub exported_at: String,
    pub vault_count: usize,
    pub item_count: usize,
    pub capture_count: usize,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default)]
    pub needs_sync_passphrase: bool,
    pub vaults_needing_password: Vec<VaultPasswordInfo>, // Vaults that need passwords (with UUID and name)
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
    let purged_items = conn
        .execute(
            "DELETE FROM vault_items WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            rusqlite::params![cutoff_str],
        )
        .map_err(|e| e.to_string())?;

    // Then, hard delete vaults (and their remaining items) that were soft-deleted before cutoff
    // First get the vault IDs to delete
    let mut stmt = conn
        .prepare("SELECT id FROM vaults WHERE deleted_at IS NOT NULL AND deleted_at < ?1")
        .map_err(|e| e.to_string())?;
    let vault_ids: Vec<i64> = stmt
        .query_map([&cutoff_str], |row| row.get(0))
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

    if let Some(days_str) =
        SyncSettings::get(conn, "purge_deleted_after_days").map_err(|e| e.to_string())?
    {
        days_str
            .parse()
            .map_err(|_| "Invalid purge days value".to_string())
    } else {
        Ok(30) // Default
    }
}

/// Set the configured purge days
#[allow(dead_code)]
pub fn set_purge_days(conn: &Connection, days: i32) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "purge_deleted_after_days", &days.to_string())
        .map_err(|e| e.to_string())
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
    SyncSettings::set(
        conn,
        "sync_on_close",
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())
}

/// Check if "check for sync on startup" is enabled
pub fn is_check_sync_on_startup_enabled(conn: &Connection) -> Result<bool, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;

    if let Some(val) =
        SyncSettings::get(conn, "check_sync_on_startup").map_err(|e| e.to_string())?
    {
        Ok(val == "true" || val == "1")
    } else {
        Ok(true) // Default to enabled
    }
}

/// Set "check for sync on startup" setting  
pub fn set_check_sync_on_startup(conn: &Connection, enabled: bool) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(
        conn,
        "check_sync_on_startup",
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())
}

/// Set device name
pub fn set_device_name(conn: &Connection, name: &str) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "device_name", name).map_err(|e| e.to_string())
}

pub fn get_sync_preview(
    conn: &Connection,
    sync_passphrase: Option<&str>,
) -> Result<Option<SyncPreview>, String> {
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
    let loaded_sync = match read_sync_file(&contents, sync_passphrase) {
        Ok(loaded_sync) => loaded_sync,
        Err(err) if err.contains("passphrase is required") => {
            let (exported_at, device_name, encrypted) = read_sync_file_metadata(&contents)?;
            return Ok(Some(SyncPreview {
                device_name,
                exported_at,
                vault_count: 0,
                item_count: 0,
                capture_count: 0,
                encrypted,
                needs_sync_passphrase: encrypted,
                vaults_needing_password: Vec::new(),
            }));
        }
        Err(err) => return Err(err),
    };
    let sync_file = loaded_sync.sync_file;

    // Count only non-deleted items from non-deleted vaults
    let item_count: usize = sync_file
        .vaults
        .iter()
        .filter(|v| v.deleted_at.is_none())
        .map(|v| v.items.iter().filter(|i| i.deleted_at.is_none()).count())
        .sum();

    // Find vaults that need passwords (either new vaults with password or existing with password)
    let local_vaults = Vault::list(conn).map_err(|e| e.to_string())?;
    let local_vault_uuids: std::collections::HashSet<String> =
        local_vaults.iter().filter_map(|v| v.uuid.clone()).collect();

    let vaults_needing_password: Vec<VaultPasswordInfo> = sync_file
        .vaults
        .iter()
        .filter(|v| {
            v.has_password
                && v.deleted_at.is_none()
                && (
                    // New vault with password
                    !local_vault_uuids.contains(&v.uuid) ||
                // Existing vault with password
                local_vaults.iter().any(|lv| lv.uuid.as_ref() == Some(&v.uuid) && lv.has_password)
                )
        })
        .map(|v| VaultPasswordInfo {
            uuid: v.uuid.clone(),
            name: v.name.clone(),
        })
        .collect();

    Ok(Some(SyncPreview {
        device_name: sync_file.device_name,
        exported_at: sync_file.exported_at,
        vault_count: sync_file
            .vaults
            .iter()
            .filter(|v| v.deleted_at.is_none())
            .count(),
        item_count,
        capture_count: sync_file.captures.len(),
        encrypted: loaded_sync.encrypted,
        needs_sync_passphrase: false,
        vaults_needing_password,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn temp_sync_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("brainbox-sync-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temp sync dir should be created");
        path
    }

    fn setup_conn(sync_dir: &Path) -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db should open");
        Vault::create_table(&conn).expect("vault table should be created");
        VaultItem::create_table(&conn).expect("item table should be created");
        SyncSettings::create_table(&conn).expect("sync settings should be created");
        SyncSettings::set(&conn, "sync_folder", sync_dir.to_str().expect("utf-8 path"))
            .expect("sync folder setting should be stored");
        conn
    }

    fn insert_password_vault(conn: &Connection, password: &str) -> (i64, String) {
        let now = chrono::Utc::now().to_rfc3339();
        let vault_uuid = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO vaults (name, encrypted_password, created_at, cover_image, has_password, uuid, updated_at) VALUES (?1, ?2, ?3, NULL, 1, ?4, ?5)",
            params!["Secure Vault", Vec::<u8>::new(), now, vault_uuid, chrono::Utc::now().to_rfc3339()],
        )
        .expect("vault should insert");

        let vault_id = conn.last_insert_rowid();
        let key = derive_key_from_password(password, &vault_id.to_string(), 100_000);
        let item = VaultItem::insert(conn, vault_id, "Secret title", "Secret body", &key)
            .expect("item should insert");
        VaultItem::update_summary(conn, item.id, "Secret summary").expect("summary should update");

        (vault_id, vault_uuid)
    }

    #[test]
    fn sync_export_requires_a_sync_file_passphrase() {
        let sync_dir = temp_sync_dir();
        let password = "CorrectHorseBatteryStaple";
        let export_conn = setup_conn(&sync_dir);
        let (vault_id, _) = insert_password_vault(&export_conn, password);

        let mut export_passwords = HashMap::new();
        export_passwords.insert(vault_id, password.to_string());
        let err = sync_export(&export_conn, export_passwords, None)
            .expect_err("sync export should require a sync passphrase");

        assert!(err.contains("Sync file passphrase"));
        let _ = fs::remove_dir_all(sync_dir);
    }

    #[test]
    fn sync_export_wraps_entire_sync_file_in_encrypted_envelope() {
        let sync_dir = temp_sync_dir();
        let password = "CorrectHorseBatteryStaple";
        let sync_passphrase = "Shared sync file passphrase";
        let export_conn = setup_conn(&sync_dir);
        SyncSettings::set(&export_conn, "device_name", "Private Laptop")
            .expect("device name should be stored");
        let (vault_id, vault_uuid) = insert_password_vault(&export_conn, password);

        let mut export_passwords = HashMap::new();
        export_passwords.insert(vault_id, password.to_string());
        let export_result = sync_export(&export_conn, export_passwords, Some(sync_passphrase))
            .expect("sync export should succeed");
        assert_eq!(export_result.exported_vaults, 1);
        assert_eq!(export_result.exported_items, 1);
        assert_eq!(export_result.exported_captures, 0);

        let sync_path = sync_dir.join(SYNC_FILE_NAME);
        let sync_json = fs::read_to_string(&sync_path).expect("sync file should exist");
        assert!(sync_json.contains("ciphertext"));
        assert!(!sync_json.contains("Private Laptop"));
        assert!(!sync_json.contains("Secure Vault"));
        assert!(!sync_json.contains("Secret title"));
        assert!(!sync_json.contains("Secret body"));
        assert!(!sync_json.contains("Secret summary"));

        let locked_preview = get_sync_preview(&export_conn, None)
            .expect("encrypted sync preview should parse")
            .expect("preview should exist");
        assert!(locked_preview.encrypted);
        assert!(locked_preview.needs_sync_passphrase);
        assert_eq!(locked_preview.vault_count, 0);

        let wrong_preview = get_sync_preview(&export_conn, Some("wrong passphrase"))
            .expect_err("wrong sync passphrase should fail");
        assert!(wrong_preview.contains("Failed to decrypt sync file"));

        let unlocked_preview = get_sync_preview(&export_conn, Some(sync_passphrase))
            .expect("encrypted sync preview should decrypt")
            .expect("preview should exist");
        assert!(unlocked_preview.encrypted);
        assert!(!unlocked_preview.needs_sync_passphrase);
        assert_eq!(unlocked_preview.device_name, "Private Laptop");
        assert_eq!(unlocked_preview.vault_count, 1);
        assert_eq!(unlocked_preview.item_count, 1);
        assert_eq!(unlocked_preview.vaults_needing_password.len(), 1);

        let import_conn = setup_conn(&sync_dir);
        let mut import_passwords = HashMap::new();
        import_passwords.insert(vault_uuid.clone(), password.to_string());

        let wrong_import = sync_import(
            &import_conn,
            import_passwords.clone(),
            Some("wrong passphrase"),
        )
        .expect_err("wrong sync passphrase should not import");
        assert!(wrong_import.contains("Failed to decrypt sync file"));

        let import_result = sync_import(&import_conn, import_passwords, Some(sync_passphrase))
            .expect("sync import should succeed");
        assert_eq!(import_result.imported_vaults, 1);
        assert_eq!(import_result.imported_items, 1);

        let imported_vault = Vault::get_by_uuid(&import_conn, &vault_uuid)
            .expect("vault lookup should run")
            .expect("vault should import");
        let imported_items =
            VaultItem::list_by_vault(&import_conn, imported_vault.id).expect("items should list");
        assert_eq!(imported_items.len(), 1);

        let imported_key =
            derive_key_from_password(password, &imported_vault.id.to_string(), 100_000);
        let imported_content = decrypt_content(&imported_key, &imported_items[0].content)
            .expect("imported content should decrypt");
        assert_eq!(imported_content, "Secret body");
        assert_eq!(imported_items[0].summary.as_deref(), Some("Secret summary"));

        let _ = fs::remove_dir_all(sync_dir);
    }

    #[test]
    fn sync_import_still_accepts_legacy_plaintext_sync_files() {
        let sync_dir = temp_sync_dir();
        let sync_file = SyncFile {
            format_version: SYNC_FORMAT_VERSION.to_string(),
            device_id: "legacy-device".to_string(),
            device_name: "Legacy Device".to_string(),
            exported_at: chrono::Utc::now().to_rfc3339(),
            vaults: vec![SyncVault {
                uuid: uuid::Uuid::new_v4().to_string(),
                name: "Legacy Vault".to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: chrono::Utc::now().to_rfc3339(),
                deleted_at: None,
                cover_image: None,
                has_password: false,
                items: vec![SyncItem {
                    uuid: uuid::Uuid::new_v4().to_string(),
                    title: "Legacy title".to_string(),
                    content: "Legacy body".to_string(),
                    content_encrypted: false,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    deleted_at: None,
                    image: None,
                    summary: Some("Legacy summary".to_string()),
                    summary_encrypted: false,
                    sort_order: None,
                }],
            }],
            captures: vec![],
        };

        fs::write(
            sync_dir.join(SYNC_FILE_NAME),
            serde_json::to_string_pretty(&sync_file).expect("legacy sync should serialize"),
        )
        .expect("legacy sync file should be written");

        let import_conn = setup_conn(&sync_dir);
        let import_result = sync_import(&import_conn, HashMap::new(), None)
            .expect("legacy sync import should still work without envelope passphrase");
        assert_eq!(import_result.imported_vaults, 1);
        assert_eq!(import_result.imported_items, 1);

        let imported_vault = Vault::get_by_uuid(&import_conn, &sync_file.vaults[0].uuid)
            .expect("vault lookup should run")
            .expect("legacy vault should import");
        let imported_items =
            VaultItem::list_by_vault(&import_conn, imported_vault.id).expect("items should list");
        let imported_key = derive_key_from_password("", &imported_vault.id.to_string(), 100_000);
        let imported_content = decrypt_content(&imported_key, &imported_items[0].content)
            .expect("legacy content should decrypt after import");
        assert_eq!(imported_content, "Legacy body");

        let _ = fs::remove_dir_all(sync_dir);
    }
}
