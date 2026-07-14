// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod network_commands;
mod paths;
mod search;
mod secret_commands;
mod sync;
mod sync_commands;
mod updater;
mod vault;
mod vault_commands;

use std::sync::Mutex;
use tauri::Manager;

#[cfg(target_os = "windows")]
use tauri::Runtime;

// Only import what's actually used
use tauri::State;

// Store the current hotkey in memory
struct HotkeyState {
    current_hotkey: Mutex<Option<String>>,
}

// Queue for pending protocol captures when the window isn't ready yet
struct ProtocolState {
    pending: Mutex<Option<(String, String)>>, // (url, title)
}

// Keep the tray icon alive (otherwise events may not fire)
struct TrayState {
    _tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

// FIX: Import the required trait for global_shortcut()
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::paths::brainbox_data_dir;
use crate::search::{delete_document, index_document, search};
use tiny_http::{Response, Server};

const MAX_CAPTURE_SELECTION_CHARS: usize = 2_000;

fn parse_capture_query(query: &str) -> (String, String, Option<String>) {
    let mut url = String::new();
    let mut title = String::new();
    let mut selection = None;

    for param in query.split('&') {
        let mut parts = param.splitn(2, '=');
        match (parts.next(), parts.next()) {
            (Some("url"), Some(value)) => {
                url = urlencoding::decode(value).unwrap_or_default().to_string()
            }
            (Some("title"), Some(value)) => {
                title = urlencoding::decode(value).unwrap_or_default().to_string()
            }
            (Some("selection"), Some(value)) => {
                let decoded = urlencoding::decode(value).unwrap_or_default().to_string();
                if !decoded.trim().is_empty() {
                    let mut chars = decoded.chars();
                    let limited: String =
                        chars.by_ref().take(MAX_CAPTURE_SELECTION_CHARS).collect();
                    selection = Some(if chars.next().is_some() {
                        format!("{limited}\n\n[Selection truncated]")
                    } else {
                        limited
                    });
                }
            }
            _ => {}
        }
    }

    (url, title, selection)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn register_capture_hotkey(
    app: tauri::AppHandle,
    state: State<HotkeyState>,
    hotkey: String,
) -> Result<(), String> {
    let global_shortcut = app.global_shortcut();
    // Unregister previous hotkey if any
    if let Some(prev) = state.current_hotkey.lock().unwrap().clone() {
        let shortcut: Shortcut = prev.parse().map_err(|e| format!("Invalid shortcut: {e}"))?;
        let _ = global_shortcut.unregister(shortcut);
    }
    // Register new hotkey
    let shortcut: Shortcut = hotkey
        .parse()
        .map_err(|e| format!("Invalid shortcut: {e}"))?;
    let app_clone = app.clone();
    global_shortcut
        .on_shortcut(shortcut, move |_app, _shortcut, _event| {
            // Focus the main window when the hotkey is pressed
            if let Some(window) = app_clone.get_webview_window("main") {
                let _ = window.set_focus();
            }
            let _ = app_clone.emit("capture-hotkey-pressed", ());
        })
        .map_err(|e| format!("Failed to register hotkey: {e}"))?;
    *state.current_hotkey.lock().unwrap() = Some(hotkey);
    Ok(())
}

#[tauri::command]
fn unregister_capture_hotkey(
    app: tauri::AppHandle,
    state: State<HotkeyState>,
) -> Result<(), String> {
    let global_shortcut = app.global_shortcut();
    if let Some(prev) = state.current_hotkey.lock().unwrap().clone() {
        let shortcut: Shortcut = prev.parse().map_err(|e| format!("Invalid shortcut: {e}"))?;
        let _ = global_shortcut.unregister(shortcut);
        *state.current_hotkey.lock().unwrap() = None;
    }
    Ok(())
}

/// Get device hostname (for default device name)
#[tauri::command]
fn get_hostname() -> String {
    whoami::fallible::hostname().unwrap_or_else(|_| "Unknown".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn register_brainbox_protocol() -> Result<(), String> {
    use std::env;
    use winreg::enums::*;
    use winreg::RegKey;

    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe_path.to_str().ok_or("Invalid exe path")?;

    // Use HKEY_CURRENT_USER for per-user protocol registration (no admin rights needed)
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (classes, _) = hkcu
        .create_subkey("Software\\Classes")
        .map_err(|e| e.to_string())?;
    let (key, _) = classes
        .create_subkey("brainbox")
        .map_err(|e| e.to_string())?;
    key.set_value("", &"URL:brainbox Protocol")
        .map_err(|e| e.to_string())?;
    key.set_value("URL Protocol", &"")
        .map_err(|e| e.to_string())?;

    // Add "DefaultIcon" (optional but recommended)
    let (icon_key, _) = key
        .create_subkey("DefaultIcon")
        .map_err(|e| e.to_string())?;
    icon_key
        .set_value("", &format!("\"{}\",0", exe_str))
        .map_err(|e| e.to_string())?;

    // Create the command key and set the command to launch your app with the URL
    let shell = key.create_subkey("shell").map_err(|e| e.to_string())?.0;
    let open = shell.create_subkey("open").map_err(|e| e.to_string())?.0;
    let command = open.create_subkey("command").map_err(|e| e.to_string())?.0;

    // The key part: Use "--brainbox-protocol" flag to help with multiple instance handling
    command
        .set_value("", &format!("\"{}\" --brainbox-protocol \"%1\"", exe_str))
        .map_err(|e| e.to_string())?;

    Ok(())
}

// --- Protocol handler for brainbox://capture?url=...&title=...
#[cfg(target_os = "windows")]
fn handle_protocol_url<R: Runtime>(app: &tauri::AppHandle<R>, url: &str) {
    // Only handle brainbox://capture?url=...&title=...
    if let Some(rest) = url.strip_prefix("brainbox://capture?") {
        let mut capture_url = String::new();
        let mut title = String::new();
        for param in rest.split('&') {
            let mut parts = param.splitn(2, '=');
            match (parts.next(), parts.next()) {
                (Some("url"), Some(val)) => {
                    capture_url = urlencoding::decode(val).unwrap_or_default().to_string();
                }
                (Some("title"), Some(val)) => {
                    title = urlencoding::decode(val).unwrap_or_default().to_string();
                }
                _ => {}
            }
        }
        // Emit event to frontend (or queue if window not ready yet)
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();

            let _ = window.emit(
                "capture-from-protocol",
                serde_json::json!({
                    "url": capture_url,
                    "title": title,
                }),
            );

            // no always-on-top (not available on this Webview type)
        } else {
            // queue it for when the window is available; delivery happens on page load
            if let Some(state) = app.try_state::<ProtocolState>() {
                let mut pending = state.pending.lock().unwrap();
                *pending = Some((capture_url, title));
            }
        }
    }
}

// Platform-specific builder functions
#[cfg(not(target_os = "windows"))]
fn create_app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .on_page_load(|window, _| {
            // Deliver any queued protocol capture when the main window finishes loading
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            if let Some(state) = app.try_state::<ProtocolState>() {
                let mut pending = state.pending.lock().unwrap();
                if let Some((url, title)) = pending.take() {
                    // ensure visibility
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit(
                        "capture-from-protocol",
                        serde_json::json!({
                            "url": url,
                            "title": title,
                        }),
                    );
                    // no always-on-top toggle in this build
                }
            }
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("Alt+Shift+B")
                .expect("Failed to register shortcut")
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Forward protocol URLs to the existing instance
            for arg in args.iter() {
                if arg.starts_with("brainbox://capture?") {
                    #[cfg(target_os = "windows")]
                    {
                        handle_protocol_url(&app, arg);
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    break;
                }
            }
        }))
}

#[cfg(target_os = "windows")]
fn create_app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .on_page_load(|window, _| {
            // Deliver any queued protocol capture when the main window finishes loading
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            if let Some(state) = app.try_state::<ProtocolState>() {
                let mut pending = state.pending.lock().unwrap();
                if let Some((url, title)) = pending.take() {
                    // ensure visibility
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit(
                        "capture-from-protocol",
                        serde_json::json!({
                            "url": url,
                            "title": title,
                        }),
                    );
                    // no always-on-top toggle in this build
                }
            }
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("Alt+Shift+B")
                .expect("Failed to register shortcut")
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            for arg in args {
                if arg.starts_with("brainbox://capture?") {
                    handle_protocol_url(app, &arg);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    break;
                }
            }
        }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    create_app_builder()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .setup(|app| {
            // Initialize the search service with a path for the index
            let app_dir = brainbox_data_dir()?;
            let index_dir = app_dir.join("search_index");

            eprintln!("brainbox: Creating search index directory: {:?}", index_dir);

            // Create directory with better error handling
            if let Err(e) = std::fs::create_dir_all(&index_dir) {
                eprintln!("brainbox: Failed to create index directory: {}", e);
                eprintln!("brainbox: App will continue without search functionality");
            } else {
                eprintln!("brainbox: Initializing search service...");

                // Try to initialize search service with graceful fallback
                match search::init_search_service(&index_dir) {
                    Ok(_) => {
                        eprintln!("brainbox: Search service initialized successfully");
                    },
                    Err(e) => {
                        eprintln!("brainbox: Failed to initialize search service: {}", e);

                        // Only attempt recovery on macOS where the issue is known to occur
                        #[cfg(target_os = "macos")]
                        {
                            eprintln!("brainbox: Attempting automatic recovery (macOS-specific fix)...");

                            // Try to recover by clearing the corrupted index
                            if let Err(recovery_err) = search::SearchService::recover_index(&index_dir) {
                                eprintln!("brainbox: Index recovery failed: {}", recovery_err);
                            } else {
                                eprintln!("brainbox: Index recovery completed, retrying initialization...");

                                // Retry initialization after recovery
                                match search::init_search_service(&index_dir) {
                                    Ok(_) => {
                                        eprintln!("brainbox: Search service initialized successfully after recovery");
                                        return Ok(());
                                    },
                                    Err(retry_err) => {
                                        eprintln!("brainbox: Search service initialization failed even after recovery: {}", retry_err);
                                    }
                                }
                            }
                        }

                        eprintln!("brainbox: This may be due to:");
                        #[cfg(target_os = "macos")]
                        eprintln!("  - Memory mapping issues on macOS M4 systems");
                        #[cfg(not(target_os = "macos"))]
                        eprintln!("  - Corrupted search index");
                        eprintln!("  - Insufficient disk space or permissions");
                        eprintln!("brainbox: App will continue without search functionality");
                    }
                }
            }

            // Initialize hotkey state
            app.manage(HotkeyState {
                current_hotkey: Mutex::new(Some("Alt+Shift+B".to_string())),
            });

            // Initialize protocol state (pending capture queue)
            app.manage(ProtocolState {
                pending: Mutex::new(None),
            });
            // Register default hotkey
            let app_handle = app.handle();
            let hotkey_state = app.state::<HotkeyState>();
            let _ = register_capture_hotkey(app_handle.clone(), hotkey_state, "Alt+Shift+B".to_string());

            // spawn HTTP server to receive captures
            let app_handle_http = app.handle().clone();
            std::thread::spawn(move || {
                let server = Server::http("127.0.0.1:51234").unwrap();
                for request in server.incoming_requests() {
                    if let Some(q) = request.url().strip_prefix("/capture?") {
                        let (url, title, selection) = parse_capture_query(q);
                        if let Some(window) = app_handle_http.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("capture-from-protocol", serde_json::json!({ "url": url, "title": title, "selection": selection }));
                        }
                    }
                    // Respond with a tiny page that attempts to close itself if it was opened by script
                    let html = r#"<!doctype html><meta charset=\"utf-8\"><title>brainbox Capture</title>
<style>body{font:13px system-ui;margin:24px;color:#222}</style>
<body>Captured to brainbox. This tab will close.
<script>
  (function(){
    try{ if (window.opener) { try{ window.opener.focus(); }catch(e){} } }catch(e){}
    try{ window.close(); }catch(e){}
    setTimeout(function(){
      try{ window.close(); }catch(e){ try{ location.replace('about:blank'); }catch(_){} }
    }, 200);
  })();
</script>
"#;
                    let mut resp = Response::from_string(html);
                    resp.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                    let _ = request.respond(resp);
                }
            });

            // Handle protocol URLs
            #[cfg(target_os = "windows")]
            {
                // Register custom protocol handler
                if let Err(e) = register_brainbox_protocol() {
                    eprintln!("Failed to register protocol: {}", e);
                }

                // Handle command line arguments at startup for protocol URLs
                // Check for our protocol URLs in the right format
                let args: Vec<String> = std::env::args().collect();

                // Look for protocol URLs in arguments
                let mut has_protocol_url = false;
                let mut protocol_url = String::new();

                for i in 1..args.len() {
                    if args[i] == "--brainbox-protocol" && i + 1 < args.len() && args[i + 1].starts_with("brainbox://capture?") {
                        protocol_url = args[i + 1].clone();
                        has_protocol_url = true;
                        break;
                    } else if args[i].starts_with("brainbox://capture?") {
                        protocol_url = args[i].clone();
                        has_protocol_url = true;
                        break;
                    }
                }

                if has_protocol_url {
                    // Process the URL immediately; if the window isn't ready yet, it will be queued
                    handle_protocol_url(app.handle(), &protocol_url);
                }
            }

            // Initialize system tray in Rust so it works even when the webview is hidden/suspended
            #[allow(unused_variables)]
            {
                use tauri::Manager;
                // Create a simple menu with Show / Hide / Quit
                #[allow(unused_imports)]
                use tauri::menu::{Menu, MenuItem};
                #[allow(unused_imports)]
                use tauri::tray::{TrayIconBuilder, TrayIconEvent};
                #[allow(unused_imports)]
                use tauri::image::Image as TauriImage;

                // Build menu and tray using current Tauri 2 API
                let show = MenuItem::new(app, "show", true, None::<&str>)?;
                show.set_text("Show Brainbox")?;
                let hide = MenuItem::new(app, "hide", true, None::<&str>)?;
                hide.set_text("Hide to Tray")?;
                let quit = MenuItem::new(app, "quit", true, None::<&str>)?;
                quit.set_text("Quit")?;

                let menu = Menu::new(app)?;
                menu.append(&show)?;
                menu.append(&hide)?;
                menu.append(&quit)?;

                // Capture stable IDs for menu event comparison
                let show_id = show.id().clone();
                let hide_id = hide.id().clone();
                let quit_id = quit.id().clone();
                // Prefer the app's default window icon (honors platform formats: .ico on Windows, .icns on macOS)
                let mut tray_builder = TrayIconBuilder::new();
                if let Some(img) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(img.clone());
                } else if let Ok(img) = TauriImage::from_path("icons/icon.png") {
                    // Fallback to our bundled PNG if default icon isn't available
                    tray_builder = tray_builder.icon(img);
                }

                let tray = tray_builder
                    .menu(&menu)
                    .on_menu_event(move |app, event| {
                        let id = event.id();
                        eprintln!("[tray] menu event: {:?}", id);
                        if id == &show_id {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        } else if id == &hide_id {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        } else if id == &quit_id {
                            app.exit(0);
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        // Show on double click
                        if let TrayIconEvent::DoubleClick { .. } = event {
                            eprintln!("[tray] double click");
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)
                    .expect("Failed to build tray icon");

                // store tray handle so callbacks stay alive
                app.manage(TrayState { _tray: Mutex::new(Some(tray)) });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            search,
            index_document,
            delete_document,
            register_capture_hotkey,
            unregister_capture_hotkey,
            vault_commands::create_vault,
            vault_commands::list_vaults,
            vault_commands::delete_vault,
            vault_commands::rename_vault,
            vault_commands::update_vault_cover,
            vault_commands::add_vault_item,
            vault_commands::list_vault_items,
            vault_commands::verify_vault_password,
            vault_commands::delete_vault_item,
            vault_commands::update_vault_items_order,
            vault_commands::update_vault_item_title,
            vault_commands::update_vault_item_content,
            vault_commands::move_vault_item,
            vault_commands::update_vault_item_image,
            vault_commands::update_vault_item_summary,
            vault_commands::change_vault_password,
            vault_commands::export_vaults,
            vault_commands::import_vaults,
            vault_commands::get_vault_item,
            // Sync commands
            sync_commands::sync_export_vaults,
            sync_commands::sync_import_vaults,
            sync_commands::get_sync_status,
            sync_commands::get_sync_preview,
            sync_commands::get_locked_vaults_for_sync,
            sync_commands::get_sync_settings,
            sync_commands::set_sync_setting,
            sync_commands::set_sync_folder,
            sync_commands::purge_deleted_items,
            sync_commands::auto_purge_if_enabled,
            sync_commands::is_sync_on_close_enabled,
            sync_commands::set_sync_on_close,
            sync_commands::is_check_sync_on_startup_enabled,
            sync_commands::set_check_sync_on_startup,
            sync_commands::set_device_name,
            get_hostname,
            network_commands::fetch_url_metadata,
            // Scraping helpers
            network_commands::fetch_url_text,
            network_commands::fetch_youtube_transcript,
            // Ollama integration
            network_commands::ollama_list_models,
            network_commands::ollama_generate,
            network_commands::ollama_generate_stream,
            secret_commands::get_ai_secret,
            secret_commands::set_ai_secret,
            quit_app,
            // Update checks are read-only; installation remains manual until
            // signed Tauri updater artifacts are configured.
            updater::get_current_version,
            updater::check_for_updates,
            #[cfg(target_os = "windows")]
            register_brainbox_protocol,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod capture_tests {
    use super::{parse_capture_query, MAX_CAPTURE_SELECTION_CHARS};

    #[test]
    fn parses_and_limits_localhost_capture() {
        let (url, title, selection) = parse_capture_query(
            "url=https%3A%2F%2Fexample.com%2Farticle&title=Useful%20article&selection=chosen%20words",
        );
        assert_eq!(url, "https://example.com/article");
        assert_eq!(title, "Useful article");
        assert_eq!(selection.as_deref(), Some("chosen words"));

        let long = "x".repeat(MAX_CAPTURE_SELECTION_CHARS + 1);
        let query = format!(
            "url=https%3A%2F%2Fexample.com&selection={}",
            urlencoding::encode(&long)
        );
        let (_, _, selection) = parse_capture_query(&query);
        assert_eq!(
            selection.unwrap(),
            format!(
                "{}\n\n[Selection truncated]",
                "x".repeat(MAX_CAPTURE_SELECTION_CHARS)
            )
        );

        assert_eq!(
            parse_capture_query("url=https%3A%2F%2Fexample.com&title=Page").2,
            None
        );
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) -> Result<(), ()> {
    app.exit(0);
    Ok(())
}
