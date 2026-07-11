const GITHUB_REPO: &str = "oshtz/brainbox";

#[derive(serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    version: String,
}

fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let mut parts = version.trim().trim_start_matches(['v', 'V']).split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

fn is_newer_version(current: &str, candidate: &str) -> bool {
    matches!(
        (parse_version(current), parse_version(candidate)),
        (Some(current), Some(candidate)) if candidate > current
    )
}

#[tauri::command]
pub fn get_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Check the latest published GitHub release. Installation stays manual until
/// signed Tauri updater artifacts and a public verification key are configured.
#[tauri::command]
pub async fn check_for_updates() -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent("brainbox-update-check")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!(
            "https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
        ))
        .send()
        .await
        .map_err(|e| format!("Failed to check for updates: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {e}"))?;
    let version = release.tag_name.trim_start_matches(['v', 'V']).to_string();

    Ok(is_newer_version(env!("CARGO_PKG_VERSION"), &version).then_some(UpdateInfo { version }))
}

#[cfg(test)]
mod tests {
    use super::{is_newer_version, parse_version};

    #[test]
    fn versions_are_strict_semver_triplets() {
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert!(!is_newer_version("1.2.3", "1.2.3"));
        assert!(is_newer_version("1.2.3", "1.3.0"));
    }
}
