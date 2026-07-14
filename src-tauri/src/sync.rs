// sync.rs - Sync functionality for brainbox
// Handles export/import of vaults to sync folder for cross-device synchronization

use crate::vault::{SyncSettings, Vault, VaultItem};
use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
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

pub const SYNC_DEVICES_DIR: &str = "devices";
pub const SYNC_DEVICE_EXTENSION: &str = "brainbox-sync";

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncPeerInfo {
    pub device_id: String,
    pub device_name: String,
    pub exported_at: String,
    pub last_imported_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncFolderInspection {
    pub state: String,
    pub folder: String,
    pub devices: Vec<SyncPeerInfo>,
    pub vault_count: usize,
    pub item_count: usize,
    pub needs_sync_passphrase: bool,
    pub vaults_needing_password: Vec<VaultPasswordInfo>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderSyncStatus {
    pub state: String,
    pub folder: Option<String>,
    pub device_name: String,
    pub last_success_at: Option<String>,
    pub peers: Vec<SyncPeerInfo>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderSyncResult {
    pub state: String,
    pub imported_vaults: usize,
    pub imported_items: usize,
    pub exported_vaults: usize,
    pub exported_items: usize,
    pub conflicts: Vec<String>,
    pub data_changed: bool,
    pub skipped_peers: Vec<String>,
    pub warnings: Vec<String>,
    pub vaults_needing_password: Vec<VaultPasswordInfo>,
}

fn create_sync_peers_table(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_peers (
            device_id TEXT PRIMARY KEY,
            device_name TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,
            exported_at TEXT NOT NULL,
            last_imported_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn peer_snapshot_hash(conn: &Connection, device_id: &str) -> Result<Option<String>, String> {
    create_sync_peers_table(conn)?;
    let mut stmt = conn
        .prepare("SELECT snapshot_hash FROM sync_peers WHERE device_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([device_id]).map_err(|e| e.to_string())?;
    rows.next()
        .map_err(|e| e.to_string())?
        .map(|row| row.get(0).map_err(|e| e.to_string()))
        .transpose()
}

fn peer_exported_at(conn: &Connection, device_id: &str) -> Result<Option<String>, String> {
    create_sync_peers_table(conn)?;
    let mut stmt = conn
        .prepare("SELECT exported_at FROM sync_peers WHERE device_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([device_id]).map_err(|e| e.to_string())?;
    rows.next()
        .map_err(|e| e.to_string())?
        .map(|row| row.get(0).map_err(|e| e.to_string()))
        .transpose()
}

fn save_peer(conn: &Connection, sync_file: &SyncFile, snapshot_hash: &str) -> Result<(), String> {
    create_sync_peers_table(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO sync_peers
         (device_id, device_name, snapshot_hash, exported_at, last_imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            sync_file.device_id,
            sync_file.device_name,
            snapshot_hash,
            sync_file.exported_at,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_peers(conn: &Connection) -> Result<Vec<SyncPeerInfo>, String> {
    create_sync_peers_table(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT device_id, device_name, exported_at, last_imported_at
             FROM sync_peers ORDER BY device_name, device_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SyncPeerInfo {
                device_id: row.get(0)?,
                device_name: row.get(1)?,
                exported_at: row.get(2)?,
                last_imported_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
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

    let missing_passwords: Vec<&str> = vaults
        .iter()
        .filter(|vault| vault.has_password && !passwords.contains_key(&vault.id))
        .map(|vault| vault.name.as_str())
        .collect();
    if !missing_passwords.is_empty() {
        return Err(format!(
            "Passwords are required for all protected vaults before export: {}",
            missing_passwords.join(", ")
        ));
    }

    let mut sync_vaults = Vec::new();
    let skipped_vaults = Vec::new();
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
            let password = passwords
                .get(&vault.id)
                .expect("protected vault passwords were validated");
            let local_key = derive_key_from_password(password, &vault.id.to_string(), 100_000);
            let verified_password = decrypt_content(&local_key, &vault.encrypted_password)
                .map_err(|_| format!("Invalid password for vault '{}'", vault.name))?;
            if verified_password != *password {
                return Err(format!("Invalid password for vault '{}'", vault.name));
            }
            (local_key, portable_sync_key(&vault_uuid, password))
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
    let devices_dir = sync_folder.join(SYNC_DEVICES_DIR);
    fs::create_dir_all(&devices_dir)
        .map_err(|e| format!("Failed to create sync devices folder: {}", e))?;
    let sync_file_path =
        devices_dir.join(format!("{}.{}", sync_file.device_id, SYNC_DEVICE_EXTENSION));
    let envelope = encrypt_sync_envelope(&sync_file, sync_passphrase)?;
    let json = serde_json::to_string_pretty(&envelope)
        .map_err(|e| format!("Failed to serialize sync file: {}", e))?;
    write_sync_snapshot(&sync_file_path, json.as_bytes())?;

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

fn write_sync_snapshot(path: &Path, contents: &[u8]) -> Result<(), String> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid sync snapshot path")?;
    let temp_path = path.with_file_name(format!("{}.tmp", filename));
    let backup_path = path.with_file_name(format!("{}.bak", filename));
    let mut temp = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp_path)
        .map_err(|e| format!("Failed to create sync snapshot: {}", e))?;
    temp.write_all(contents)
        .and_then(|_| temp.sync_all())
        .map_err(|e| format!("Failed to persist sync snapshot: {}", e))?;
    drop(temp);

    if path.exists() {
        let _ = fs::remove_file(&backup_path);
        fs::rename(path, &backup_path)
            .map_err(|e| format!("Failed to preserve previous sync snapshot: {}", e))?;
    }

    if let Err(error) = fs::rename(&temp_path, path) {
        if backup_path.exists() {
            let _ = fs::rename(&backup_path, path);
        }
        return Err(format!("Failed to replace sync snapshot: {}", error));
    }

    if backup_path.exists() {
        fs::remove_file(&backup_path)
            .map_err(|e| format!("Failed to remove old sync snapshot: {}", e))?;
    }
    Ok(())
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
    if !hex.len().is_multiple_of(2) {
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
        return Ok(LoadedSyncFile { sync_file });
    }

    let sync_file: SyncFile =
        serde_json::from_str(contents).map_err(|e| format!("Failed to parse sync file: {}", e))?;
    Ok(LoadedSyncFile { sync_file })
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
#[cfg(test)]
fn sync_import(
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
    let sync_file_path = Path::new(&sync_folder_str).join(SYNC_FILE_NAME);
    sync_import_from_path(conn, &sync_file_path, &passwords, sync_passphrase, None)
}

fn sync_import_from_path(
    conn: &Connection,
    sync_file_path: &Path,
    passwords: &HashMap<String, String>,
    sync_passphrase: Option<&str>,
    conflict_baseline: Option<String>,
) -> Result<SyncImportResult, String> {
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;

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

    for sync_vault in &sync_file.vaults {
        let local_vault = Vault::get_by_uuid(conn, &sync_vault.uuid).map_err(|e| e.to_string())?;
        let password = passwords.get(&sync_vault.uuid);
        if sync_vault.has_password || local_vault.as_ref().is_some_and(|vault| vault.has_password) {
            let password = password.ok_or_else(|| {
                format!(
                    "Password is required for protected vault '{}' before import",
                    sync_vault.name
                )
            })?;
            if let Some(local_vault) = local_vault.filter(|vault| vault.has_password) {
                let local_key =
                    derive_key_from_password(password, &local_vault.id.to_string(), 100_000);
                let verified_password =
                    decrypt_content(&local_key, &local_vault.encrypted_password)
                        .map_err(|_| format!("Invalid password for vault '{}'", sync_vault.name))?;
                if verified_password != *password {
                    return Err(format!("Invalid password for vault '{}'", sync_vault.name));
                }
            }
        }
        for sync_item in &sync_vault.items {
            sync_item_plaintext(sync_vault, sync_item, password)?;
        }
    }

    let last_sync_at = match conflict_baseline {
        Some(value) => Some(value),
        None => SyncSettings::get(conn, "last_sync_at").map_err(|e| e.to_string())?,
    };

    let mut imported_vaults = 0;
    let mut imported_items = 0;
    let mut conflicts = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped_vaults = Vec::new();

    let database = conn;
    let tx = database
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let conn: &Connection = &tx;

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
                        &sync_file.device_name,
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

    let now = chrono::Utc::now().to_rfc3339();
    SyncSettings::set(conn, "last_sync_at", &now).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "last_sync_device", &sync_file.device_name)
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(SyncImportResult {
        imported_vaults,
        imported_items,
        imported_captures: 0,
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
    remote_device_name: &str,
) -> Result<ImportItemResult, String> {
    // Check if item exists locally by UUID
    let local_item = VaultItem::get_by_uuid(conn, &sync_item.uuid).map_err(|e| e.to_string())?;

    match local_item {
        Some(existing_item) => {
            let local_updated_at = existing_item.updated_at.clone();
            let remote_updated_at = &sync_item.updated_at;
            let is_conflict = last_sync_at.as_ref().is_some_and(|last| {
                local_updated_at > *last
                    && *remote_updated_at > *last
                    && local_updated_at != *remote_updated_at
            });

            // Handle soft delete sync
            if sync_item.deleted_at.is_some() && existing_item.deleted_at.is_none() {
                if is_conflict {
                    let recovery_title = format!(
                        "{} [Recovered after delete from {}]",
                        existing_item.title, remote_device_name
                    );
                    let recovery_uuid = uuid::Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO vault_items (vault_id, title, content, created_at, updated_at, image, summary, sort_order, uuid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        rusqlite::params![
                            vault_id,
                            &recovery_title,
                            &existing_item.content,
                            &existing_item.created_at,
                            &existing_item.updated_at,
                            &existing_item.image,
                            &existing_item.summary,
                            existing_item.sort_order,
                            recovery_uuid,
                        ],
                    ).map_err(|e| e.to_string())?;

                    if let Ok(content) = decrypt_content(key, &existing_item.content) {
                        let recovery_id = conn.last_insert_rowid();
                        let _ = crate::search::index_document(
                            recovery_id.to_string(),
                            recovery_title,
                            content.clone(),
                            if content.starts_with("http://") || content.starts_with("https://") {
                                "url".to_string()
                            } else {
                                "note".to_string()
                            },
                            existing_item.created_at.clone(),
                            existing_item.updated_at.clone(),
                            Some(format!("vault/{}/item/{}", vault_id, recovery_id)),
                            vec![],
                        );
                    }
                }

                conn.execute(
                    "UPDATE vault_items SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                    rusqlite::params![sync_item.deleted_at, sync_item.updated_at, existing_item.id],
                )
                .map_err(|e| e.to_string())?;
                remove_indexed_item(existing_item.id);
                return if is_conflict {
                    Ok(ImportItemResult::Conflict(existing_item.title))
                } else {
                    Ok(ImportItemResult::Deleted)
                };
            }

            // Skip if remote item is deleted (already handled above if local wasn't)
            if sync_item.deleted_at.is_some() {
                return Ok(ImportItemResult::Skipped);
            }

            if is_conflict {
                // Create conflict copy
                let conflict_title =
                    format!("{} [Conflict from {}]", sync_item.title, remote_device_name);
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
                    "UPDATE vault_items SET title = ?1, content = ?2, updated_at = ?3, image = ?4, summary = ?5, sort_order = ?6, deleted_at = NULL WHERE id = ?7",
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

/// Set device name
pub fn set_device_name(conn: &Connection, name: &str) -> Result<(), String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::set(conn, "device_name", name).map_err(|e| e.to_string())?;
    SyncSettings::delete(conn, "folder_sync_export_digest").map_err(|e| e.to_string())
}

fn snapshot_paths(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    let devices_dir = folder.join(SYNC_DEVICES_DIR);
    if devices_dir.exists() {
        for entry in fs::read_dir(&devices_dir)
            .map_err(|e| format!("Failed to read sync devices folder: {}", e))?
        {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some(SYNC_DEVICE_EXTENSION)
            {
                paths.push(path);
            }
        }
    }
    let legacy = folder.join(SYNC_FILE_NAME);
    if legacy.is_file() {
        paths.push(legacy);
    }
    paths.sort();
    Ok(paths)
}

fn snapshot_hash(contents: &[u8]) -> String {
    bytes_to_hex(&Sha256::digest(contents))
}

fn snapshot_device_id(path: &Path) -> Option<String> {
    (path.extension().and_then(|value| value.to_str()) == Some(SYNC_DEVICE_EXTENSION))
        .then(|| path.file_stem()?.to_str().map(str::to_string))
        .flatten()
}

fn own_snapshot_path(folder: &Path, device_id: &str) -> PathBuf {
    folder
        .join(SYNC_DEVICES_DIR)
        .join(format!("{}.{}", device_id, SYNC_DEVICE_EXTENSION))
}

fn local_sync_digest(conn: &Connection) -> Result<String, String> {
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(conn).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT kind, uuid, updated_at, deleted_at FROM (
                SELECT 'vault' AS kind, COALESCE(uuid, '') AS uuid, COALESCE(updated_at, '') AS updated_at, COALESCE(deleted_at, '') AS deleted_at FROM vaults
                UNION ALL
                SELECT 'item' AS kind, COALESCE(uuid, '') AS uuid, updated_at, COALESCE(deleted_at, '') AS deleted_at FROM vault_items
             ) ORDER BY kind, uuid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(format!(
                "{}\0{}\0{}\0{}\n",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    for row in rows {
        hasher.update(row.map_err(|e| e.to_string())?.as_bytes());
    }
    Ok(bytes_to_hex(&hasher.finalize()))
}

pub fn validate_sync_folder(path: &str) -> Result<String, String> {
    let folder = Path::new(path);
    if !folder.is_dir() {
        return Err("Choose an existing local folder.".to_string());
    }
    let canonical = folder
        .canonicalize()
        .map_err(|e| format!("Failed to resolve sync folder: {}", e))?;
    let probe = canonical.join(format!(".brainbox-write-test-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe)
            .map_err(|e| format!("Sync folder is not writable: {}", e))?;
        file.write_all(b"brainbox")
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Sync folder is not writable: {}", e))
    })();
    let cleanup = if probe.exists() {
        fs::remove_file(&probe).map_err(|e| format!("Failed to clean sync folder test: {}", e))
    } else {
        Ok(())
    };
    result?;
    cleanup?;
    canonical
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "Sync folder path is not valid UTF-8.".to_string())
}

pub fn inspect_folder_sync(
    conn: &Connection,
    path: &str,
    sync_passphrase: Option<&str>,
) -> Result<SyncFolderInspection, String> {
    let folder = Path::new(path);
    if !folder.is_dir() {
        return Ok(SyncFolderInspection {
            state: "invalid".to_string(),
            folder: path.to_string(),
            devices: Vec::new(),
            vault_count: 0,
            item_count: 0,
            needs_sync_passphrase: false,
            vaults_needing_password: Vec::new(),
            message: Some("Choose an existing local folder.".to_string()),
        });
    }
    let paths = snapshot_paths(folder)?;
    if paths.is_empty() {
        return Ok(SyncFolderInspection {
            state: "empty".to_string(),
            folder: path.to_string(),
            devices: Vec::new(),
            vault_count: 0,
            item_count: 0,
            needs_sync_passphrase: false,
            vaults_needing_password: Vec::new(),
            message: None,
        });
    }

    let imported_peers: HashMap<String, SyncPeerInfo> = list_peers(conn)?
        .into_iter()
        .map(|peer| (peer.device_id.clone(), peer))
        .collect();
    let mut devices = Vec::new();
    let mut protected = HashMap::<String, String>::new();
    let mut vault_uuids = HashSet::new();
    let mut item_uuids = HashSet::new();
    let mut needs_sync_passphrase = false;
    for snapshot in paths {
        let contents = fs::read_to_string(&snapshot)
            .map_err(|e| format!("Failed to read sync snapshot: {}", e))?;
        match read_sync_file(&contents, sync_passphrase) {
            Ok(loaded) => {
                let file = loaded.sync_file;
                if file.format_version != SYNC_FORMAT_VERSION {
                    return Err(format!(
                        "Unsupported sync file format version: {}",
                        file.format_version
                    ));
                }
                for vault in &file.vaults {
                    if vault.deleted_at.is_none() {
                        vault_uuids.insert(vault.uuid.clone());
                        item_uuids.extend(
                            vault
                                .items
                                .iter()
                                .filter(|item| item.deleted_at.is_none())
                                .map(|item| item.uuid.clone()),
                        );
                    }
                    if vault.has_password && vault.deleted_at.is_none() {
                        protected.insert(vault.uuid.clone(), vault.name.clone());
                    }
                }
                devices.push(SyncPeerInfo {
                    device_id: file.device_id.clone(),
                    device_name: file.device_name,
                    exported_at: file.exported_at,
                    last_imported_at: imported_peers
                        .get(&file.device_id)
                        .and_then(|peer| peer.last_imported_at.clone()),
                });
            }
            Err(error) if error.contains("passphrase is required") => {
                needs_sync_passphrase = true;
            }
            Err(error) => return Err(error),
        }
    }
    devices.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    let mut vaults_needing_password: Vec<VaultPasswordInfo> = protected
        .into_iter()
        .map(|(uuid, name)| VaultPasswordInfo { uuid, name })
        .collect();
    vaults_needing_password.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(SyncFolderInspection {
        state: "existing".to_string(),
        folder: path.to_string(),
        devices,
        vault_count: vault_uuids.len(),
        item_count: item_uuids.len(),
        needs_sync_passphrase,
        vaults_needing_password,
        message: None,
    })
}

pub fn folder_sync_status(
    conn: &Connection,
    sync_passphrase: Option<&str>,
) -> Result<FolderSyncStatus, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    let device_name = get_device_name(conn)?;
    let last_success_at =
        SyncSettings::get(conn, "folder_sync_last_success_at").map_err(|e| e.to_string())?;
    let Some(folder) = get_sync_folder(conn)? else {
        return Ok(FolderSyncStatus {
            state: "disabled".to_string(),
            folder: None,
            device_name,
            last_success_at,
            peers: Vec::new(),
            message: None,
        });
    };
    if !Path::new(&folder).is_dir() {
        return Ok(FolderSyncStatus {
            state: "folder_unavailable".to_string(),
            folder: Some(folder),
            device_name,
            last_success_at,
            peers: list_peers(conn)?,
            message: Some(
                "The sync folder is unavailable. Local data was not changed.".to_string(),
            ),
        });
    }
    if sync_passphrase.is_none() {
        return Ok(FolderSyncStatus {
            state: "passphrase_required".to_string(),
            folder: Some(folder),
            device_name,
            last_success_at,
            peers: list_peers(conn)?,
            message: Some("Enter the sync passphrase to resume.".to_string()),
        });
    }

    let device_id = get_or_create_device_id(conn)?;
    let digest = local_sync_digest(conn)?;
    let exported_digest =
        SyncSettings::get(conn, "folder_sync_export_digest").map_err(|e| e.to_string())?;
    let mut has_changes = exported_digest.as_deref() != Some(&digest)
        || !own_snapshot_path(Path::new(&folder), &device_id).exists();
    for path in snapshot_paths(Path::new(&folder))? {
        let contents = fs::read(&path).map_err(|e| e.to_string())?;
        if let Some(peer_id) = snapshot_device_id(&path) {
            if peer_id != device_id
                && peer_snapshot_hash(conn, &peer_id)?.as_deref() != Some(&snapshot_hash(&contents))
            {
                has_changes = true;
            }
            continue;
        }
        let text = String::from_utf8(contents.clone())
            .map_err(|_| "Sync snapshot is not valid UTF-8.".to_string())?;
        match read_sync_file(&text, sync_passphrase) {
            Ok(loaded)
                if loaded.sync_file.device_id != device_id
                    && peer_snapshot_hash(conn, &loaded.sync_file.device_id)?.as_deref()
                        != Some(&snapshot_hash(&contents)) =>
            {
                has_changes = true;
            }
            Ok(_) => {}
            Err(_) => has_changes = true,
        }
    }
    Ok(FolderSyncStatus {
        state: if has_changes {
            "changes_waiting".to_string()
        } else {
            "up_to_date".to_string()
        },
        folder: Some(folder),
        device_name,
        last_success_at,
        peers: list_peers(conn)?,
        message: None,
    })
}

pub fn run_folder_sync(
    conn: &Connection,
    passwords: HashMap<String, String>,
    sync_passphrase: &str,
) -> Result<FolderSyncResult, String> {
    normalize_sync_passphrase(Some(sync_passphrase))?;
    Vault::create_table(conn).map_err(|e| e.to_string())?;
    VaultItem::create_table(conn).map_err(|e| e.to_string())?;
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    create_sync_peers_table(conn)?;

    let folder_string = get_sync_folder(conn)?
        .ok_or("Sync folder not configured. Please choose a sync folder in settings.")?;
    let folder = Path::new(&folder_string);
    if !folder.is_dir() {
        return Err("The sync folder is unavailable. Local data was not changed.".to_string());
    }
    let device_id = get_or_create_device_id(conn)?;
    let local_vaults = Vault::list_all_for_sync(conn).map_err(|e| e.to_string())?;
    let mut missing = HashMap::<String, String>::new();
    let mut export_passwords = HashMap::new();
    for vault in &local_vaults {
        if !vault.has_password {
            continue;
        }
        let uuid = vault.uuid.clone().unwrap_or_default();
        match passwords.get(&uuid) {
            Some(password) => {
                let key = derive_key_from_password(password, &vault.id.to_string(), 100_000);
                let verified = decrypt_content(&key, &vault.encrypted_password)
                    .map_err(|_| format!("Invalid password for vault '{}'.", vault.name))?;
                if verified != *password {
                    return Err(format!("Invalid password for vault '{}'.", vault.name));
                }
                export_passwords.insert(vault.id, password.clone());
            }
            None => {
                missing.insert(uuid, vault.name.clone());
            }
        }
    }

    struct PreparedSnapshot {
        path: PathBuf,
        hash: String,
        file: SyncFile,
    }
    let mut prepared = Vec::new();
    let mut skipped_peers = Vec::new();
    let mut warnings = Vec::new();
    for path in snapshot_paths(folder)? {
        if snapshot_device_id(&path).as_deref() == Some(&device_id) {
            continue;
        }
        let contents = match fs::read(&path) {
            Ok(contents) => contents,
            Err(error) => {
                warnings.push(format!("Skipped '{}': {}", path.display(), error));
                skipped_peers.push(path.display().to_string());
                continue;
            }
        };
        let hash = snapshot_hash(&contents);
        if let Some(peer_id) = snapshot_device_id(&path) {
            if peer_snapshot_hash(conn, &peer_id)?.as_deref() == Some(&hash) {
                continue;
            }
        }
        let text = match String::from_utf8(contents.clone()) {
            Ok(text) => text,
            Err(_) => {
                warnings.push(format!("Skipped '{}': invalid UTF-8", path.display()));
                skipped_peers.push(path.display().to_string());
                continue;
            }
        };
        let loaded = match read_sync_file(&text, Some(sync_passphrase)) {
            Ok(loaded) => loaded,
            Err(error) if error.contains("Failed to decrypt sync file") => return Err(error),
            Err(error) => {
                warnings.push(format!("Skipped '{}': {}", path.display(), error));
                skipped_peers.push(path.display().to_string());
                continue;
            }
        };
        let file = loaded.sync_file;
        if file.format_version != SYNC_FORMAT_VERSION {
            warnings.push(format!(
                "Skipped '{}': unsupported format {}",
                file.device_name, file.format_version
            ));
            skipped_peers.push(file.device_name);
            continue;
        }
        if file.device_id == device_id {
            continue;
        }
        if peer_snapshot_hash(conn, &file.device_id)?.as_deref() == Some(&hash) {
            continue;
        }
        for vault in &file.vaults {
            let local = Vault::get_by_uuid(conn, &vault.uuid).map_err(|e| e.to_string())?;
            if (vault.has_password || local.as_ref().is_some_and(|value| value.has_password))
                && !passwords.contains_key(&vault.uuid)
            {
                missing.insert(vault.uuid.clone(), vault.name.clone());
                continue;
            }
            let password = passwords.get(&vault.uuid);
            for item in &vault.items {
                sync_item_plaintext(vault, item, password)?;
            }
        }
        prepared.push(PreparedSnapshot { path, hash, file });
    }

    if !missing.is_empty() {
        let mut vaults_needing_password: Vec<VaultPasswordInfo> = missing
            .into_iter()
            .map(|(uuid, name)| VaultPasswordInfo { uuid, name })
            .collect();
        vaults_needing_password.sort_by(|a, b| a.name.cmp(&b.name));
        return Ok(FolderSyncResult {
            state: "unlock_required".to_string(),
            imported_vaults: 0,
            imported_items: 0,
            exported_vaults: 0,
            exported_items: 0,
            conflicts: Vec::new(),
            data_changed: false,
            skipped_peers,
            warnings,
            vaults_needing_password,
        });
    }

    prepared.sort_by(|a, b| a.file.device_id.cmp(&b.file.device_id));
    let mut imported_vaults = 0;
    let mut imported_items = 0;
    let mut conflicts = Vec::new();
    for snapshot in prepared {
        let baseline = peer_exported_at(conn, &snapshot.file.device_id)?;
        let result = sync_import_from_path(
            conn,
            &snapshot.path,
            &passwords,
            Some(sync_passphrase),
            baseline,
        )?;
        imported_vaults += result.imported_vaults;
        imported_items += result.imported_items;
        conflicts.extend(result.conflicts);
        warnings.extend(result.warnings);
        save_peer(conn, &snapshot.file, &snapshot.hash)?;
    }

    let digest = local_sync_digest(conn)?;
    let exported_digest =
        SyncSettings::get(conn, "folder_sync_export_digest").map_err(|e| e.to_string())?;
    let own_path = own_snapshot_path(folder, &device_id);
    let (exported_vaults, exported_items) = if exported_digest.as_deref() != Some(&digest)
        || !own_path.exists()
    {
        let result = sync_export(conn, export_passwords, Some(sync_passphrase))?;
        SyncSettings::set(conn, "folder_sync_export_digest", &digest).map_err(|e| e.to_string())?;
        (result.exported_vaults, result.exported_items)
    } else {
        (0, 0)
    };
    SyncSettings::set(
        conn,
        "folder_sync_last_success_at",
        &chrono::Utc::now().to_rfc3339(),
    )
    .map_err(|e| e.to_string())?;

    Ok(FolderSyncResult {
        state: "up_to_date".to_string(),
        imported_vaults,
        imported_items,
        exported_vaults,
        exported_items,
        conflicts,
        data_changed: imported_vaults > 0 || imported_items > 0,
        skipped_peers,
        warnings,
        vaults_needing_password: Vec::new(),
    })
}

pub fn disconnect_folder_sync(conn: &Connection) -> Result<Option<String>, String> {
    SyncSettings::create_table(conn).map_err(|e| e.to_string())?;
    create_sync_peers_table(conn)?;
    let mut warning = None;
    if let (Some(folder), Some(device_id)) = (
        get_sync_folder(conn)?,
        SyncSettings::get(conn, "device_id").map_err(|e| e.to_string())?,
    ) {
        let snapshot = own_snapshot_path(Path::new(&folder), &device_id);
        if snapshot.exists() {
            if let Err(error) = fs::remove_file(&snapshot) {
                warning = Some(format!(
                    "Disconnected locally, but '{}' could not be removed: {}",
                    snapshot.display(),
                    error
                ));
            }
        }
    }
    for key in [
        "sync_folder",
        "folder_sync_export_digest",
        "folder_sync_last_success_at",
        "last_sync_at",
        "last_sync_device",
    ] {
        SyncSettings::delete(conn, key).map_err(|e| e.to_string())?;
    }
    conn.execute("DELETE FROM sync_peers", [])
        .map_err(|e| e.to_string())?;
    Ok(warning)
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

    fn device_snapshot(conn: &Connection, sync_dir: &Path) -> PathBuf {
        own_snapshot_path(
            sync_dir,
            &get_or_create_device_id(conn).expect("device id should exist"),
        )
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
        let encrypted_password =
            encrypt_password(&key, password).expect("password verifier should encrypt");
        conn.execute(
            "UPDATE vaults SET encrypted_password = ?1 WHERE id = ?2",
            params![encrypted_password, vault_id],
        )
        .expect("password verifier should store");
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

        let sync_path = device_snapshot(&export_conn, &sync_dir);
        let sync_json = fs::read_to_string(&sync_path).expect("sync file should exist");
        assert!(sync_json.contains("ciphertext"));
        assert!(!sync_json.contains("Private Laptop"));
        assert!(!sync_json.contains("Secure Vault"));
        assert!(!sync_json.contains("Secret title"));
        assert!(!sync_json.contains("Secret body"));
        assert!(!sync_json.contains("Secret summary"));

        let locked_preview =
            inspect_folder_sync(&export_conn, sync_dir.to_str().expect("utf-8 path"), None)
                .expect("encrypted sync preview should parse");
        assert!(locked_preview.needs_sync_passphrase);
        assert_eq!(locked_preview.vault_count, 0);

        let wrong_preview = inspect_folder_sync(
            &export_conn,
            sync_dir.to_str().expect("utf-8 path"),
            Some("wrong passphrase"),
        )
        .expect_err("wrong sync passphrase should fail");
        assert!(wrong_preview.contains("Failed to decrypt sync file"));

        let unlocked_preview = inspect_folder_sync(
            &export_conn,
            sync_dir.to_str().expect("utf-8 path"),
            Some(sync_passphrase),
        )
        .expect("encrypted sync preview should decrypt");
        assert!(!unlocked_preview.needs_sync_passphrase);
        assert_eq!(unlocked_preview.devices[0].device_name, "Private Laptop");
        assert_eq!(unlocked_preview.vault_count, 1);
        assert_eq!(unlocked_preview.item_count, 1);
        assert_eq!(unlocked_preview.vaults_needing_password.len(), 1);

        let import_conn = setup_conn(&sync_dir);
        let mut import_passwords = HashMap::new();
        import_passwords.insert(vault_uuid.clone(), password.to_string());

        let wrong_import = sync_import_from_path(
            &import_conn,
            &sync_path,
            &import_passwords,
            Some("wrong passphrase"),
            None,
        )
        .expect_err("wrong sync passphrase should not import");
        assert!(wrong_import.contains("Failed to decrypt sync file"));

        let import_result = sync_import_from_path(
            &import_conn,
            &sync_path,
            &import_passwords,
            Some(sync_passphrase),
            None,
        )
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

    #[test]
    fn sync_export_requires_every_protected_vault_before_replacing_snapshot() {
        let sync_dir = temp_sync_dir();
        let conn = setup_conn(&sync_dir);
        let sync_path = device_snapshot(&conn, &sync_dir);
        fs::create_dir_all(sync_path.parent().expect("snapshot parent"))
            .expect("device folder should exist");
        fs::write(&sync_path, "previous snapshot").expect("previous snapshot should write");
        insert_password_vault(&conn, "vault password");

        let error = sync_export(&conn, HashMap::new(), Some("sync passphrase"))
            .expect_err("missing vault password should stop export");

        assert!(error.contains("Passwords are required for all protected vaults"));
        assert_eq!(
            fs::read_to_string(&sync_path).expect("previous snapshot should remain"),
            "previous snapshot"
        );
        assert!(!sync_path
            .with_file_name(format!(
                "{}.tmp",
                sync_path.file_name().unwrap().to_string_lossy()
            ))
            .exists());
        assert!(!sync_path
            .with_file_name(format!(
                "{}.bak",
                sync_path.file_name().unwrap().to_string_lossy()
            ))
            .exists());
        let _ = fs::remove_dir_all(sync_dir);
    }

    #[test]
    fn sync_export_replaces_existing_snapshot_without_leaving_work_files() {
        let sync_dir = temp_sync_dir();
        let conn = setup_conn(&sync_dir);
        let (vault_id, _) = insert_password_vault(&conn, "vault password");
        let passwords = HashMap::from([(vault_id, "vault password".to_string())]);

        sync_export(&conn, passwords.clone(), Some("sync passphrase"))
            .expect("first export should succeed");
        let sync_path = device_snapshot(&conn, &sync_dir);
        let first = fs::read(&sync_path).expect("first snapshot should read");
        SyncSettings::set(&conn, "device_name", "Changed Device")
            .expect("device name should update");
        sync_export(&conn, passwords, Some("sync passphrase"))
            .expect("replacement export should succeed");
        let second = fs::read(&sync_path).expect("second snapshot should read");

        assert_ne!(first, second);
        assert!(!sync_path
            .with_file_name(format!(
                "{}.tmp",
                sync_path.file_name().unwrap().to_string_lossy()
            ))
            .exists());
        assert!(!sync_path
            .with_file_name(format!(
                "{}.bak",
                sync_path.file_name().unwrap().to_string_lossy()
            ))
            .exists());
        let _ = fs::remove_dir_all(sync_dir);
    }

    #[test]
    fn folder_sync_converges_three_devices_without_shared_file_writes() {
        let sync_dir = temp_sync_dir();
        let first = setup_conn(&sync_dir);
        let second = setup_conn(&sync_dir);
        let third = setup_conn(&sync_dir);
        SyncSettings::set(&first, "device_id", "device-a").unwrap();
        SyncSettings::set(&first, "device_name", "Laptop").unwrap();
        SyncSettings::set(&second, "device_id", "device-b").unwrap();
        SyncSettings::set(&second, "device_name", "Desktop").unwrap();
        SyncSettings::set(&third, "device_id", "device-c").unwrap();
        SyncSettings::set(&third, "device_name", "Travel laptop").unwrap();

        let now = chrono::Utc::now().to_rfc3339();
        let vault_uuid = uuid::Uuid::new_v4().to_string();
        first.execute(
            "INSERT INTO vaults (name, encrypted_password, created_at, has_password, uuid, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?3)",
            params!["Inbox", Vec::<u8>::new(), now, vault_uuid],
        ).unwrap();
        let first_vault_id = first.last_insert_rowid();
        let key = derive_key_from_password("", &first_vault_id.to_string(), 100_000);
        VaultItem::insert(&first, first_vault_id, "From laptop", "Hello", &key).unwrap();

        run_folder_sync(&first, HashMap::new(), "shared passphrase").unwrap();
        let imported = run_folder_sync(&second, HashMap::new(), "shared passphrase").unwrap();
        assert!(imported.data_changed);
        run_folder_sync(&first, HashMap::new(), "shared passphrase").unwrap();

        let second_vault = Vault::get_by_uuid(&second, &vault_uuid).unwrap().unwrap();
        let second_items = VaultItem::list_by_vault(&second, second_vault.id).unwrap();
        VaultItem::update_title(&second, second_items[0].id, "Edited on desktop").unwrap();
        let edited = run_folder_sync(&second, HashMap::new(), "shared passphrase").unwrap();
        assert!(!edited.data_changed);
        let merged = run_folder_sync(&first, HashMap::new(), "shared passphrase").unwrap();
        assert!(merged.data_changed);
        let repeated = run_folder_sync(&first, HashMap::new(), "shared passphrase").unwrap();
        assert!(!repeated.data_changed);
        run_folder_sync(&third, HashMap::new(), "shared passphrase").unwrap();

        let snapshots = fs::read_dir(sync_dir.join(SYNC_DEVICES_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str())
                    == Some(SYNC_DEVICE_EXTENSION)
            })
            .count();
        assert_eq!(snapshots, 3);
        let first_vault = Vault::get_by_uuid(&first, &vault_uuid).unwrap().unwrap();
        let first_items = VaultItem::list_by_vault(&first, first_vault.id).unwrap();
        let third_vault = Vault::get_by_uuid(&third, &vault_uuid).unwrap().unwrap();
        let third_items = VaultItem::list_by_vault(&third, third_vault.id).unwrap();
        assert_eq!(first_items[0].title, "Edited on desktop");
        assert_eq!(third_items[0].title, "Edited on desktop");

        let _ = fs::remove_dir_all(sync_dir);
    }

    #[test]
    fn concurrent_remote_delete_preserves_local_edit_as_recovery_copy() {
        let sync_dir = temp_sync_dir();
        let conn = setup_conn(&sync_dir);
        conn.execute(
            "INSERT INTO vaults (name, encrypted_password, created_at, has_password, uuid, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?3)",
            params!["Inbox", Vec::<u8>::new(), "2026-07-15T08:00:00Z", uuid::Uuid::new_v4().to_string()],
        ).unwrap();
        let vault_id = conn.last_insert_rowid();
        let key = derive_key_from_password("", &vault_id.to_string(), 100_000);
        let item = VaultItem::insert(&conn, vault_id, "Local edit", "Keep me", &key).unwrap();
        conn.execute(
            "UPDATE vault_items SET updated_at = ?1 WHERE id = ?2",
            params!["2026-07-15T10:00:00Z", item.id],
        )
        .unwrap();
        let remote_delete = SyncItem {
            uuid: item.uuid.clone().unwrap(),
            title: item.title,
            content: String::new(),
            content_encrypted: false,
            created_at: item.created_at,
            updated_at: "2026-07-15T11:00:00Z".to_string(),
            deleted_at: Some("2026-07-15T11:00:00Z".to_string()),
            image: None,
            summary: None,
            summary_encrypted: false,
            sort_order: None,
        };

        let result = import_item(
            &conn,
            vault_id,
            &remote_delete,
            &key,
            &Some("2026-07-15T09:00:00Z".to_string()),
            "Desktop",
        )
        .unwrap();
        assert!(matches!(result, ImportItemResult::Conflict(_)));
        let visible = VaultItem::list_by_vault(&conn, vault_id).unwrap();
        assert_eq!(visible.len(), 1);
        assert!(visible[0]
            .title
            .contains("Recovered after delete from Desktop"));
        let content = decrypt_content(&key, &visible[0].content).unwrap();
        assert_eq!(content, "Keep me");

        let _ = fs::remove_dir_all(sync_dir);
    }

    #[test]
    fn sync_import_rolls_back_all_database_changes_on_constraint_failure() {
        let sync_dir = temp_sync_dir();
        let now = chrono::Utc::now().to_rfc3339();
        let duplicate_item_uuid = uuid::Uuid::new_v4().to_string();
        let item = SyncItem {
            uuid: duplicate_item_uuid,
            title: "Item".to_string(),
            content: "Body".to_string(),
            content_encrypted: false,
            created_at: now.clone(),
            updated_at: now.clone(),
            deleted_at: None,
            image: None,
            summary: None,
            summary_encrypted: false,
            sort_order: None,
        };
        let vault = |name: &str| SyncVault {
            uuid: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            deleted_at: None,
            cover_image: None,
            has_password: false,
            items: vec![item.clone()],
        };
        let sync_file = SyncFile {
            format_version: SYNC_FORMAT_VERSION.to_string(),
            device_id: "remote".to_string(),
            device_name: "Remote".to_string(),
            exported_at: now.clone(),
            vaults: vec![vault("First"), vault("Second")],
            captures: vec![],
        };
        fs::write(
            sync_dir.join(SYNC_FILE_NAME),
            serde_json::to_string(&sync_file).expect("sync file should serialize"),
        )
        .expect("sync file should write");
        let conn = setup_conn(&sync_dir);

        sync_import(&conn, HashMap::new(), None)
            .expect_err("duplicate item UUID should fail import");

        assert!(Vault::list(&conn).expect("vaults should list").is_empty());
        assert!(
            conn.is_autocommit(),
            "failed import must close its transaction"
        );
        let _ = fs::remove_dir_all(sync_dir);
    }
}
