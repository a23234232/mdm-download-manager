use crate::engine::dash::{parse_dash_manifest, DashTrack};
use crate::engine::fragments::{download_fragments, FragmentSpec};
use crate::engine::stream::{StreamJob, StreamOutput};
use crate::engine::{build_client, fetch_bytes, fetch_text, find_ffmpeg, run_ffmpeg};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub async fn download_dash(job: StreamJob) -> Result<StreamOutput, String> {
    let client = build_client();
    let (text, final_url) = fetch_text(&client, &job.url, &job.request, &job.cancel).await?;
    let plan = parse_dash_manifest(&text, &final_url)?;
    if plan.drm_protected {
        return Err("该 DASH 流受 DRM 保护，暂不支持下载".into());
    }
    if plan.video.is_some() && plan.audio.is_some() && find_ffmpeg().is_none() {
        return Err("该 DASH 流包含分离的音视频轨道，需要 ffmpeg 才能合并".into());
    }
    tokio::fs::create_dir_all(&job.fragment_dir).await.map_err(|error| format!("创建分片目录失败：{}", error))?;

    let mut total = 0u64;
    let mut fragments_total = 0u32;
    let mut video_path: Option<PathBuf> = None;
    let mut audio_path: Option<PathBuf> = None;
    if let Some(track) = &plan.video {
        let (path, bytes, count) = download_track(&client, track, "video", &job).await?;
        total += bytes;
        fragments_total += count;
        video_path = Some(path);
    }
    if let Some(track) = &plan.audio {
        let (path, bytes, count) = download_track(&client, track, "audio", &job).await?;
        total += bytes;
        fragments_total += count;
        audio_path = Some(path);
    }

    if let Some(parent) = job.output_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| format!("创建输出目录失败：{}", error))?;
    }
    let output = job.output_path.to_string_lossy().to_string();
    let remux = job.remux_streams && find_ffmpeg().is_some();
    let output_kind = match (&video_path, &audio_path) {
        (Some(video), Some(audio)) => {
            run_ffmpeg(&[
                "-y".into(),
                "-i".into(),
                video.to_string_lossy().to_string(),
                "-i".into(),
                audio.to_string_lossy().to_string(),
                "-c".into(),
                "copy".into(),
                output,
            ])
            .await?;
            "mp4".to_string()
        }
        (Some(video), None) => {
            if remux {
                run_ffmpeg(&["-y".into(), "-i".into(), video.to_string_lossy().to_string(), "-c".into(), "copy".into(), output]).await?;
            } else {
                tokio::fs::copy(video, &job.output_path).await.map_err(|error| format!("保存视频失败：{}", error))?;
            }
            "mp4".to_string()
        }
        (None, Some(audio)) => {
            tokio::fs::copy(audio, &job.output_path).await.map_err(|error| format!("保存音频失败：{}", error))?;
            "m4a".to_string()
        }
        (None, None) => return Err("DASH 清单中没有可下载的轨道".into()),
    };

    Ok(StreamOutput {
        total_bytes: total,
        fragments_total,
        encryption: None,
        variant: None,
        remuxed: remux,
        output_kind,
        kind: "dash".into(),
    })
}

async fn download_track(
    client: &reqwest::Client,
    track: &DashTrack,
    name: &str,
    job: &StreamJob,
) -> Result<(PathBuf, u64, u32), String> {
    let directory = job.fragment_dir.join(name);
    tokio::fs::create_dir_all(&directory).await.map_err(|error| format!("创建轨道目录失败：{}", error))?;
    let mut total = 0u64;
    let mut init_path: Option<PathBuf> = None;
    if let Some(url) = &track.init_url {
        let path = directory.join("00000.init");
        if path.exists() {
            total += path.metadata().map(|meta| meta.len()).unwrap_or(0);
        } else {
            let (bytes, _) = fetch_bytes(client, url, None, &job.request, &job.cancel).await?;
            tokio::fs::write(&path, &bytes).await.map_err(|error| format!("写入 DASH 初始化片段失败：{}", error))?;
            total += bytes.len() as u64;
        }
        init_path = Some(path);
    }
    let specs: Vec<FragmentSpec> = track
        .fragments
        .iter()
        .map(|fragment| FragmentSpec {
            index: fragment.index,
            sequence: fragment.index as u64,
            url: fragment.url.clone(),
            range: fragment.range,
            key: None,
        })
        .collect();
    total += download_fragments(
        &directory,
        &specs,
        &[],
        job.connections,
        job.speed_limit_bps,
        &job.request,
        job.cancel.clone(),
        job.on_fragment.clone(),
    )
    .await?;

    let mut inputs: Vec<PathBuf> = Vec::new();
    if let Some(path) = init_path {
        inputs.push(path);
    }
    for fragment in &track.fragments {
        let path = crate::engine::fragments::fragment_file(&directory, fragment.index);
        if !path.exists() {
            return Err(format!("DASH 分片 {} 缺失，请重试", fragment.index));
        }
        inputs.push(path);
    }
    let merged = job.fragment_dir.join(format!("{}.mp4", name));
    concat_files(&inputs, &merged).await?;
    Ok((merged, total, track.fragments.len() as u32))
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
