use crate::engine::dash_download::download_dash;
use crate::engine::ftp::{download_ftp, probe_ftp};
use crate::engine::hls_download::download_hls;
use crate::engine::http::{download_http, HttpJob, HttpSegmentPlan};
use crate::engine::probe::{probe, ProbeResult};
use crate::engine::stream::{StreamJob, StreamOutput};
use crate::engine::find_ffmpeg;
use crate::model::*;
use crate::util::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;

#[derive(Clone, Debug, serde::Serialize)]
pub struct ManagerEvent {
    pub kind: String,
    pub id: Option<String>,
    pub message: Option<String>,
}

struct TaskEntry {
    task: DownloadTask,
    cancel: Option<Arc<AtomicBool>>,
    progress: Arc<AtomicU64>,
    active: Arc<AtomicU32>,
    running: bool,
    last_bytes: u64,
    last_time: i64,
    segment_progress: Vec<Arc<AtomicU64>>,
}

impl TaskEntry {
    fn new(task: DownloadTask) -> Self {
        let last_bytes = task.downloaded_bytes;
        Self {
            task,
            cancel: None,
            progress: Arc::new(AtomicU64::new(last_bytes)),
            active: Arc::new(AtomicU32::new(0)),
            running: false,
            last_bytes,
            last_time: now_ms(),
            segment_progress: Vec::new(),
        }
    }
}

struct Inner {
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    tasks: Mutex<Vec<TaskEntry>>,
    api: Mutex<ApiStatus>,
    events: tokio::sync::broadcast::Sender<ManagerEvent>,
}

#[derive(Clone)]
pub struct DownloadManager {
    inner: Arc<Inner>,
}

impl DownloadManager {
    pub fn new(data_dir: PathBuf) -> Self {
        let (events, _) = tokio::sync::broadcast::channel(128);
        let mut settings = Settings::default();
        settings.download_directory = default_download_dir();
        let api = ApiStatus {
            running: false,
            port: settings.port,
            token: String::new(),
            url: format!("http://127.0.0.1:{}/api/v1", settings.port),
            last_extension_contact_at: None,
            last_error: None,
            requests: 0,
        };
        Self {
            inner: Arc::new(Inner {
                data_dir,
                settings: Mutex::new(settings),
                tasks: Mutex::new(Vec::new()),
                api: Mutex::new(api),
                events,
            }),
        }
    }

