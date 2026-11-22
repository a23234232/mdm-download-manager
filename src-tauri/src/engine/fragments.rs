use crate::engine::{check_cancel, fetch_bytes, throttle};
use crate::model::RequestOptions;
use aes::Aes128;
use cbc::Decryptor;
use cipher::block_padding::Pkcs7;
use cipher::{BlockDecryptMut, KeyIvInit};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

type Aes128CbcDec = Decryptor<Aes128>;

#[derive(Clone, Debug)]
pub struct FragmentKey {
    pub key: Vec<u8>,
    pub iv: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct FragmentSpec {
    pub index: u32,
    pub sequence: u64,
    pub url: String,
    pub range: Option<(u64, u64)>,
    pub key: Option<FragmentKey>,
}

pub fn fragment_file(directory: &Path, index: u32) -> PathBuf {
    directory.join(format!("{:05}.frag", index))
}

pub fn default_iv(sequence: u64) -> Vec<u8> {
    let mut iv = vec![0u8; 16];
    iv[8..16].copy_from_slice(&sequence.to_be_bytes());
    iv
}

pub fn decrypt_aes128(data: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, String> {
    if key.len() != 16 {
        return Err("AES-128 密钥长度无效".into());
    }
    let mut iv_bytes = [0u8; 16];
    let copy = iv.len().min(16);
    iv_bytes[16 - copy..].copy_from_slice(&iv[..copy]);
    let mut buffer = data.to_vec();
    let decryptor = Aes128CbcDec::new_from_slices(key, &iv_bytes).map_err(|error| format!("初始化解密失败：{}", error))?;
    let plain = decryptor
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|_| "解密 HLS 分片失败".to_string())?;
    Ok(plain.to_vec())
}

pub async fn download_fragments(
    directory: &Path,
    specs: &[FragmentSpec],
    existing: &[u32],
    connections: u32,
    speed_limit_bps: u64,
    request: &Option<RequestOptions>,
    cancel: Arc<AtomicBool>,
    on_fragment: Arc<dyn Fn(u32, u64) + Send + Sync>,
) -> Result<u64, String> {
    tokio::fs::create_dir_all(directory).await.map_err(|error| format!("创建分片目录失败：{}", error))?;
    let existing_set: HashSet<u32> = existing.iter().copied().collect();
    let semaphore = Arc::new(Semaphore::new(connections.clamp(1, 8) as usize));
    let mut join = tokio::task::JoinSet::new();
    let mut skipped = 0u64;
    for spec in specs.iter().cloned() {
        let path = fragment_file(directory, spec.index);
        if existing_set.contains(&spec.index) && path.exists() {
            skipped += path.metadata().map(|meta| meta.len()).unwrap_or(0);
            continue;
        }
        let semaphore = semaphore.clone();
        let request = request.clone();
        let cancel = cancel.clone();
        let on_fragment = on_fragment.clone();
        let directory = directory.to_path_buf();
        join.spawn(async move {
            let _permit = semaphore.acquire_owned().await.map_err(|_| "并发控制失败".to_string())?;
            download_one(&directory, &spec, &request, &cancel, speed_limit_bps, &on_fragment).await
        });
    }

    let mut total = skipped;
    let mut first_error: Option<String> = None;
    while let Some(joined) = join.join_next().await {
        match joined {
            Ok(Ok(size)) => total += size,
            Ok(Err(error)) => {
                if first_error.is_none() && error != "CANCELLED" {
                    first_error = Some(error);
                }
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(format!("分片线程异常：{}", error));
                }
            }
        }
    }
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(total)
}

async fn download_one(
    directory: &Path,
    spec: &FragmentSpec,
    request: &Option<RequestOptions>,
    cancel: &Arc<AtomicBool>,
    speed_limit_bps: u64,
    on_fragment: &Arc<dyn Fn(u32, u64) + Send + Sync>,
) -> Result<u64, String> {
    let client = crate::engine::build_client();
    let target = fragment_file(directory, spec.index);
    let part = target.with_extension("part");
    let mut last_error = String::from("分片下载失败");
    for attempt in 0..4u32 {
        check_cancel(cancel)?;
        match fetch_bytes(&client, &spec.url, spec.range, request, cancel).await {
            Ok((body, _)) => {
                let data = if let Some(key) = &spec.key {
                    let iv = key.iv.clone().unwrap_or_else(|| default_iv(spec.sequence));
                    decrypt_aes128(&body, &key.key, &iv)?
                } else {
                    body
                };
                tokio::fs::write(&part, &data).await.map_err(|error| format!("写入分片失败：{}", error))?;
                tokio::fs::rename(&part, &target).await.map_err(|error| format!("保存分片失败：{}", error))?;
                let size = data.len() as u64;
                on_fragment(spec.index, size);
                throttle(size, speed_limit_bps).await;
                return Ok(size);
            }
            Err(error) => {
                if error == "CANCELLED" {
                    return Err(error);
                }
                last_error = error;
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last_error)
}
