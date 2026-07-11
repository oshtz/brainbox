use std::path::PathBuf;
use std::time::Duration;

use rusqlite::Connection;

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

pub fn open_brainbox_db() -> Result<Connection, String> {
    let conn = Connection::open(brainbox_db_path()?).map_err(|e| e.to_string())?;
    configure_connection(&conn)?;
    Ok(conn)
}

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_connection_enforces_foreign_keys_and_waits_for_locks() {
        let conn = Connection::open_in_memory().expect("in-memory db should open");
        configure_connection(&conn).expect("connection should configure");

        assert!(conn.is_autocommit());
        assert_eq!(
            conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .expect("foreign_keys should read"),
            1
        );
        assert_eq!(
            conn.pragma_query_value(None, "busy_timeout", |row| row.get::<_, i64>(0))
                .expect("busy_timeout should read"),
            5_000
        );
    }
}