    pub async fn init(&self) -> Result<(), String> {
        tokio::fs::create_dir_all(&self.inner.data_dir).await.map_err(|error| format!("创建数据目录失败：{}", error))?;
        let settings_path = self.inner.data_dir.join("settings.json");
        if settings_path.exists() {
            if let Ok(bytes) = tokio::fs::read(&settings_path).await {
                if let Ok(mut loaded) = serde_json::from_slice::<Settings>(&bytes) {
                    normalize_settings(&mut loaded);
                    *self.inner.settings.lock().unwrap() = loaded;
                }
            }
        } else {
            let mut settings = self.inner.settings.lock().unwrap().clone();
            normalize_settings(&mut settings);
            *self.inner.settings.lock().unwrap() = settings;
        }
        let settings = self.settings();
        if !settings.download_directory.is_empty() {
            let _ = tokio::fs::create_dir_all(&settings.download_directory).await;
        }

        let tasks_path = self.inner.data_dir.join("tasks.json");
        let mut loaded: Vec<DownloadTask> = Vec::new();
        if tasks_path.exists() {
            if let Ok(bytes) = tokio::fs::read(&tasks_path).await {
                if let Ok(tasks) = serde_json::from_slice::<Vec<DownloadTask>>(&bytes) {
                    loaded = tasks;
                }
            }
        }
        for task in loaded.iter_mut() {
            if matches!(task.status.as_str(), "queued" | "connecting" | "downloading") {
                task.status = "paused".into();
            }
            task.speed = 0.0;
            task.active_connections = 0;
            task.eta_seconds = None;
            if task.status == "completed" && !task.save_path.is_empty() && !Path::new(&task.save_path).exists() {
                task.file_missing = true;
            }
        }
        *self.inner.tasks.lock().unwrap() = loaded.into_iter().map(TaskEntry::new).collect();
        {
            let mut api = self.inner.api.lock().unwrap();
            api.port = settings.port;
            api.url = format!("http://127.0.0.1:{}/api/v1", settings.port);
        }
        self.save_settings().await?;
        self.save_tasks().await?;
        Ok(())
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<ManagerEvent> {
        self.inner.events.subscribe()
    }

    fn emit(&self, kind: &str, id: Option<String>, message: Option<String>) {
        let _ = self.inner.events.send(ManagerEvent { kind: kind.into(), id, message });
    }

    pub fn settings(&self) -> Settings {
        self.inner.settings.lock().unwrap().clone()
    }

    pub fn api_status(&self) -> ApiStatus {
        self.inner.api.lock().unwrap().clone()
    }

    pub fn set_api_status(&self, status: ApiStatus) {
        *self.inner.api.lock().unwrap() = status;
    }

    pub fn update_api_contact(&self, requests: u64) {
        let mut api = self.inner.api.lock().unwrap();
        api.requests = requests;
        api.last_extension_contact_at = Some(now_ms());
    }

    pub fn set_api_error(&self, error: Option<String>) {
        self.inner.api.lock().unwrap().last_error = error;
    }

    pub fn public_tasks(&self) -> Vec<serde_json::Value> {
        self.inner.tasks.lock().unwrap().iter().map(|entry| entry.task.to_public()).collect()
    }

    pub fn get_task(&self, id: &str) -> Option<DownloadTask> {
        self.inner.tasks.lock().unwrap().iter().find(|entry| entry.task.id == id).map(|entry| entry.task.clone())
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let tasks = self.public_tasks();
        let settings = self.settings();
        let api = self.api_status();
        let (active_speed, active_count, queued_count, completed_count, total_downloaded) = {
            let entries = self.inner.tasks.lock().unwrap();
            let mut speed = 0.0;
            let mut active = 0u32;
            let mut queued = 0u32;
            let mut completed = 0u32;
            let mut total = 0u64;
            for entry in entries.iter() {
                if matches!(entry.task.status.as_str(), "downloading" | "connecting") {
                    speed += entry.task.speed;
                    active += 1;
                }
                if entry.task.status == "queued" { queued += 1; }
                if entry.task.status == "completed" {
                    completed += 1;
                    total += entry.task.total_bytes.max(entry.task.downloaded_bytes);
                }
            }
            (speed, active, queued, completed, total)
        };
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "tasks": tasks,
            "settings": settings,
            "api": api,
            "stats": {
                "activeSpeed": active_speed,
                "activeCount": active_count,
                "queuedCount": queued_count,
                "completedCount": completed_count,
                "totalDownloadedBytes": total_downloaded,
                "diskFreeBytes": serde_json::Value::Null
            }
        })
    }

    pub async fn add(&self, input: AddInput) -> Result<String, String> {
        let raw_url = input.url.trim().to_string();
        let parsed = url::Url::parse(&raw_url).map_err(|_| "下载链接格式不正确".to_string())?;
        let scheme = parsed.scheme().to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "ftp" | "ftps") {
            return Err("仅支持 HTTP、HTTPS、FTP 和 FTPS 链接".into());
        }
        let settings = self.settings();
        let mut directory = input.directory.clone().unwrap_or_default().trim().to_string();
        if directory.is_empty() {
            directory = if settings.download_directory.is_empty() { default_download_dir() } else { settings.download_directory.clone() };
        }
        tokio::fs::create_dir_all(&directory).await.map_err(|error| format!("创建下载目录失败：{}", error))?;
        let auto_named = input.file_name.as_deref().map(|name| name.trim().is_empty()).unwrap_or(true);
        let mut file_name = input.file_name.clone().unwrap_or_default();
        if file_name.trim().is_empty() {
            file_name = filename_from_url(&raw_url).unwrap_or_else(|| "download".into());
        }
        file_name = sanitize_file_name(&file_name);
        if file_name.is_empty() { file_name = "download".into(); }
        let checksum = match input.checksum.as_deref() {
            Some(value) if !value.trim().is_empty() => Some(parse_checksum(value)?),
            _ => None,
        };
        let request = if input.headers.as_ref().map(|headers| !headers.is_empty()).unwrap_or(false)
            || input.cookies.as_ref().map(|cookies| !cookies.is_empty()).unwrap_or(false)
            || input.referrer.as_ref().map(|referrer| !referrer.is_empty()).unwrap_or(false)
            || input.user_agent.as_ref().map(|agent| !agent.is_empty()).unwrap_or(false)
        {
            Some(RequestOptions {
                headers: input.headers.clone(),
                cookies: input.cookies.clone(),
                referrer: input.referrer.clone(),
                user_agent: input.user_agent.clone(),
            })
        } else {
            None
        };
        let now = now_ms();
        let id = format!("{:x}{:012x}", now, rand::random::<u64>());
        let connections = input.connections.unwrap_or(settings.default_connections).clamp(1, MAX_SEGMENTS);
        let task = DownloadTask {
            id: id.clone(),
            url: raw_url.clone(),
            final_url: None,
            protocol: if scheme.starts_with("ftp") { "ftp".into() } else { "http".into() },
            status: "queued".into(),
            file_name,
            directory: directory.clone(),
            save_path: String::new(),
            temp_path: String::new(),
            total_bytes: 0,
            downloaded_bytes: 0,
            speed: 0.0,
            eta_seconds: None,
            connections,
            active_connections: 0,
            range_supported: false,
            resumable: true,
            mime_type: None,
            etag: None,
            last_modified: None,
            error: None,
            created_at: now,
            updated_at: now,
            started_at: None,
            completed_at: None,
            segments: Vec::new(),
            stream: None,
            checksum,
            speed_limit_bps: input.speed_limit_bps.filter(|value| *value > 0),
            category: input.category.clone().filter(|value| !value.is_empty()).unwrap_or_else(|| category_for(&raw_url)),
            source: input.source.clone().unwrap_or_else(|| "app".into()),
            request,
            fragment_dir: None,
            live: false,
            file_missing: false,
            auto_named,
        };
        self.inner.tasks.lock().unwrap().push(TaskEntry::new(task));
        self.save_tasks().await?;
        self.emit("change", Some(id.clone()), None);
        self.schedule();
        Ok(id)
    }

    pub async fn update_settings(&self, patch: SettingsPatch) -> Result<Settings, String> {
        let mut settings = self.settings();
        if let Some(directory) = patch.download_directory { if !directory.trim().is_empty() { settings.download_directory = directory; } }
        if let Some(value) = patch.max_concurrent_downloads { settings.max_concurrent_downloads = value.clamp(1, 16); }
        if let Some(value) = patch.default_connections { settings.default_connections = value.clamp(1, MAX_SEGMENTS); }
        if let Some(value) = patch.global_speed_limit_bps { settings.global_speed_limit_bps = value; }
        if let Some(value) = patch.port { if (1024..=65535).contains(&value) { settings.port = value; } }
        if let Some(value) = patch.auto_start { settings.auto_start = value; }
        if let Some(value) = patch.notifications { settings.notifications = value; }
        if let Some(value) = patch.remux_streams { settings.remux_streams = value; }
        if let Some(value) = patch.theme { if matches!(value.as_str(), "dark" | "light" | "system") { settings.theme = value; } }
        *self.inner.settings.lock().unwrap() = settings.clone();
        self.save_settings().await?;
        self.schedule();
        self.emit("change", None, None);
        Ok(settings)
    }

    pub fn schedule(&self) {
        let max = self.settings().max_concurrent_downloads.clamp(1, 16) as usize;
        let mut ids: Vec<String> = Vec::new();
        let now = now_ms();
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            let running = entries.iter().filter(|entry| entry.running).count();
            let mut slots = max.saturating_sub(running);
            for entry in entries.iter_mut() {
                if slots == 0 { break; }
                if entry.task.status == "queued" && !entry.running {
                    entry.running = true;
                    entry.task.status = "connecting".into();
                    entry.task.error = None;
                    entry.task.speed = 0.0;
                    entry.task.active_connections = 0;
                    entry.cancel = Some(Arc::new(AtomicBool::new(false)));
                    entry.segment_progress.clear();
                    entry.last_bytes = entry.progress.load(Ordering::Relaxed);
                    entry.last_time = now;
                    ids.push(entry.task.id.clone());
                    slots -= 1;
                }
            }
        }
        for id in ids {
            let manager = self.clone();
            tokio::spawn(async move { manager.run(id).await; });
        }
    }

    async fn run(&self, id: String) {
        let result = self.execute(&id).await;
        let mut completed = false;
        let mut failed_message: Option<String> = None;
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            if let Some(entry) = entries.iter_mut().find(|entry| entry.task.id == id) {
                entry.running = false;
                entry.cancel = None;
                entry.active.store(0, Ordering::Relaxed);
                entry.task.speed = 0.0;
                entry.task.active_connections = 0;
                match result {
                    Ok(mut task) => {
                        entry.segment_progress.clear();
                        for segment in task.segments.iter_mut() {
                            segment.downloaded = segment.end.saturating_sub(segment.start);
                            segment.status = "done".into();
                        }
                        task.status = "completed".into();
                        task.completed_at = Some(now_ms());
                        task.updated_at = now_ms();
                        task.downloaded_bytes = if task.total_bytes > 0 { task.total_bytes } else { entry.progress.load(Ordering::Relaxed) };
                        task.total_bytes = task.downloaded_bytes;
                        entry.task = task;
                        entry.progress.store(entry.task.downloaded_bytes, Ordering::Relaxed);
                        completed = true;
                    }
                    Err(error) => {
                        if entry.task.status == "paused" || entry.task.status == "cancelled" || error == "CANCELLED" {
                            if entry.task.status != "cancelled" { entry.task.status = "paused".into(); }
                            entry.task.error = None;
                        } else {
                            for (index, progress_value) in entry.segment_progress.iter().enumerate() {
                                if let Some(segment) = entry.task.segments.get_mut(index) {
                                    segment.downloaded = progress_value.load(Ordering::Relaxed).min(segment.end.saturating_sub(segment.start));
                                }
                            }
                            entry.task.status = "error".into();
                            entry.task.error = Some(human_error(&error));
                            failed_message = entry.task.error.clone();
                        }
                    }
                }
            }
        }
        let _ = self.save_tasks().await;
        if completed {
            self.emit("completed", Some(id.clone()), None);
            self.emit("change", Some(id), None);
        } else if let Some(message) = failed_message {
            self.emit("failed", Some(id.clone()), Some(message));
            self.emit("change", Some(id), None);
        } else {
            self.emit("change", Some(id), None);
        }
        self.schedule();
    }

    async fn execute(&self, id: &str) -> Result<DownloadTask, String> {
        let mut task = self.get_task(id).ok_or_else(|| "任务不存在".to_string())?;
        if needs_prepare(&task) {
            task = self.prepare(task).await?;
            self.replace_task(&task);
        }
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            if let Some(entry) = entries.iter_mut().find(|entry| entry.task.id == id) {
                entry.task.status = "downloading".into();
                entry.task.started_at.get_or_insert_with(now_ms);
                entry.task.updated_at = now_ms();
                entry.task.error = None;
                entry.last_bytes = entry.progress.load(Ordering::Relaxed);
                entry.last_time = now_ms();
            }
        }
        let _ = self.save_tasks().await;
        self.emit("change", Some(id.to_string()), None);
        let (cancel, progress, active) = {
            let entries = self.inner.tasks.lock().unwrap();
            let entry = entries.iter().find(|entry| entry.task.id == id).ok_or_else(|| "任务不存在".to_string())?;
            (entry.cancel.clone().unwrap_or_else(|| Arc::new(AtomicBool::new(false))), entry.progress.clone(), entry.active.clone())
        };
        let settings = self.settings();
        let speed_limit = task.speed_limit_bps.unwrap_or(settings.global_speed_limit_bps);

        match task.protocol.as_str() {
            "hls" | "dash" => {
                active.store(1, Ordering::Relaxed);
                progress.store(0, Ordering::Relaxed);
                progress.store(
                    scan_fragment_bytes(&task).await,
                    Ordering::Relaxed,
                );
                let on_fragment: crate::engine::stream::ProgressFn = {
                    let progress = progress.clone();
                    Arc::new(move |_index, bytes| { progress.fetch_add(bytes, Ordering::Relaxed); })
                };
                let job = StreamJob {
                    url: task.url.clone(),
                    output_path: PathBuf::from(&task.temp_path),
                    fragment_dir: fragment_dir_for(&self.inner.data_dir, &task),
                    connections: task.connections,
                    speed_limit_bps: speed_limit,
                    request: task.request.clone(),
                    cancel: cancel.clone(),
                    remux_streams: settings.remux_streams,
                    existing_fragments: scan_fragments(&fragment_dir_for(&self.inner.data_dir, &task)).await,
                    on_fragment,
                };
                let output: StreamOutput = if task.protocol == "hls" { download_hls(job).await? } else { download_dash(job).await? };
                task.total_bytes = output.total_bytes;
                task.downloaded_bytes = output.total_bytes;
                task.range_supported = true;
                task.mime_type = Some(if output.output_kind == "m4a" { "audio/mp4".into() } else { "video/mp4".into() });
                task.stream = Some(StreamState {
                    kind: output.kind.clone(),
                    fragments_total: output.fragments_total,
                    fragments_done: output.fragments_total,
                    completed_fragments: (1..=output.fragments_total).collect(),
                    variant: output.variant,
                    encryption: output.encryption,
                    remuxed: Some(output.remuxed),
                    output_kind: Some(output.output_kind.clone()),
                });
                progress.store(output.total_bytes, Ordering::Relaxed);
                active.store(0, Ordering::Relaxed);
                if output.output_kind == "m4a" {
                    task.file_name = with_extension(&task.file_name, "m4a");
                    task.save_path = with_extension(&task.save_path, "m4a");
                }
            }
            "ftp" => {
                active.store(1, Ordering::Relaxed);
                let total = download_ftp(&task.url, Path::new(&task.temp_path), cancel.clone(), progress.clone(), speed_limit).await?;
                task.total_bytes = if task.total_bytes > 0 { task.total_bytes } else { total };
                task.downloaded_bytes = total;
                active.store(0, Ordering::Relaxed);
            }
            _ => {
                let mut plans = Vec::new();
                let mut progress_segments = Vec::new();
                let mut initial_total = 0u64;
                for segment in &task.segments {
                    let length = segment.end.saturating_sub(segment.start);
                    let initial = if task.range_supported && length > 0 {
                        segment.downloaded.min(length)
                    } else {
                        0
                    };
                    initial_total += initial;
                    let segment_progress = Arc::new(AtomicU64::new(initial));
                    progress_segments.push(segment_progress);
                    plans.push(HttpSegmentPlan { index: segment.index, start: segment.start, end: segment.end, initial });
                }
                {
                    let mut entries = self.inner.tasks.lock().unwrap();
                    if let Some(entry) = entries.iter_mut().find(|entry| entry.task.id == id) {
                        entry.segment_progress = progress_segments.clone();
                    }
                }
                progress.store(initial_total, Ordering::Relaxed);
                let job = HttpJob {
                    url: task.final_url.clone().unwrap_or_else(|| task.url.clone()),
                    temp_path: PathBuf::from(&task.temp_path),
                    total_bytes: task.total_bytes,
                    range_supported: task.range_supported,
                    request: task.request.clone(),
                    connections: task.connections,
                    speed_limit_bps: speed_limit,
                    cancel: cancel.clone(),
                    progress: progress_segments,
                    progress_total: progress.clone(),
                    active_connections: active.clone(),
                    segments: plans,
                };
                let total = download_http(job).await?;
                task.downloaded_bytes = total;
                task.total_bytes = if task.total_bytes > 0 { task.total_bytes } else { total };
            }
        }
        self.replace_task(&task);
        self.finalize(task).await
    }

    async fn prepare(&self, mut task: DownloadTask) -> Result<DownloadTask, String> {
        let probe_result: ProbeResult = if task.url.to_ascii_lowercase().starts_with("ftp") {
            probe_ftp(&task.url).await?
        } else {
            probe(&task.url, &task.request).await?
        };
        task.final_url = Some(probe_result.final_url.clone());
        task.total_bytes = probe_result.total_bytes;
        task.range_supported = probe_result.range_supported;
        task.mime_type = probe_result.mime_type.clone();
        task.etag = probe_result.etag.clone();
        task.last_modified = probe_result.last_modified.clone();
        let settings = self.settings();
        if task.auto_named {
            if let Some(name) = probe_result.file_name.clone() {
                let sanitized = sanitize_file_name(&name);
                if !sanitized.is_empty() { task.file_name = sanitized; }
            }
        }
        let kind = probe_result.kind.as_str();
        if kind == "hls" || kind == "dash" {
            task.protocol = kind.to_string();
            let remux = settings.remux_streams && find_ffmpeg().is_some();
            let extension = if kind == "hls" && !remux { "ts" } else { "mp4" };
            task.file_name = with_extension(&task.file_name, extension);
            task.stream = Some(StreamState { kind: kind.into(), ..Default::default() });
            task.segments.clear();
            task.live = false;
        } else {
            task.protocol = probe_result.protocol.clone();
            let total = task.total_bytes;
            let count = if task.range_supported && total > 0 {
                let by_size = ((total / MIN_SEGMENT_BYTES).max(1).min(MAX_SEGMENTS as u64)) as u32;
                by_size.min(task.connections.clamp(1, MAX_SEGMENTS))
            } else {
                1
            };
            let mut segments = Vec::new();
            if total > 0 {
                let chunk = total / count as u64;
                for index in 0..count {
                    let start = chunk * index as u64;
                    let end = if index + 1 == count { total } else { start + chunk };
                    segments.push(SegmentState { index, start, end, downloaded: 0, status: "pending".into() });
                }
            } else {
                segments.push(SegmentState { index: 0, start: 0, end: 0, downloaded: 0, status: "pending".into() });
            }
            task.segments = segments;
            if task.protocol == "ftp" { task.connections = 1; }
        }
        if task.directory.trim().is_empty() {
            task.directory = if settings.download_directory.is_empty() { default_download_dir() } else { settings.download_directory.clone() };
        }
        tokio::fs::create_dir_all(&task.directory).await.map_err(|error| format!("创建下载目录失败：{}", error))?;
        if task.save_path.is_empty() {
            let path = unique_path(&Path::new(&task.directory).join(&task.file_name));
            task.save_path = path.to_string_lossy().to_string();
            task.file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or(&task.file_name).to_string();
        }
        if task.temp_path.is_empty() {
            task.temp_path = format!("{}.mdm-part", task.save_path);
        }
        if task.fragment_dir.is_none() {
            task.fragment_dir = Some(self.inner.data_dir.join("fragments").join(&task.id).to_string_lossy().to_string());
        }
        task.resumable = true;
        task.updated_at = now_ms();
        Ok(task)
    }

    async fn finalize(&self, mut task: DownloadTask) -> Result<DownloadTask, String> {
        if let Some(mut checksum) = task.checksum.clone() {
            let actual = sha256_file(Path::new(&task.temp_path)).await?;
            if !actual.eq_ignore_ascii_case(&checksum.value) {
                checksum.verified = Some(false);
                checksum.actual = Some(actual);
                task.checksum = Some(checksum);
                return Err("SHA-256 校验失败，文件可能已损坏".into());
            }
            checksum.verified = Some(true);
            checksum.actual = Some(actual);
            task.checksum = Some(checksum);
        }
        if !Path::new(&task.temp_path).exists() {
            return Err("临时文件不存在，下载未完成".into());
        }
        if Path::new(&task.save_path).exists() && task.save_path != task.temp_path {
            let path = unique_path(Path::new(&task.save_path));
            task.save_path = path.to_string_lossy().to_string();
            task.file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or(&task.file_name).to_string();
        }
        tokio::fs::rename(&task.temp_path, &task.save_path).await.map_err(|error| format!("保存文件失败：{}", error))?;
        if let Some(directory) = &task.fragment_dir { let _ = tokio::fs::remove_dir_all(directory).await; }
        if task.total_bytes == 0 {
            task.total_bytes = tokio::fs::metadata(&task.save_path).await.map(|meta| meta.len()).unwrap_or(0);
        }
        task.downloaded_bytes = task.total_bytes;
        task.updated_at = now_ms();
        Ok(task)
    }

    pub async fn pause(&self, id: &str) -> Result<(), String> {
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            let entry = entries.iter_mut().find(|entry| entry.task.id == id).ok_or_else(|| "任务不存在".to_string())?;
            if entry.task.status == "completed" || entry.task.status == "cancelled" { return Ok(()); }
            for (index, progress_value) in entry.segment_progress.iter().enumerate() {
                if let Some(segment) = entry.task.segments.get_mut(index) {
                    segment.downloaded = progress_value.load(Ordering::Relaxed).min(segment.end.saturating_sub(segment.start));
                }
            }
            if let Some(cancel) = &entry.cancel { cancel.store(true, Ordering::Relaxed); }
            if !entry.segment_progress.is_empty() {
                let completed: u64 = entry.task.segments.iter().map(|segment| segment.downloaded).sum();
                entry.task.downloaded_bytes = completed;
                entry.progress.store(completed, Ordering::Relaxed);
            }
            entry.task.status = "paused".into();
            entry.task.speed = 0.0;
            entry.task.active_connections = 0;
            entry.task.updated_at = now_ms();
        }
        let _ = self.save_tasks().await;
        self.emit("change", Some(id.into()), None);
        Ok(())
    }

    pub async fn resume(&self, id: &str) -> Result<(), String> {
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            let entry = entries.iter_mut().find(|entry| entry.task.id == id).ok_or_else(|| "任务不存在".to_string())?;
            if entry.task.status != "paused" { return Ok(()); }
            entry.task.status = "queued".into();
            entry.task.error = None;
            entry.task.updated_at = now_ms();
        }
        let _ = self.save_tasks().await;
        self.emit("change", Some(id.into()), None);
        self.schedule();
        Ok(())
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            let entry = entries.iter_mut().find(|entry| entry.task.id == id).ok_or_else(|| "任务不存在".to_string())?;
            if let Some(cancel) = &entry.cancel { cancel.store(true, Ordering::Relaxed); }
            entry.task.status = "cancelled".into();
            entry.task.speed = 0.0;
            entry.task.active_connections = 0;
            entry.task.downloaded_bytes = 0;
            entry.progress.store(0, Ordering::Relaxed);
            entry.task.updated_at = now_ms();
            entry.task.error = None;
        }
        let _ = self.save_tasks().await;
        self.emit("change", Some(id.into()), None);
        Ok(())
    }

    pub async fn retry(&self, id: &str) -> Result<(), String> {
        let task = self.get_task(id).ok_or_else(|| "任务不存在".to_string())?;
        if !matches!(task.status.as_str(), "error" | "cancelled") { return Ok(()); }
        let _ = tokio::fs::remove_file(&task.temp_path).await;
        if let Some(directory) = &task.fragment_dir { let _ = tokio::fs::remove_dir_all(directory).await; }
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            if let Some(entry) = entries.iter_mut().find(|entry| entry.task.id == id) {
                entry.task.status = "queued".into();
                entry.task.error = None;
                entry.task.total_bytes = 0;
                entry.task.downloaded_bytes = 0;
                entry.task.speed = 0.0;
                entry.task.eta_seconds = None;
                entry.task.segments.clear();
                entry.segment_progress.clear();
                entry.task.stream = None;
                entry.task.save_path.clear();
                entry.task.temp_path.clear();
                entry.task.fragment_dir = None;
                entry.task.completed_at = None;
                entry.task.started_at = None;
                entry.task.updated_at = now_ms();
                entry.progress.store(0, Ordering::Relaxed);
            }
        }
        let _ = self.save_tasks().await;
        self.emit("change", Some(id.into()), None);
        self.schedule();
        Ok(())
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let task = self.get_task(id).ok_or_else(|| "任务不存在".to_string())?;
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            if let Some(entry) = entries.iter().find(|entry| entry.task.id == id) {
                if let Some(cancel) = &entry.cancel { cancel.store(true, Ordering::Relaxed); }
            }
            entries.retain(|entry| entry.task.id != id);
        }
        let _ = tokio::fs::remove_file(&task.temp_path).await;
        if let Some(directory) = &task.fragment_dir { let _ = tokio::fs::remove_dir_all(directory).await; }
        let _ = self.save_tasks().await;
        self.emit("change", Some(id.into()), None);
        Ok(())
    }

    pub async fn clear_completed(&self) -> Result<(), String> {
        {
            let mut entries = self.inner.tasks.lock().unwrap();
            entries.retain(|entry| entry.task.status != "completed");
        }
        let _ = self.save_tasks().await;
        self.emit("change", None, None);
        Ok(())
    }

    fn replace_task(&self, task: &DownloadTask) {
        let mut entries = self.inner.tasks.lock().unwrap();
        if let Some(entry) = entries.iter_mut().find(|entry| entry.task.id == task.id) {
            entry.task = task.clone();
        }
    }

    pub fn tick(&self) -> bool {
        let now = now_ms();
        let mut changed = false;
        let mut entries = self.inner.tasks.lock().unwrap();
        for entry in entries.iter_mut() {
            if !entry.running { continue; }
            let downloaded = entry.progress.load(Ordering::Relaxed);
            let elapsed = (now - entry.last_time).max(0) as f64 / 1000.0;
            if elapsed > 0.2 {
                let delta = downloaded.saturating_sub(entry.last_bytes) as f64;
                let sample = delta / elapsed;
                entry.task.speed = if entry.task.speed <= 0.0 { sample } else { entry.task.speed * 0.55 + sample * 0.45 };
                entry.last_bytes = downloaded;
                entry.last_time = now;
            }
            for (index, progress_value) in entry.segment_progress.iter().enumerate() {
                if let Some(segment) = entry.task.segments.get_mut(index) {
                    let value = progress_value.load(Ordering::Relaxed).min(segment.end.saturating_sub(segment.start));
                    segment.downloaded = value;
                    segment.status = if segment.end.saturating_sub(segment.start) > 0 && value >= segment.end.saturating_sub(segment.start) { "done".into() } else if value > 0 { "downloading".into() } else { "pending".into() };
                }
            }
            entry.task.downloaded_bytes = downloaded;
            entry.task.active_connections = entry.active.load(Ordering::Relaxed);
            entry.task.updated_at = now;
            if entry.task.total_bytes > 0 && entry.task.speed > 0.0 {
                entry.task.eta_seconds = Some((entry.task.total_bytes.saturating_sub(downloaded)) as f64 / entry.task.speed);
            }
            changed = true;
        }
        changed
    }

    pub async fn persist(&self) {
        let _ = self.save_tasks().await;
    }

    async fn save_tasks(&self) -> Result<(), String> {
        let tasks: Vec<DownloadTask> = self.inner.tasks.lock().unwrap().iter().map(|entry| entry.task.clone()).collect();
        write_json(&self.inner.data_dir.join("tasks.json"), &tasks).await
    }

    async fn save_settings(&self) -> Result<(), String> {
        let settings = self.settings();
        write_json(&self.inner.data_dir.join("settings.json"), &settings).await
    }
}

