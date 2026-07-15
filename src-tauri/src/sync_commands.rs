use std::collections::HashMap;
use std::sync::Mutex;

use crate::paths::open_brainbox_db;
use crate::{secret_commands, sync};

lazy_static::lazy_static! {
    // ponytail: one app-wide lock is enough for personal sync; split per folder only if parallel profiles arrive.
    static ref FOLDER_SYNC_LOCK: Mutex<()> = Mutex::new(());
}

#[tauri::command]
pub fn inspect_folder_sync(
    path: String,
    sync_passphrase: Option<String>,
) -> Result<sync::SyncFolderInspection, String> {
    let conn = open_brainbox_db()?;
    sync::inspect_folder_sync(&conn, &path, sync_passphrase.as_deref())
}

#[tauri::command]
pub fn configure_folder_sync(
    path: String,
    device_name: String,
    sync_passphrase: String,
) -> Result<sync::FolderSyncStatus, String> {
    let _guard = FOLDER_SYNC_LOCK.lock().map_err(|e| e.to_string())?;
    if sync_passphrase.trim().is_empty() {
        return Err("A sync passphrase is required.".to_string());
    }
    let path = sync::validate_sync_folder(&path)?;
    let conn = open_brainbox_db()?;
    let inspection = sync::inspect_folder_sync(&conn, &path, Some(&sync_passphrase))?;
    if inspection.state == "invalid" {
        return Err(inspection
            .message
            .unwrap_or_else(|| "The sync folder is invalid.".to_string()));
    }
    sync::set_sync_folder(&conn, &path)?;
    sync::set_device_name(
        &conn,
        if device_name.trim().is_empty() {
            "Unknown device"
        } else {
            device_name.trim()
        },
    )?;
    let persisted = secret_commands::set_sync_secret(Some(sync_passphrase))?;
    let mut status =
        sync::folder_sync_status(&conn, secret_commands::get_sync_secret()?.as_deref())?;
    if !persisted {
        status.message = Some(
            "The OS keyring was unavailable; the passphrase will be remembered until Brainbox quits."
                .to_string(),
        );
    }
    Ok(status)
}

#[tauri::command]
pub fn run_folder_sync(
    passwords_by_vault_uuid: HashMap<String, String>,
) -> Result<sync::FolderSyncResult, String> {
    let _guard = FOLDER_SYNC_LOCK.lock().map_err(|e| e.to_string())?;
    let passphrase =
        secret_commands::get_sync_secret()?.ok_or("Enter the sync passphrase to resume.")?;
    let conn = open_brainbox_db()?;
    sync::run_folder_sync(&conn, passwords_by_vault_uuid, &passphrase)
}

#[tauri::command]
pub fn get_folder_sync_status() -> Result<sync::FolderSyncStatus, String> {
    let conn = open_brainbox_db()?;
    let passphrase = secret_commands::get_sync_secret()?;
    sync::folder_sync_status(&conn, passphrase.as_deref())
}

#[tauri::command]
pub fn unlock_folder_sync(sync_passphrase: String) -> Result<sync::FolderSyncStatus, String> {
    let _guard = FOLDER_SYNC_LOCK.lock().map_err(|e| e.to_string())?;
    if sync_passphrase.trim().is_empty() {
        return Err("A sync passphrase is required.".to_string());
    }
    let conn = open_brainbox_db()?;
    let folder = sync::get_sync_folder(&conn)?.ok_or("Sync folder is not configured.")?;
    sync::inspect_folder_sync(&conn, &folder, Some(&sync_passphrase))?;
    secret_commands::set_sync_secret(Some(sync_passphrase))?;
    let passphrase = secret_commands::get_sync_secret()?;
    sync::folder_sync_status(&conn, passphrase.as_deref())
}

#[tauri::command]
pub fn set_folder_sync_device_name(name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Device name cannot be empty.".to_string());
    }
    let conn = open_brainbox_db()?;
    sync::set_device_name(&conn, name.trim())
}

#[tauri::command]
pub fn disconnect_folder_sync() -> Result<Option<String>, String> {
    let _guard = FOLDER_SYNC_LOCK.lock().map_err(|e| e.to_string())?;
    let conn = open_brainbox_db()?;
    let warning = sync::disconnect_folder_sync(&conn)?;
    let _ = secret_commands::set_sync_secret(None);
    Ok(warning)
}
