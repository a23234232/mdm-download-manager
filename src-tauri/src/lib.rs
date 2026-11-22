mod api;
mod engine;
mod manager;
mod model;
mod util;

use api::ApiRuntime;
use manager::DownloadManager;
use model::{AddInput, SettingsPatch};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State, Window};

#[derive(Clone)]
struct AppState {
    manager: DownloadManager,
    api: Arc<ApiRuntime>,
    data_dir: PathBuf,
    extension_dir: PathBuf,
}

#[tauri::command]
fn mdm_snapshot(state: State<'_, AppState>) -> Value {
    state.manager.snapshot()
}

#[tauri::command]
async fn mdm_invoke(
    window: Window,
    state: State<'_, AppState>,
    channel: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let manager = state.manager.clone();
    match channel.as_str() {
        "app:snapshot" => Ok(manager.snapshot()),
        "app:window" => {
            let action = payload.as_ref().and_then(|value| value.as_str()).unwrap_or("");
            match action {
                "minimize" => window.minimize().map_err(|error| error.to_string())?,
                "maximize" => {
                    if window.is_maximized().unwrap_or(false) {
                        window.unmaximize().map_err(|error| error.to_string())?;
                    } else {
                        window.maximize().map_err(|error| error.to_string())?;
                    }
                }
                "close" => window.close().map_err(|error| error.to_string())?,
                _ => {}
            }
            Ok(Value::Null)
        }
        "app:clipboard" => {
            let text = payload.as_ref().and_then(|value| value.as_str()).unwrap_or("");
            set_clipboard(text)?;
            Ok(Value::Null)
        }
        "app:open-path" => {
            let path = payload.as_ref().and_then(|value| value.as_str()).unwrap_or("");
            if path.is_empty() { return Ok(Value::Null); }
            open_path(Path::new(path))?;
            Ok(Value::String(path.to_string()))
        }
        "app:show-item" => {
            let path = payload.as_ref().and_then(|value| value.as_str()).unwrap_or("");
            reveal_in_explorer(path);
            Ok(Value::Null)
        }
        "app:open-external" => {
            let url = payload.as_ref().and_then(|value| value.as_str()).unwrap_or("");
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("仅支持打开 HTTP(S) 链接".into());
            }
            open_url(url)?;
            Ok(Value::Null)
        }
        "downloads:add" => {
            let input: AddInput = serde_json::from_value(payload.unwrap_or(Value::Null))
                .map_err(|error| format!("下载参数不正确：{}", error))?;
            let id = manager.add(input).await?;
            Ok(json!({ "taskId": id }))
        }
        "downloads:pause" | "downloads:resume" | "downloads:cancel" | "downloads:retry" | "downloads:remove" => {
            let id = payload.as_ref().and_then(|value| value.as_str()).ok_or_else(|| "缺少任务 ID".to_string())?;
            match channel.as_str() {
                "downloads:pause" => manager.pause(id).await?,
                "downloads:resume" => manager.resume(id).await?,
                "downloads:cancel" => manager.cancel(id).await?,
                "downloads:retry" => manager.retry(id).await?,
                _ => manager.remove(id).await?,
            }
            Ok(Value::Null)
        }
        "downloads:clear-completed" => {
            manager.clear_completed().await?;
            Ok(Value::Null)
        }
        "downloads:open-file" => {
            let id = payload.as_ref().and_then(|value| value.as_str()).ok_or_else(|| "缺少任务 ID".to_string())?;
            let task = manager.get_task(id).ok_or_else(|| "任务不存在".to_string())?;
            if task.save_path.is_empty() || !Path::new(&task.save_path).exists() {
                return Err("文件不存在或已被移动".into());
            }
            open_path(Path::new(&task.save_path))?;
            Ok(Value::Null)
        }
        "downloads:open-folder" | "downloads:reveal-in-explorer" => {
            let id = payload.as_ref().and_then(|value| value.as_str()).ok_or_else(|| "缺少任务 ID".to_string())?;
            let task = manager.get_task(id).ok_or_else(|| "任务不存在".to_string())?;
            let target = if task.save_path.is_empty() { task.directory } else { task.save_path };
            reveal_in_explorer(&target);
            Ok(Value::Null)
        }
        "downloads:copy-link" => {
            let id = payload.as_ref().and_then(|value| value.as_str()).ok_or_else(|| "缺少任务 ID".to_string())?;
            let task = manager.get_task(id).ok_or_else(|| "任务不存在".to_string())?;
            set_clipboard(task.final_url.as_deref().unwrap_or(&task.url))?;
            Ok(Value::Null)
        }
        "settings:update" => {
            let patch: SettingsPatch = serde_json::from_value(payload.unwrap_or(Value::Null))
                .map_err(|error| format!("设置参数不正确：{}", error))?;
            let previous = manager.settings();
            let updated = manager.update_settings(patch).await?;
            if previous.port != updated.port {
                if let Err(error) = state.api.set_port(updated.port).await {
                    let mut revert = SettingsPatch::default();
                    revert.port = Some(previous.port);
                    let _ = manager.update_settings(revert).await;
                    let _ = state.api.set_port(previous.port).await;
                    return Err(format!("端口启动失败：{}", error));
                }
            }
            serde_json::to_value(updated).map_err(|error| error.to_string())
        }
        "settings:choose-directory" => {
            let value = tokio::task::spawn_blocking(choose_directory)
                .await
                .map_err(|error| error.to_string())?;
            Ok(match value {
                Some(path) => Value::String(path),
                None => Value::Null,
            })
        }
        "api:rotate-token" => {
            state.api.rotate_token().await?;
            serde_json::to_value(state.api.status()).map_err(|error| error.to_string())
        }
        "shell:open-extension-dir" => {
            let directory = state.extension_dir.clone();
            if !directory.exists() {
                return Err(format!("扩展目录不存在：{}", directory.display()));
            }
            open_path(&directory)?;
            Ok(Value::Null)
        }
        "shell:open-data-dir" => {
            open_path(&state.data_dir)?;
            Ok(Value::Null)
        }
        other => Err(format!("未知操作：{}", other)),
    }
}