fn needs_prepare(task: &DownloadTask) -> bool {
    if task.save_path.is_empty() || task.temp_path.is_empty() { return true; }
    match task.protocol.as_str() {
        "hls" | "dash" => task.stream.is_none(),
        _ => task.segments.is_empty(),
    }
}

fn normalize_settings(settings: &mut Settings) {
    settings.max_concurrent_downloads = settings.max_concurrent_downloads.clamp(1, 16);
    settings.default_connections = settings.default_connections.clamp(1, MAX_SEGMENTS);
    if !(1024..=65535).contains(&settings.port) { settings.port = 45721; }
    if settings.download_directory.trim().is_empty() { settings.download_directory = default_download_dir(); }
    if !matches!(settings.theme.as_str(), "dark" | "light" | "system") { settings.theme = "dark".into(); }
}

fn default_download_dir() -> String {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let path = PathBuf::from(profile).join("Downloads");
        return path.to_string_lossy().to_string();
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("Downloads").to_string_lossy().to_string()
}

fn parse_checksum(value: &str) -> Result<ChecksumSpec, String> {
    let raw = value.trim();
    let digest = raw.strip_prefix("sha256:").unwrap_or(raw).trim();
    if digest.len() != 64 || !digest.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("SHA-256 校验值格式不正确".into());
    }
    Ok(ChecksumSpec { algorithm: "sha256".into(), value: digest.to_ascii_lowercase(), verified: None, actual: None })
}

