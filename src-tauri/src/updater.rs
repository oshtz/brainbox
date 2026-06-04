use std::path::Path;
use std::process::Command;

use tauri::Emitter;

const GITHUB_REPO: &str = "oshtz/brainbox";

#[derive(serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(serde::Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct UpdateInfo {
    version: String,
    download_url: String,
    asset_name: String,
}

/// Parse version string (strips 'v' prefix) and returns (major, minor, patch)
fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let v = version.trim().trim_start_matches(|c| c == 'v' || c == 'V');
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() >= 3 {
        let major = parts[0].parse().ok()?;
        let minor = parts[1].parse().ok()?;
        let patch = parts[2].parse().ok()?;
        Some((major, minor, patch))
    } else {
        None
    }
}

/// Compare two versions, returns true if new_version > current_version
fn is_newer_version(current: &str, new_version: &str) -> bool {
    match (parse_version(current), parse_version(new_version)) {
        (Some((c_maj, c_min, c_pat)), Some((n_maj, n_min, n_pat))) => {
            (n_maj, n_min, n_pat) > (c_maj, c_min, c_pat)
        }
        _ => false,
    }
}

/// Get the appropriate asset name for the current platform
#[cfg(target_os = "macos")]
fn get_platform_asset_pattern() -> &'static str {
    ".app.tar.gz"
}

#[cfg(target_os = "windows")]
fn is_portable_install() -> Result<bool, String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_name = exe_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid executable name")?;
    Ok(exe_name.to_ascii_lowercase().contains("portable"))
}

#[cfg(target_os = "windows")]
fn matches_windows_asset(name: &str, portable: bool) -> bool {
    let lower = name.to_ascii_lowercase();
    if portable {
        lower.contains("portable") && lower.ends_with(".exe")
    } else {
        lower.ends_with("x64-setup.exe")
    }
}

#[tauri::command]
pub fn get_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn check_for_updates() -> Result<Option<UpdateInfo>, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        GITHUB_REPO
    );

    let client = reqwest::Client::builder()
        .user_agent("brainbox-updater")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;

    let new_version = release.tag_name.trim_start_matches('v');

    if !is_newer_version(current_version, new_version) {
        return Ok(None);
    }

    // Find the appropriate asset for this platform
    #[cfg(target_os = "windows")]
    let asset = {
        let is_portable = is_portable_install()?;
        release
            .assets
            .iter()
            .find(|a| matches_windows_asset(&a.name, is_portable))
            .ok_or_else(|| {
                if is_portable {
                    "No suitable portable update asset found for this release".to_string()
                } else {
                    "No suitable installer update asset found for this release".to_string()
                }
            })?
    };

    #[cfg(target_os = "macos")]
    let asset = {
        let pattern = get_platform_asset_pattern();
        if pattern.is_empty() {
            return Err("Auto-update not supported on this platform".to_string());
        }
        release
            .assets
            .iter()
            .find(|a| a.name.ends_with(pattern))
            .ok_or_else(|| "No suitable update asset found for this platform".to_string())?
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        return Err("Auto-update not supported on this platform".to_string());
    }

    Ok(Some(UpdateInfo {
        version: new_version.to_string(),
        download_url: asset.browser_download_url.clone(),
        asset_name: asset.name.clone(),
    }))
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    update_info: UpdateInfo,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("brainbox-updater")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&update_info.download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let total_size = response.content_length();

    // Get temp directory for download
    let temp_dir = std::env::temp_dir();
    let download_path = temp_dir.join(&update_info.asset_name);

    // Stream download with progress
    let mut file = std::fs::File::create(&download_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| format!("Failed to write chunk: {}", e))?;

        downloaded += chunk.len() as u64;

        if let Some(total) = total_size {
            let progress = (downloaded as f64 / total as f64) * 100.0;
            let _ = app.emit("update-progress", progress);
        }
    }

    let _ = app.emit("update-downloaded", ());

    Ok(download_path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn escape_powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "macos")]
fn escape_bash_literal(value: &str) -> String {
    value.replace('\'', "'\\''")
}

#[tauri::command]
pub fn apply_update(app: tauri::AppHandle, update_path: String) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Auto-update is disabled in dev builds.".to_string());
    }

    let update_file = Path::new(&update_path);
    if !update_file.exists() {
        return Err("Update file not found.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let is_portable = is_portable_install()?;
        if is_portable {
            let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let pid = std::process::id();
            let script = format!(
                r#"
                $pid = {}
                $src = '{}'
                $dst = '{}'
                try {{ Wait-Process -Id $pid -ErrorAction SilentlyContinue }} catch {{}}
                Start-Sleep -Milliseconds 200
                Move-Item -Force $src $dst
                Start-Process -FilePath $dst
                "#,
                pid,
                escape_powershell_literal(&update_path),
                escape_powershell_literal(&current_exe.to_string_lossy()),
            );

            Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            // For Windows NSIS installer, just run it and exit
            Command::new(&update_path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let pid = std::process::id();

        // Get the .app bundle path (current_exe is inside .app/Contents/MacOS/)
        let app_bundle = current_exe
            .parent() // MacOS/
            .and_then(|p| p.parent()) // Contents/
            .and_then(|p| p.parent()) // .app bundle
            .ok_or("Could not determine app bundle path")?;

        // Extract the tar.gz and replace the app
        let temp_dir = std::env::temp_dir();
        let extract_dir = temp_dir.join("brainbox-update");

        // Clean up any previous extract
        let _ = std::fs::remove_dir_all(&extract_dir);
        std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

        let script = format!(
            r#"
            pid={}
            archive='{}'
            extract_dir='{}'
            target='{}'

            # Wait for app to exit
            while kill -0 $pid 2>/dev/null; do sleep 0.2; done

            # Extract update
            tar -xzf "$archive" -C "$extract_dir"

            # Find the .app bundle in extracted files
            app_path=$(find "$extract_dir" -name "*.app" -maxdepth 1 | head -1)

            if [ -n "$app_path" ]; then
                rm -rf "$target"
                mv -f "$app_path" "$target"
                xattr -cr "$target" 2>/dev/null || true
                open "$target"
            fi

            # Cleanup
            rm -rf "$extract_dir"
            rm -f "$archive"
            "#,
            pid,
            escape_bash_literal(&update_path),
            escape_bash_literal(&extract_dir.to_string_lossy()),
            escape_bash_literal(&app_bundle.to_string_lossy()),
        );

        Command::new("bash")
            .args(["-c", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        return Err("Auto-update is not supported on this platform.".to_string());
    }

    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    // Check for update
    let update_info = check_for_updates().await?.ok_or("No update available")?;

    // Download update
    let update_path = download_update(app.clone(), update_info).await?;

    // Apply update
    apply_update(app, update_path)
}