fn set_clipboard(text: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut child = std::process::Command::new("clip")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| format!("写入剪贴板失败：{}", error))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(text.as_bytes()).map_err(|error| format!("写入剪贴板失败：{}", error))?;
        }
        let _ = child.wait();
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("当前平台暂不支持剪贴板".into())
    }
}

fn open_path(path: &Path) -> Result<(), String> {
    if !path.exists() { return Err("路径不存在".into()); }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|error| format!("打开路径失败：{}", error))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| format!("打开路径失败：{}", error))?;
        Ok(())
    }
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|error| format!("打开链接失败：{}", error))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("打开链接失败：{}", error))?;
        Ok(())
    }
}

fn reveal_in_explorer(path: &str) {
    if path.is_empty() { return; }
    let candidate = Path::new(path);
    let directory = if candidate.is_file() {
        candidate.parent().map(|parent| parent.to_path_buf()).unwrap_or_else(|| PathBuf::from(path))
    } else {
        candidate.to_path_buf()
    };
    #[cfg(windows)]
    {
        if candidate.is_file() {
            let _ = std::process::Command::new("explorer").arg(format!("/select,{}", candidate.display())).spawn();
        } else if directory.exists() {
            let _ = std::process::Command::new("explorer").arg(&directory).spawn();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&directory).spawn();
    }
}

fn choose_directory() -> Option<String> {
    #[cfg(windows)]
    {
        let script = "$shell = New-Object -ComObject Shell.Application; $folder = $shell.BrowseForFolder(0, 'Select download directory', 0, ''); if ($folder) { Write-Output $folder.Self.Path }";
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()
            .ok()?;
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() { None } else { Some(value) }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".").join("mdm-data"));
            let _ = std::fs::create_dir_all(&data_dir);
            let extension_dir = app
                .path()
                .resource_dir()
                .map(|path| path.join("chrome-extension"))
                .unwrap_or_else(|_| PathBuf::from("extension"));
            let manager = DownloadManager::new(data_dir.clone());
            let api = ApiRuntime::new(manager.clone(), data_dir.clone(), manager.settings().port);
            tauri::async_runtime::block_on(async {
                manager.init().await?;
                let port = manager.settings().port;
                if api.port() != port {
                    let _ = api.set_port(port).await;
                } else {
                    let _ = api.start().await;
                }
                Ok::<(), String>(())
            })
            .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            manager.schedule();
            app.manage(AppState { manager: manager.clone(), api, data_dir, extension_dir });
            let handle = app.handle().clone();
            let ticker_manager = manager.clone();
            tauri::async_runtime::spawn(async move {
                let mut counter = 0u64;
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    ticker_manager.tick();
                    counter += 1;
                    if counter % 12 == 0 {
                        ticker_manager.persist().await;
                    }
                    let _ = handle.emit("state:update", ticker_manager.snapshot());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![mdm_snapshot, mdm_invoke])
        .run(tauri::generate_context!())
        .expect("error while running MDM");
}
