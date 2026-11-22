use crate::engine::{build_client, check_cancel, request_headers, throttle};
use crate::model::RequestOptions;
use futures_util::StreamExt;
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

#[derive(Clone, Debug)]
pub struct HttpSegmentPlan {
    pub index: u32,
    pub start: u64,
    pub end: u64,
    pub initial: u64,
}

pub struct HttpJob {
    pub url: String,
    pub temp_path: PathBuf,
    pub total_bytes: u64,
    pub range_supported: bool,
    pub request: Option<RequestOptions>,
    pub connections: u32,
    pub speed_limit_bps: u64,
    pub cancel: Arc<AtomicBool>,
    pub progress: Vec<Arc<AtomicU64>>,
    pub progress_total: Arc<AtomicU64>,
    pub active_connections: Arc<AtomicU32>,
    pub segments: Vec<HttpSegmentPlan>,
}

pub async fn download_http(job: HttpJob) -> Result<u64, String> {
    if let Some(parent) = job.temp_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| format!("创建目录失败：{}", error))?;
    }
    {
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&job.temp_path)
            .await
            .map_err(|error| format!("创建临时文件失败：{}", error))?;
        if job.total_bytes > 0 {
            file.set_len(job.total_bytes).await.map_err(|error| format!("预分配文件失败：{}", error))?;
        }
    }

    if !job.range_supported || job.segments.len() <= 1 {
        return download_single(job).await;
    }

    let client = build_client();
    let request = Arc::new(job.request.clone());
    let url = Arc::new(job.url.clone());
    let temp_path = Arc::new(job.temp_path.clone());
    let cancel = job.cancel.clone();
    let active = job.active_connections.clone();
    let total = job.total_bytes;
    let speed = job.speed_limit_bps;
    let connections = job.connections.max(1).min(64);
    let progress = Arc::new(job.progress.clone());
    let progress_total = job.progress_total.clone();
    let fatal = Arc::new(AtomicBool::new(false));
    let mut join = tokio::task::JoinSet::new();

    for segment in job.segments.clone() {
        let client = client.clone();
        let request = request.clone();
        let url = url.clone();
        let temp_path = temp_path.clone();
        let cancel = cancel.clone();
        let active = active.clone();
        let progress = progress.clone();
        let progress_total = progress_total.clone();
        let fatal = fatal.clone();
        join.spawn(async move {
            if segment.end <= segment.start || segment.initial >= segment.end - segment.start {
                return Ok::<(), String>(());
            }
            active.fetch_add(1, Ordering::Relaxed);
            let result = download_segment(
                &client,
                &url,
                &temp_path,
                segment.start,
                segment.end,
                segment.initial,
                &request,
                &cancel,
                &fatal,
                &progress[segment.index as usize],
                &progress_total,
                speed / connections as u64,
            )
            .await;
            active.fetch_sub(1, Ordering::Relaxed);
            result
        });
    }

    let mut first_error: Option<String> = None;
    while let Some(joined) = join.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                if error != "CANCELLED" && first_error.is_none() {
                    first_error = Some(error);
                }
                fatal.store(true, Ordering::Relaxed);
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(format!("下载线程异常：{}", error));
                }
            }
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    let done: u64 = progress.iter().map(|progress| progress.load(Ordering::Relaxed)).sum();
    if total > 0 {
        let size = tokio::fs::metadata(&*temp_path).await.map(|meta| meta.len()).unwrap_or(0);
        if size < total {
            return Err("下载文件不完整，请重试".into());
        }
    }
    Ok(done)
}

async fn download_single(job: HttpJob) -> Result<u64, String> {
    let client = build_client();
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&job.temp_path)
        .await
        .map_err(|error| format!("打开临时文件失败：{}", error))?;
    let response = client
        .get(&job.url)
        .headers(request_headers(&job.request))
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| format!("请求失败：{}", error))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    job.active_connections.store(1, Ordering::Relaxed);
    let mut downloaded = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        check_cancel(&job.cancel)?;
        let chunk = chunk.map_err(|error| format!("读取响应失败：{}", error))?;
        file.write_all(&chunk).await.map_err(|error| format!("写入文件失败：{}", error))?;
        downloaded += chunk.len() as u64;
        job.progress_total.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        if let Some(progress) = job.progress.first() {
            progress.store(downloaded, Ordering::Relaxed);
        }
        throttle(chunk.len() as u64, job.speed_limit_bps).await;
    }
    file.flush().await.ok();
    job.active_connections.store(0, Ordering::Relaxed);
    Ok(downloaded)
}

#[allow(clippy::too_many_arguments)]
async fn download_segment(
    client: &reqwest::Client,
    url: &str,
    temp_path: &PathBuf,
    start: u64,
    end: u64,
    initial: u64,
    request: &Option<RequestOptions>,
    cancel: &AtomicBool,
    fatal: &AtomicBool,
    progress: &AtomicU64,
    progress_total: &AtomicU64,
    speed_limit_bps: u64,
) -> Result<(), String> {
    let length = end.saturating_sub(start);
    let mut done = initial.min(length);
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(temp_path)
        .await
        .map_err(|error| format!("打开临时文件失败：{}", error))?;
    file.seek(SeekFrom::Start(start + done)).await.map_err(|error| error.to_string())?;

    let mut attempt = 0u32;
    while done < length {
        check_cancel(cancel)?;
        if fatal.load(Ordering::Relaxed) {
            return Err("并发下载已中止".into());
        }
        let from = start + done;
        let to = end - 1;
        let result = async {
            let response = client
                .get(url)
                .headers(request_headers(request))
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .header(reqwest::header::RANGE, format!("bytes={}-{}", from, to))
                .send()
                .await
                .map_err(|error| format!("请求失败：{}", error))?;
            let status = response.status();
            if status.as_u16() == 416 {
                return Ok(());
            }
            if status.as_u16() != 206 {
                return Err(format!("服务器未返回分段响应（HTTP {}）", status.as_u16()));
            }
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                check_cancel(cancel)?;
                if fatal.load(Ordering::Relaxed) {
                    return Err("并发下载已中止".into());
                }
                let chunk = chunk.map_err(|error| format!("读取响应失败：{}", error))?;
                if done + chunk.len() as u64 > length {
                    let allowed = (length - done) as usize;
                    file.write_all(&chunk[..allowed]).await.map_err(|error| format!("写入文件失败：{}", error))?;
                    done = length;
                    progress.store(done, Ordering::Relaxed);
                    progress_total.fetch_add(allowed as u64, Ordering::Relaxed);
                    break;
                }
                file.write_all(&chunk).await.map_err(|error| format!("写入文件失败：{}", error))?;
                done += chunk.len() as u64;
                progress.store(done, Ordering::Relaxed);
                progress_total.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                throttle(chunk.len() as u64, speed_limit_bps).await;
            }
            Ok::<(), String>(())
        }
        .await;

        match result {
            Ok(()) if done >= length => break,
            Ok(()) => {
                attempt += 1;
                if attempt > 4 {
                    return Err("连接提前中断，重试次数已用尽".into());
                }
                tokio::time::sleep(Duration::from_millis(350 * attempt as u64)).await;
            }
            Err(error) => {
                if error == "CANCELLED" {
                    return Err(error);
                }
                attempt += 1;
                if attempt > 4 {
                    return Err(error);
                }
                tokio::time::sleep(Duration::from_millis(350 * attempt as u64)).await;
            }
        }
    }
    file.flush().await.ok();
    Ok(())
}
