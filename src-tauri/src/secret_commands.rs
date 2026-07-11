const SERVICE: &str = "brainbox.ai";
const ALLOWED_PROVIDERS: &[&str] = &["openrouter", "openai", "anthropic", "google"];

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
