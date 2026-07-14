const SERVICE: &str = "brainbox.ai";
const SYNC_SERVICE: &str = "brainbox.sync";
const SYNC_ACCOUNT: &str = "default";
const ALLOWED_PROVIDERS: &[&str] = &["openrouter", "openai", "anthropic", "google"];

static SESSION_SYNC_SECRET: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

fn session_sync_secret() -> &'static std::sync::Mutex<Option<String>> {
    SESSION_SYNC_SECRET.get_or_init(|| std::sync::Mutex::new(None))
}

fn validate_provider(provider: &str) -> Result<(), String> {
    if ALLOWED_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err("Unsupported AI provider".into())
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn entry(provider: &str) -> Result<keyring::Entry, String> {
    validate_provider(provider)?;
    keyring::Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn sync_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SYNC_SERVICE, SYNC_ACCOUNT).map_err(|e| e.to_string())
}

pub fn get_sync_secret() -> Result<Option<String>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        if let Ok(entry) = sync_entry() {
            match entry.get_password() {
                Ok(secret) => {
                    *session_sync_secret().lock().map_err(|e| e.to_string())? =
                        Some(secret.clone());
                    return Ok(Some(secret));
                }
                Err(keyring::Error::NoEntry) => {}
                Err(_) => {}
            }
        }
    }
    session_sync_secret()
        .lock()
        .map(|secret| secret.clone())
        .map_err(|e| e.to_string())
}

/// Returns true when the secret was persisted in the OS keyring.
pub fn set_sync_secret(secret: Option<String>) -> Result<bool, String> {
    let secret = secret.filter(|value| !value.trim().is_empty());
    *session_sync_secret().lock().map_err(|e| e.to_string())? = secret.clone();

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let Ok(entry) = sync_entry() else {
            return Ok(false);
        };
        return match secret {
            Some(value) => Ok(entry.set_password(&value).is_ok()),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(true),
                Err(_) => Ok(false),
            },
        };
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn get_ai_secret(provider: String) -> Result<Option<String>, String> {
    validate_provider(&provider)?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        match entry(&provider)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn set_ai_secret(provider: String, secret: Option<String>) -> Result<(), String> {
    validate_provider(&provider)?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let entry = entry(&provider)?;
        match secret.filter(|value| !value.trim().is_empty()) {
            Some(value) => entry.set_password(&value).map_err(|e| e.to_string()),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(error.to_string()),
            },
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = secret;
        Err("Secure AI credential storage is not available on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_cloud_providers_are_accepted() {
        assert!(validate_provider("openai").is_ok());
        assert!(validate_provider("../../other-credential").is_err());
        assert!(validate_provider("ollama").is_err());
    }
}
