use crate::engine::{ftp, request_headers};
use crate::model::RequestOptions;
use crate::util::{filename_from_url, parse_content_disposition, parse_content_range};

#[derive(Clone, Debug)]
pub struct ProbeResult {
    pub final_url: String,
    pub protocol: String,
    pub kind: String,
    pub file_name: Option<String>,
    pub total_bytes: u64,
    pub range_supported: bool,
    pub mime_type: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub status: u16,
}

pub async fn probe(url: &str, request: &Option<RequestOptions>) -> Result<ProbeResult, String> {
    let parsed = url::Url::parse(url).map_err(|error| format!("下载地址无效：{}", error))?;
    match parsed.scheme() {
        "ftp" | "ftps" => ftp::probe_ftp(url).await,
        "http" | "https" => probe_http(url, request).await,
        other => Err(format!("不支持的协议：{}", other)),
    }
}

async fn probe_http(url: &str, request: &Option<RequestOptions>) -> Result<ProbeResult, String> {
    let client = crate::engine::build_client();
    let builder = client
        .get(url)
        .headers(request_headers(request))
        .header(reqwest::header::RANGE, "bytes=0-0")
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    let response = builder.send().await.map_err(|error| format!("探测失败：{}", error))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let headers = response.headers().clone();
    let mime_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string());
    let disposition = headers
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_disposition);
    let etag = headers.get(reqwest::header::ETAG).and_then(|value| value.to_str().ok()).map(|s| s.to_string());
    let last_modified = headers.get(reqwest::header::LAST_MODIFIED).and_then(|value| value.to_str().ok()).map(|s| s.to_string());

    let content_range = headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range);
    let content_length = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    let range_supported = status.as_u16() == 206 && content_range.is_some();
    let total_bytes = content_range.map(|(_, _, total)| total).or(content_length).unwrap_or(0);

    drop(response);

    let lower_url = final_url.to_ascii_lowercase();
    let mime_lower = mime_type.clone().unwrap_or_default().to_ascii_lowercase();
    let kind = if lower_url.contains(".m3u8") || mime_lower.contains("mpegurl") {
        "hls"
    } else if lower_url.contains(".mpd") || mime_lower.contains("dash+xml") {
        "dash"
    } else {
        "file"
    };

    let mut file_name = disposition.or_else(|| filename_from_url(&final_url)).or_else(|| filename_from_url(url));
    if let Some(name) = file_name.as_mut() {
        if kind != "file" {
            let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
            *name = format!("{}.mp4", stem);
        }
    }

    Ok(ProbeResult {
        final_url,
        protocol: if kind == "file" { "http".into() } else { kind.into() },
        kind: kind.into(),
        file_name,
        total_bytes,
        range_supported,
        mime_type,
        etag,
        last_modified,
        status: status.as_u16(),
    })
}