fn with_extension(name: &str, extension: &str) -> String {
    let (stem, _) = split_name(name);
    format!("{}.{}", stem, extension)
}

fn fragment_dir_for(data_dir: &Path, task: &DownloadTask) -> PathBuf {
    task.fragment_dir.as_ref().map(PathBuf::from).unwrap_or_else(|| data_dir.join("fragments").join(&task.id))
}

async fn scan_fragments(directory: &Path) -> Vec<u32> {
    let mut result = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else { return result; };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(stem) = name.strip_suffix(".frag") {
            if let Ok(index) = stem.parse::<u32>() { result.push(index); }
        }
    }
    result.sort_unstable();
    result
}

async fn scan_fragment_bytes(task: &DownloadTask) -> u64 {
    let Some(directory) = &task.fragment_dir else { return 0; };
    let mut total = 0u64;
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else { return 0; };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.path().extension().and_then(|value| value.to_str()) == Some("frag") {
            total += entry.metadata().await.map(|meta| meta.len()).unwrap_or(0);
        }
    }
    total
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path).await.map_err(|error| format!("读取文件失败：{}", error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).await.map_err(|error| format!("读取文件失败：{}", error))?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() { tokio::fs::create_dir_all(parent).await.map_err(|error| error.to_string())?; }
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    tokio::fs::write(&temp, bytes).await.map_err(|error| format!("写入状态失败：{}", error))?;
    if path.exists() { let _ = tokio::fs::remove_file(path).await; }
    tokio::fs::rename(&temp, path).await.map_err(|error| format!("保存状态失败：{}", error))?;
    Ok(())
}
