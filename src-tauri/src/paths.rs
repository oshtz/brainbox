use std::path::PathBuf;

const DATA_DIR_ENV: &str = "BRAINBOX_DATA_DIR";

pub fn brainbox_data_dir() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(DATA_DIR_ENV) {
        let data_dir = PathBuf::from(path);
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create app data dir override: {}", e))?;
        return Ok(data_dir);
    }

    dirs::data_local_dir().ok_or_else(|| "Failed to get app data dir".to_string())
}

pub fn brainbox_db_path() -> Result<PathBuf, String> {
    Ok(brainbox_data_dir()?.join("brainbox.sqlite"))
}
