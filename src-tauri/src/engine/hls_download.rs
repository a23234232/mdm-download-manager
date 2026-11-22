use crate::engine::fragments::{download_fragments, FragmentKey, FragmentSpec};
use crate::engine::hls::{best_variant, parse_playlist, HlsPlaylist};
use crate::engine::stream::{StreamJob, StreamOutput};
use crate::engine::{build_client, fetch_bytes, fetch_text, find_ffmpeg, run_ffmpeg};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub async fn download_hls(job: StreamJob) -> Result<StreamOutput, String> {
    let client = build_client();
    let (text, mut base_url) = fetch_text(&client, &job.url, &job.request, &job.cancel).await?;
    let mut playlist = parse_playlist(&text, &base_url)?;
    let mut variant: Option<String> = None;
    if let HlsPlaylist::Master(variants) = &playlist {
        let selected = best_variant(variants).ok_or_else(|| "HLS 主播放列表为空".to_string())?;
        let variant_url = selected.url.clone();
        let (variant_text, final_url) = fetch_text(&client, &variant_url, &job.request, &job.cancel).await?;
        base_url = final_url;
        variant = Some(variant_url);
        playlist = parse_playlist(&variant_text, &base_url)?;
    }
    let HlsPlaylist::Media(media) = playlist else {
        return Err("HLS 播放列表解析失败".into());
    };
    if media.fragments.is_empty() {
        return Err("HLS 播放列表不包含分片".into());
    }
    if !media.end_list {
        return Err("直播流暂不支持下载，请等待直播结束后重试".into());
    }

    tokio::fs::create_dir_all(&job.fragment_dir).await.map_err(|error| format!("创建分片目录失败：{}", error))?;
    let mut total = 0u64;
    let mut has_init = false;
    if let Some(init) = &media.init {
        let path = job.fragment_dir.join("00000.init");
        if path.exists() {
            total += path.metadata().map(|meta| meta.len()).unwrap_or(0);
        } else {
            let (bytes, _) = fetch_bytes(&client, &init.url, init.range, &job.request, &job.cancel).await?;
            tokio::fs::write(&path, &bytes).await.map_err(|error| format!("写入初始化片段失败：{}", error))?;
            total += bytes.len() as u64;
        }
        has_init = true;
    }

    let mut key_cache: HashMap<String, Vec<u8>> = HashMap::new();
    let mut specs: Vec<FragmentSpec> = Vec::with_capacity(media.fragments.len());
    let mut encrypted = false;
    for fragment in &media.fragments {
        let key = if let Some(parsed) = &fragment.key {
            let bytes = if let Some(cached) = key_cache.get(&parsed.uri) {
                cached.clone()
            } else {
                let (bytes, _) = fetch_bytes(&client, &parsed.uri, None, &job.request, &job.cancel).await?;
                key_cache.insert(parsed.uri.clone(), bytes.clone());
                bytes
            };
            encrypted = true;
            Some(FragmentKey { key: bytes, iv: parsed.iv.clone() })
        } else {
            None
        };
        specs.push(FragmentSpec {
            index: fragment.index,
            sequence: fragment.sequence,
            url: fragment.url.clone(),
            range: fragment.range,
            key,
        });
    }

    let downloaded = download_fragments(
        &job.fragment_dir,
        &specs,
        &job.existing_fragments,
        job.connections,
        job.speed_limit_bps,
        &job.request,
        job.cancel.clone(),
        job.on_fragment.clone(),
    )
    .await?;
    total += downloaded;

    let mut inputs: Vec<PathBuf> = Vec::new();
    if has_init {
        inputs.push(job.fragment_dir.join("00000.init"));
    }
    for spec in &specs {
        let path = crate::engine::fragments::fragment_file(&job.fragment_dir, spec.index);
        if !path.exists() {
            return Err(format!("分片 {} 缺失，请重试", spec.index));
        }
        inputs.push(path);
    }
    let merged = job.fragment_dir.join(if has_init { "merged.mp4" } else { "merged.ts" });
    concat_files(&inputs, &merged).await?;

    if let Some(parent) = job.output_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| format!("创建输出目录失败：{}", error))?;
    }
    let remux = job.remux_streams && find_ffmpeg().is_some();
    let output_kind = if remux {
        let merged_string = merged.to_string_lossy().to_string();
        let output = job.output_path.to_string_lossy().to_string();
        run_ffmpeg(&["-y".into(), "-i".into(), merged_string, "-c".into(), "copy".into(), output]).await?;
        "mp4".to_string()
    } else if has_init {
        tokio::fs::copy(&merged, &job.output_path).await.map_err(|error| format!("保存流媒体失败：{}", error))?;
        "mp4".to_string()
    } else {
        tokio::fs::copy(&merged, &job.output_path).await.map_err(|error| format!("保存流媒体失败：{}", error))?;
        "ts".to_string()
    };
    let _ = tokio::fs::remove_file(&merged).await;

    Ok(StreamOutput {
        total_bytes: total,
        fragments_total: specs.len() as u32,
        encryption: if encrypted { Some("AES-128".into()) } else { None },
        variant,
        remuxed: remux,
        output_kind,
        kind: "hls".into(),
    })
}

async fn concat_files(inputs: &[PathBuf], output: &Path) -> Result<(), String> {
    let mut writer = tokio::fs::File::create(output).await.map_err(|error| format!("创建合并文件失败：{}", error))?;
    for input in inputs {
        let mut reader = tokio::fs::File::open(input).await.map_err(|error| format!("读取分片失败：{}", error))?;
        tokio::io::copy(&mut reader, &mut writer).await.map_err(|error| format!("合并分片失败：{}", error))?;
    }
    writer.flush().await.ok();
    Ok(())
}
