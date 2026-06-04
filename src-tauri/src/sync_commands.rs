use std::collections::HashMap;

use crate::paths::brainbox_db_path;
use crate::sync;

#[tauri::command]
pub fn sync_export_vaults(
    passwords: HashMap<i64, String>,
    sync_passphrase: Option<String>,
) -> Result<sync::SyncExportResult, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::sync_export(&conn, passwords, sync_passphrase.as_deref())
}

#[tauri::command]
pub fn get_sync_status() -> Result<sync::SyncStatus, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::check_sync_status(&conn)
}

#[tauri::command]
pub fn get_locked_vaults_for_sync() -> Result<Vec<(i64, String)>, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::get_locked_vaults(&conn)
}

#[tauri::command]
pub fn get_sync_settings() -> Result<HashMap<String, String>, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::get_sync_settings(&conn)
}

#[tauri::command]
pub fn set_sync_setting(key: String, value: String) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::set_sync_setting(&conn, &key, &value)
}

#[tauri::command]
pub fn set_sync_folder(path: String) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;

    if !std::path::Path::new(&path).exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    sync::set_sync_folder(&conn, &path)
}

#[tauri::command]
pub fn sync_import_vaults(
    passwords: HashMap<String, String>,
    sync_passphrase: Option<String>,
) -> Result<sync::SyncImportResult, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::sync_import(&conn, passwords, sync_passphrase.as_deref())
}

#[tauri::command]
pub fn get_sync_preview(
    sync_passphrase: Option<String>,
) -> Result<Option<sync::SyncPreview>, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::get_sync_preview(&conn, sync_passphrase.as_deref())
}

#[tauri::command]
pub fn purge_deleted_items(days: Option<i32>) -> Result<sync::PurgeResult, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;

    let purge_days = match days {
        Some(d) => d,
        None => sync::get_purge_days(&conn)?,
    };

    sync::purge_deleted_items(&conn, purge_days)
}

#[tauri::command]
pub fn auto_purge_if_enabled() -> Result<Option<sync::PurgeResult>, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;

    if sync::should_auto_purge(&conn)? {
        let days = sync::get_purge_days(&conn)?;
        Ok(Some(sync::purge_deleted_items(&conn, days)?))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn is_sync_on_close_enabled() -> Result<bool, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::is_sync_on_close_enabled(&conn)
}

#[tauri::command]
pub fn set_sync_on_close(enabled: bool) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::set_sync_on_close(&conn, enabled)
}

#[tauri::command]
pub fn is_check_sync_on_startup_enabled() -> Result<bool, String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::is_check_sync_on_startup_enabled(&conn)
}

#[tauri::command]
pub fn set_check_sync_on_startup(enabled: bool) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::set_check_sync_on_startup(&conn, enabled)
}

#[tauri::command]
pub fn set_device_name(name: String) -> Result<(), String> {
    let db_path = brainbox_db_path()?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    sync::set_device_name(&conn, &name)
}
