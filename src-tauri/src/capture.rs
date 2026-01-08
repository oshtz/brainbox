//! Capture module for hotkey, screenshot, and metadata collection
//! Cross-platform implementation

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// Windows-specific imports
#[cfg(target_os = "windows")]
use {
    dirs,
    image::RgbaImage,
    screenshots::Screen,
    whoami,
    windows::Win32::Foundation::{HWND, MAX_PATH, RECT},
    windows::Win32::System::ProcessStatus::K32GetModuleBaseNameW,
    windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
    windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId},
};

// Cross-platform imports for non-Windows platforms
#[cfg(not(target_os = "windows"))]
use {
    dirs,
    image::RgbaImage,
    screenshots::Screen,
    whoami,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct CaptureMetadata {
    pub timestamp: DateTime<Local>,
    pub app_name: String,
    pub window_title: String,
    pub user: String,
    pub screenshot_path: PathBuf,
}

#[cfg(target_os = "windows")]
pub mod windows_capture {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    pub fn get_focused_window_info() -> Option<(String, String)> {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0 == 0 {
                return None;
            }
            // Get window title
            let mut title = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut title);
            let window_title = OsString::from_wide(&title[..len as usize]).to_string_lossy().into_owned();
            // Get process id
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            // Open process
            let h_process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
            let h_process = match h_process {
                Ok(h) => h,
                Err(_) => return Some(("Unknown".to_string(), window_title)),
            };
            if h_process.is_invalid() {
                return Some(("Unknown".to_string(), window_title));
            }
            // Get process name
            let mut name_buf = [0u16; MAX_PATH as usize];
            let name_len = K32GetModuleBaseNameW(h_process, None, &mut name_buf);
            let app_name = OsString::from_wide(&name_buf[..name_len as usize]).to_string_lossy().into_owned();
            Some((app_name, window_title))
        }
    }

    pub fn capture_screenshot_and_metadata() -> Option<CaptureMetadata> {
        let (app_name, window_title) = get_focused_window_info()?;
        let user = whoami::username();
        let timestamp = Local::now();
        let screenshot_dir = dirs::data_local_dir()?.join("brainbox").join("captures");
        std::fs::create_dir_all(&screenshot_dir).ok()?;
        let filename = format!("{}_{}.png", app_name, timestamp.format("%Y%m%d_%H%M%S"));
        let screenshot_path = screenshot_dir.join(filename);
        // Get active window bounds
        let hwnd = unsafe { GetForegroundWindow() };
        let mut rect = RECT::default();
        let got_rect = unsafe { GetWindowRect(hwnd, &mut rect) };
        if got_rect.is_ok() {
            // Find the screen containing the window (use first as fallback)
            let screens = Screen::all().ok()?;
            let screen = screens.iter().find(|s| {
                let (sx, sy, sw, sh) = (s.display_info.x, s.display_info.y, s.display_info.width, s.display_info.height);
                rect.left >= sx && rect.left < sx + sw as i32 && rect.top >= sy && rect.top < sy + sh as i32
            }).unwrap_or_else(|| &screens[0]);
            // Crop to window
            let x = (rect.left - screen.display_info.x).max(0) as i32;
            let y = (rect.top - screen.display_info.y).max(0) as i32;
            let width = (rect.right - rect.left).max(1) as u32;
            let height = (rect.bottom - rect.top).max(1) as u32;
            if let Ok(image) = screen.capture_area(x, y, width, height) {
                let buf = image.rgba();
                let img_buf = RgbaImage::from_raw(image.width(), image.height(), buf.to_vec())?;
                img_buf.save(&screenshot_path).ok()?;
            } else {
                return None;
            }
        } else {
            // Fallback: capture full primary screen
            let screens = Screen::all().ok()?;
            let screen = &screens[0];
            if let Ok(image) = screen.capture() {
                let buf = image.rgba();
                let img_buf = RgbaImage::from_raw(image.width(), image.height(), buf.to_vec())?;
                img_buf.save(&screenshot_path).ok()?;
            } else {
                return None;
            }
        }
        Some(CaptureMetadata {
            timestamp,
            app_name,
            window_title,
            user,
            screenshot_path,
        })
    }
}

// Stub implementations for non-Windows platforms
#[cfg(not(target_os = "windows"))]
pub mod cross_platform_capture {
    use super::*;

    pub fn get_focused_window_info() -> Option<(String, String)> {
        // Placeholder for macOS implementation
        Some(("Unknown App".to_string(), "Unknown Window".to_string()))
    }

    pub fn capture_screenshot_and_metadata() -> Option<CaptureMetadata> {
        let user = whoami::username();
        let timestamp = Local::now();
        let screenshot_dir = dirs::data_local_dir()?.join("brainbox").join("captures");
        std::fs::create_dir_all(&screenshot_dir).ok()?;
        let filename = format!("capture_{}.png", timestamp.format("%Y%m%d_%H%M%S"));
        let screenshot_path = screenshot_dir.join(filename);

        // Basic full-screen capture for non-Windows platforms
        let screens = Screen::all().ok()?;
        if let Some(screen) = screens.first() {
            if let Ok(image) = screen.capture() {
                let buf = image.rgba();
                let img_buf = RgbaImage::from_raw(image.width(), image.height(), buf.to_vec())?;
                img_buf.save(&screenshot_path).ok()?;
            } else {
                return None;
            }
        }

        Some(CaptureMetadata {
            timestamp,
            app_name: "Unknown App".to_string(),
            window_title: "Unknown Window".to_string(),
            user,
            screenshot_path,
        })
    }
}

// Public API that works across platforms
pub fn capture_screenshot_and_metadata() -> Option<CaptureMetadata> {
    #[cfg(target_os = "windows")]
    {
        windows_capture::capture_screenshot_and_metadata()
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        cross_platform_capture::capture_screenshot_and_metadata()
    }
}

pub fn get_focused_window_info() -> Option<(String, String)> {
    #[cfg(target_os = "windows")]
    {
        windows_capture::get_focused_window_info()
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        cross_platform_capture::get_focused_window_info()
    }
}
