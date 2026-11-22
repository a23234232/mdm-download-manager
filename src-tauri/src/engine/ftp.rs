use crate::engine::probe::ProbeResult;
use crate::engine::{check_cancel, throttle};
use crate::util::filename_from_url;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

#[derive(Clone, Debug)]
pub struct FtpTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub path: String,
    pub secure: bool,
}

pub fn parse_ftp_target(raw: &str) -> Result<FtpTarget, String> {
    let url = url::Url::parse(raw).map_err(|error| format!("FTP 地址无效：{}", error))?;
    let secure = url.scheme() == "ftps";
    let host = url.host_str().ok_or("FTP 地址缺少主机名")?.to_string();
    let port = url.port().unwrap_or(if secure { 990 } else { 21 });
    let user = if url.username().is_empty() { "anonymous".to_string() } else { percent_encoding::percent_decode_str(url.username()).decode_utf8_lossy().to_string() };
    let password = url.password().map(|value| percent_encoding::percent_decode_str(value).decode_utf8_lossy().to_string()).unwrap_or_else(|| "anonymous@".to_string());
    let path = percent_encoding::percent_decode_str(url.path()).decode_utf8_lossy().to_string();
    if path.trim().is_empty() || path.trim() == "/" {
        return Err("FTP 地址缺少文件路径".into());
    }
    Ok(FtpTarget { host, port, user, password, path, secure })
}

fn parse_epsv(text: &str) -> Option<u16> {
    let start = text.find("(|||")? + 4;
    let end = text[start..].find('|')? + start;
    text[start..end].parse().ok()
}

fn parse_pasv(text: &str) -> Option<u16> {
    let start = text.find('(')? + 1;
    let end = text[start..].find(')')? + start;
    let parts: Vec<u16> = text[start..end].split(',').filter_map(|part| part.trim().parse().ok()).collect();
    if parts.len() == 6 {
        Some(parts[4] * 256 + parts[5])
    } else {
        None
    }
}

struct FtpControl {
    reader: BufReader<TcpStream>,
    host: String,
}

impl FtpControl {
    async fn connect(host: &str, port: u16) -> Result<Self, String> {
        let stream = tokio::time::timeout(Duration::from_secs(25), TcpStream::connect((host, port)))
            .await
            .map_err(|_| "FTP 连接超时".to_string())?
            .map_err(|error| format!("FTP 连接失败：{}", error))?;
        let mut control = Self { reader: BufReader::new(stream), host: host.to_string() };
        let (code, _) = control.read_response().await?;
        if code / 100 != 2 {
            return Err(format!("FTP 服务未就绪（{}）", code));
        }
        Ok(control)
    }

    async fn read_response(&mut self) -> Result<(u16, String), String> {
        let mut text = String::new();
        let mut code = 0u16;
        loop {
            let mut line = String::new();
            let read = tokio::time::timeout(Duration::from_secs(30), self.reader.read_line(&mut line))
                .await
                .map_err(|_| "FTP 响应超时".to_string())?
                .map_err(|error| format!("FTP 读取失败：{}", error))?;
            if read == 0 {
                return Err("FTP 服务器关闭了连接".into());
            }
            text.push_str(&line);
            if line.len() >= 4 {
                if let Ok(value) = line[0..3].parse::<u16>() {
                    code = value;
                    if line.as_bytes().get(3) == Some(&b' ') {
                        break;
                    }
                }
            }
        }
        Ok((code, text))
    }

    async fn command(&mut self, command: &str) -> Result<(u16, String), String> {
        let mut line = command.to_string();
        if !line.ends_with("\r\n") {
            line.push_str("\r\n");
        }
        self.reader.get_mut().write_all(line.as_bytes()).await.map_err(|error| format!("FTP 发送失败：{}", error))?;
        self.read_response().await
    }

    async fn login(&mut self, user: &str, password: &str) -> Result<(), String> {
        let (code, text) = self.command(&format!("USER {}", user)).await?;
        if code == 331 {
            let (code, text2) = self.command(&format!("PASS {}", password)).await?;
            if code / 100 != 2 {
                return Err(format!("FTP 登录失败：{}", text2.trim()));
            }
        } else if code / 100 != 2 {
            return Err(format!("FTP 登录失败：{}", text.trim()));
        }
        let (code, text) = self.command("TYPE I").await?;
        if code / 100 != 2 {
            return Err(format!("FTP 无法切换到二进制模式：{}", text.trim()));
        }
        Ok(())
    }

