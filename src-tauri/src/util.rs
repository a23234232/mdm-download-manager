use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn sanitize_file_name(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim_matches([' ', '.']).to_string();
    let mut name = if trimmed.is_empty() { "download".to_string() } else { trimmed };
    let upper = name.to_uppercase();
    let base = upper.split('.').next().unwrap_or("");
    if matches!(base, "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9") {
        name = format!("_{}", name);
    }
    if name.chars().count() > 180 {
        let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
        let stem: String = name.chars().take(160).collect();
        name = if ext.is_empty() { stem } else { format!("{}.{}", stem, ext) };
    }
    name
}

pub fn filename_from_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let segment = url.path_segments()?.last()?.trim();
    if segment.is_empty() { return None; }
    let decoded = percent_encoding::percent_decode_str(segment).decode_utf8_lossy().to_string();
    let name = sanitize_file_name(&decoded);
    if name.is_empty() { None } else { Some(name) }
}

pub fn extension_of(name: &str) -> String {
    Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

pub fn category_for(name: &str) -> String {
    let ext = extension_of(name);
    if matches!(ext.as_str(), "mp4" | "mkv" | "avi" | "mov" | "webm" | "flv" | "wmv" | "m4v" | "ts" | "mpg" | "mpeg" | "3gp") {
        "video".into()
    } else if matches!(ext.as_str(), "mp3" | "flac" | "wav" | "aac" | "ogg" | "m4a" | "opus" | "wma") {
        "audio".into()
    } else if matches!(ext.as_str(), "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "epub" | "csv") {
        "document".into()
    } else if matches!(ext.as_str(), "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso") {
        "archive".into()
    } else if matches!(ext.as_str(), "exe" | "msi" | "dmg" | "pkg" | "deb" | "rpm" | "apk") {
        "program".into()
    } else if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif") {
        "image".into()
    } else {
        "other".into()
    }
}

pub fn split_name(name: &str) -> (String, String) {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string();
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_string();
    (stem, ext)
}

pub fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() { return path.to_path_buf(); }
    let (stem, ext) = split_name(path.file_name().and_then(|n| n.to_str()).unwrap_or("download"));
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    for n in 2..10_000u32 {
        let candidate = if ext.is_empty() {
            parent.join(format!("{} ({})", stem, n))
        } else {
            parent.join(format!("{} ({}).{}", stem, n, ext))
        };
        if !candidate.exists() { return candidate; }
    }
    parent.join(format!("{}-{}.{}", stem, now_ms(), ext))
}

pub fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let rest = value.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?, total.trim().parse().ok()?))
}

pub fn parse_content_disposition(value: &str) -> Option<String> {
    for part in value.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=") {
            let rest = rest.trim_matches('"');
            if let Some((_, encoded)) = rest.split_once("''") {
                let decoded = percent_encoding::percent_decode_str(encoded).decode_utf8_lossy().to_string();
                return Some(sanitize_file_name(&decoded));
            }
        }
        if let Some(rest) = part.strip_prefix("filename=") {
            let name = rest.trim().trim_matches('"');
            if !name.is_empty() { return Some(sanitize_file_name(name)); }
        }
    }
    None
}

pub fn human_error(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") { return "连接超时，请检查网络或稍后重试".into(); }
    if lower.contains("dns") || lower.contains("failed to lookup") { return "无法解析服务器地址".into(); }
    if lower.contains("connection refused") { return "服务器拒绝连接".into(); }
    if lower.contains("certificate") || lower.contains("tls") { return "HTTPS 证书校验失败".into(); }
    if lower.contains("403") { return "服务器拒绝了请求（403）".into(); }
    if lower.contains("404") { return "资源不存在（404）".into(); }
    if lower.contains("401") { return "需要登录或授权（401）".into(); }
    if lower.contains("416") { return "服务器不接受当前分段范围".into(); }
    if lower.contains("no space") || lower.contains("disk full") { return "磁盘空间不足".into(); }
    if lower.contains("denied") || lower.contains("forbidden") { return "没有写入权限，请更换下载目录".into(); }
    message.to_string()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_range() {
        assert_eq!(parse_content_range("bytes 0-0/12345"), Some((0, 0, 12345)));
        assert_eq!(parse_content_range("bytes 100-199/200"), Some((100, 199, 200)));
        assert_eq!(parse_content_range("nonsense"), None);
    }

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(sanitize_file_name("a/b:c*?.zip"), "a_b_c__.zip");
        assert!(!sanitize_file_name("CON").is_empty());
    }

    #[test]
    fn detects_categories() {
        assert_eq!(category_for("movie.mkv"), "video");
        assert_eq!(category_for("album.flac"), "audio");
        assert_eq!(category_for("setup.exe"), "app");
        assert_eq!(category_for("archive.zip"), "archive");
    }
}
