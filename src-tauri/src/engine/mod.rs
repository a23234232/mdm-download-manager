pub mod dash;
pub mod dash_download;
pub mod fragments;
pub mod ftp;
pub mod hls;
pub mod hls_download;
pub mod http;
pub mod probe;
pub mod stream;

use crate::model::RequestOptions;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

pub type EngineResult<T> = Result<T, String>;

pub fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

pub fn check_cancel(cancel: &AtomicBool) -> EngineResult<()> {
    if is_cancelled(cancel) {
        Err("CANCELLED".into())
    } else {
        Ok(())
    }
}

pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(25))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default()
}

pub fn request_headers(request: &Option<RequestOptions>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(options) = request {
        if let Some(referrer) = options.referrer.as_deref() {
            if let Ok(value) = HeaderValue::from_str(referrer) {
                headers.insert(reqwest::header::REFERER, value);
            }
        }
        if let Some(cookies) = options.cookies.as_deref() {
            if let Ok(value) = HeaderValue::from_str(cookies) {
                headers.insert(reqwest::header::COOKIE, value);
            }
        }
        if let Some(user_agent) = options.user_agent.as_deref() {
            if let Ok(value) = HeaderValue::from_str(user_agent) {
                headers.insert(reqwest::header::USER_AGENT, value);
            }
        }
        if let Some(custom) = options.headers.as_ref() {
            for (name, value) in custom {
                let lower = name.to_ascii_lowercase();
                if matches!(lower.as_str(), "host" | "connection" | "content-length" | "range" | "transfer-encoding" | "accept-encoding") {
                    continue;
                }
                if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(value)) {
                    headers.insert(name, value);
                }
            }
        }
    }
    headers
}

pub async fn fetch_bytes(
    client: &reqwest::Client,
    url: &str,
    range: Option<(u64, u64)>,
    request: &Option<RequestOptions>,
    cancel: &AtomicBool,
) -> EngineResult<(Vec<u8>, String)> {
    check_cancel(cancel)?;
    let mut builder = client.get(url).headers(request_headers(request));
    if let Some((start, end)) = range {
        builder = builder.header(reqwest::header::RANGE, format!("bytes={}-{}", start, end));
    }
    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let final_url = response.url().to_string();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    check_cancel(cancel)?;
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    Ok((bytes.to_vec(), final_url))
}

pub async fn fetch_text(
    client: &reqwest::Client,
    url: &str,
    request: &Option<RequestOptions>,
    cancel: &AtomicBool,
) -> EngineResult<(String, String)> {
    let (bytes, final_url) = fetch_bytes(client, url, None, request, cancel).await?;
    Ok((String::from_utf8_lossy(&bytes).to_string(), final_url))
}

pub fn resolve_url(base: &str, reference: &str) -> String {
    match url::Url::parse(base).and_then(|base| base.join(reference)) {
        Ok(url) => url.to_string(),
        Err(_) => reference.to_string(),
    }
}

pub fn find_ffmpeg() -> Option<PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            if let Ok(path) = std::env::var("MDM_FFMPEG") {
                if !path.trim().is_empty() {
                    let path = PathBuf::from(path);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
            if std::process::Command::new("ffmpeg").arg("-version").output().map(|out| out.status.success()).unwrap_or(false) {
                return Some(PathBuf::from("ffmpeg"));
            }
            None
        })
        .clone()
}

pub async fn run_ffmpeg(args: &[String]) -> EngineResult<()> {
    let Some(ffmpeg) = find_ffmpeg() else {
        return Err("未找到 ffmpeg，无法合并或转封装音视频".into());
    };
    let mut command = tokio::process::Command::new(ffmpeg);
    command.args(args);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let output = tokio::time::timeout(Duration::from_secs(1800), command.output())
        .await
        .map_err(|_| "ffmpeg 处理超时".to_string())?
        .map_err(|error| format!("ffmpeg 启动失败：{}", error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg 处理失败：{}", stderr.chars().take(280).collect::<String>()));
    }
    Ok(())
}

pub async fn throttle(bytes: u64, speed_limit_bps: u64) {
    if speed_limit_bps > 0 && bytes > 0 {
        let seconds = bytes as f64 / speed_limit_bps as f64;
        if seconds > 0.0 && seconds < 10.0 {
            tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
        }
    }
}

pub fn extension_from_content_type(content_type: &str) -> Option<&'static str> {
    let lower = content_type.to_ascii_lowercase();
    if lower.contains("mpegurl") { Some("m3u8") }
    else if lower.contains("dash+xml") { Some("mpd") }
    else if lower.contains("video/mp4") { Some("mp4") }
    else if lower.contains("video/webm") { Some("webm") }
    else if lower.contains("audio/mpeg") { Some("mp3") }
    else if lower.contains("application/pdf") { Some("pdf") }
    else if lower.contains("application/zip") { Some("zip") }
    else { None }
}