    async fn passive(&mut self) -> Result<TcpStream, String> {
        let (code, text) = self.command("EPSV").await?;
        let port = if code == 229 {
            parse_epsv(&text)
        } else {
            let (code, text) = self.command("PASV").await?;
            if code != 227 {
                return Err(format!("FTP 被动模式失败：{}", text.trim()));
            }
            parse_pasv(&text)
        };
        let port = port.ok_or("FTP 无法解析被动模式端口")?;
        let stream = tokio::time::timeout(Duration::from_secs(25), TcpStream::connect((self.host.as_str(), port)))
            .await
            .map_err(|_| "FTP 数据连接超时".to_string())?
            .map_err(|error| format!("FTP 数据连接失败：{}", error))?;
        Ok(stream)
    }

    async fn size(&mut self, path: &str) -> Option<u64> {
        let (code, text) = self.command(&format!("SIZE {}", path)).await.ok()?;
        if code != 213 { return None; }
        text.lines().next_back()?.trim().parse().ok()
    }

    async fn retr(&mut self, path: &str, offset: u64) -> Result<TcpStream, String> {
        if offset > 0 {
            let (code, text) = self.command(&format!("REST {}", offset)).await?;
            if code != 350 {
                return Err(format!("FTP 服务器不支持断点续传：{}", text.trim()));
            }
        }
        let data = self.passive().await?;
        let mut command = format!("RETR {}", path);
        command.push_str("\r\n");
        self.reader.get_mut().write_all(command.as_bytes()).await.map_err(|error| format!("FTP 发送 RETR 失败：{}", error))?;
        let (code, text) = self.read_response().await?;
        if code / 100 != 1 && code / 100 != 2 {
            return Err(format!("FTP 下载请求被拒绝：{}", text.trim()));
        }
        Ok(data)
    }
}

pub async fn probe_ftp(raw: &str) -> Result<ProbeResult, String> {
    let target = parse_ftp_target(raw)?;
    if target.secure {
        return Err("FTPS 暂未支持，请使用 http/https 或普通 ftp:// 地址".into());
    }
    let mut control = FtpControl::connect(&target.host, target.port).await?;
    control.login(&target.user, &target.password).await?;
    let total = control.size(&target.path).await.unwrap_or(0);
    let file_name = filename_from_url(raw).or_else(|| target.path.rsplit('/').next().map(|value| value.to_string()));
    Ok(ProbeResult {
        final_url: raw.to_string(),
        protocol: "ftp".into(),
        kind: "file".into(),
        file_name,
        total_bytes: total,
        range_supported: true,
        mime_type: None,
        etag: None,
        last_modified: None,
        status: 200,
    })
}

pub async fn download_ftp(
    raw: &str,
    destination: &Path,
    cancel: Arc<AtomicBool>,
    progress: Arc<AtomicU64>,
    speed_limit_bps: u64,
) -> Result<u64, String> {
    let target = parse_ftp_target(raw)?;
    if target.secure {
        return Err("FTPS 暂未支持".into());
    }
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| format!("创建目录失败：{}", error))?;
    }
    let existing = tokio::fs::metadata(destination).await.map(|m| m.len()).unwrap_or(0);
    let mut control = FtpControl::connect(&target.host, target.port).await?;
    control.login(&target.user, &target.password).await?;
    let total = control.size(&target.path).await.unwrap_or(0);
    let offset = if total > 0 && existing > 0 && existing < total { existing } else { 0 };
    if offset == 0 && existing > 0 {
        let _ = tokio::fs::remove_file(destination).await;
    }

    let mut data = match control.retr(&target.path, offset).await {
        Ok(data) => data,
        Err(error) if offset > 0 => {
            let _ = tokio::fs::remove_file(destination).await;
            progress.store(0, Ordering::Relaxed);
            control.retr(&target.path, 0).await.map_err(|_| error)?
        }
        Err(error) => return Err(error),
    };

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(destination)
        .await
        .map_err(|error| format!("打开文件失败：{}", error))?;
    if offset > 0 {
        file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|error| error.to_string())?;
    }
    let mut buffer = vec![0u8; 128 * 1024];
    let mut downloaded = offset;
    loop {
        check_cancel(&cancel)?;
        let read = data.read(&mut buffer).await.map_err(|error| format!("FTP 数据读取失败：{}", error))?;
        if read == 0 { break; }
        file.write_all(&buffer[..read]).await.map_err(|error| format!("写入文件失败：{}", error))?;
        downloaded += read as u64;
        progress.store(downloaded, Ordering::Relaxed);
        throttle(read as u64, speed_limit_bps).await;
    }
    file.flush().await.ok();
    drop(data);
    let (code, text) = control.read_response().await?;
    if code != 226 && code != 250 {
        return Err(format!("FTP 传输未正常结束：{}", text.trim()));
    }
    if total > 0 && downloaded < total {
        return Err("FTP 下载不完整".into());
    }
    Ok(if total > 0 { total } else { downloaded })
}
