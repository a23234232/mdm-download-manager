use crate::engine::resolve_url;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct HlsKey {
    pub uri: String,
    pub iv: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct HlsInit {
    pub url: String,
    pub range: Option<(u64, u64)>,
}

#[derive(Clone, Debug)]
pub struct HlsFragment {
    pub index: u32,
    pub sequence: u64,
    pub url: String,
    pub range: Option<(u64, u64)>,
    pub key: Option<HlsKey>,
    pub init: Option<HlsInit>,
}

#[derive(Clone, Debug, Default)]
pub struct HlsMedia {
    pub fragments: Vec<HlsFragment>,
    pub init: Option<HlsInit>,
    pub end_list: bool,
    pub media_sequence: u64,
}

#[derive(Clone, Debug)]
pub struct HlsVariant {
    pub bandwidth: u64,
    pub url: String,
}

#[derive(Clone, Debug)]
pub enum HlsPlaylist {
    Master(Vec<HlsVariant>),
    Media(HlsMedia),
}

fn parse_attributes(input: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in input.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            ',' if !quoted => {
                if let Some((key, value)) = current.split_once('=') {
                    map.insert(key.trim().to_ascii_uppercase(), value.trim().trim_matches('"').to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if let Some((key, value)) = current.split_once('=') {
        map.insert(key.trim().to_ascii_uppercase(), value.trim().trim_matches('"').to_string());
    }
    map
}

fn parse_byterange(value: &str) -> Option<(u64, Option<u64>)> {
    let mut parts = value.split('@');
    let length = parts.next()?.trim().parse::<u64>().ok()?;
    let offset = parts.next().and_then(|part| part.trim().parse::<u64>().ok());
    Some((length, offset))
}

fn parse_iv(value: &str) -> Option<Vec<u8>> {
    let clean = value.trim().trim_start_matches("0x").trim_start_matches("0X");
    if clean.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(16);
    let mut index = 0;
    while index + 1 < clean.len() && bytes.len() < 16 {
        let byte = u8::from_str_radix(&clean[index..index + 2], 16).ok()?;
        bytes.push(byte);
        index += 2;
    }
    if bytes.is_empty() { None } else { Some(bytes) }
}

pub fn parse_playlist(text: &str, base_url: &str) -> Result<HlsPlaylist, String> {
    let mut variants: Vec<HlsVariant> = Vec::new();
    let mut fragments: Vec<HlsFragment> = Vec::new();
    let mut init: Option<HlsInit> = None;
    let mut current_key: Option<HlsKey> = None;
    let mut end_list = false;
    let mut media_sequence = 0u64;
    let mut pending_variant: Option<u64> = None;
    let mut next_range: Option<(u64, Option<u64>)> = None;
    let mut last_range_end = 0u64;
    let mut seen_media_tags = false;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() { continue; }
        if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let parsed = parse_attributes(attrs);
            let bandwidth = parsed.get("BANDWIDTH").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
            pending_variant = Some(bandwidth);
            continue;
        }
        if let Some(attrs) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_sequence = attrs.trim().parse::<u64>().unwrap_or(0);
            seen_media_tags = true;
            continue;
        }
        if let Some(attrs) = line.strip_prefix("#EXT-X-KEY:") {
            let parsed = parse_attributes(attrs);
            let method = parsed.get("METHOD").cloned().unwrap_or_else(|| "NONE".into());
            if method.eq_ignore_ascii_case("NONE") {
                current_key = None;
            } else if method.eq_ignore_ascii_case("AES-128") {
                let uri = parsed.get("URI").cloned().ok_or_else(|| "HLS 密钥缺少 URI".to_string())?;
                current_key = Some(HlsKey {
                    uri: resolve_url(base_url, &uri),
                    iv: parsed.get("IV").and_then(|value| parse_iv(value)),
                });
            } else {
                return Err(format!("不支持的 HLS 加密方式：{}", method));
            }
            seen_media_tags = true;
            continue;
        }
        if let Some(attrs) = line.strip_prefix("#EXT-X-MAP:") {
            let parsed = parse_attributes(attrs);
            let uri = parsed.get("URI").cloned().ok_or_else(|| "HLS 初始化片段缺少 URI".to_string())?;
            let range = parsed.get("BYTERANGE").and_then(|value| parse_byterange(value)).map(|(length, offset)| {
                let start = offset.unwrap_or(0);
                (start, start + length - 1)
            });
            init = Some(HlsInit { url: resolve_url(base_url, &uri), range });
            seen_media_tags = true;
            continue;
        }
        if let Some(attrs) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            next_range = parse_byterange(attrs.trim());
            continue;
        }
        if line.starts_with("#EXTINF:") {
            seen_media_tags = true;
            continue;
        }
        if line == "#EXT-X-ENDLIST" {
            end_list = true;
            continue;
        }
        if line.starts_with('#') { continue; }

        if let Some(bandwidth) = pending_variant.take() {
            variants.push(HlsVariant { bandwidth, url: resolve_url(base_url, line) });
            continue;
        }
        let range = next_range.take().map(|(length, offset)| {
            let start = offset.unwrap_or(last_range_end);
            last_range_end = start + length;
            (start, start + length - 1)
        });
        let index = fragments.len() as u32 + 1;
        fragments.push(HlsFragment {
            index,
            sequence: media_sequence + index as u64 - 1,
            url: resolve_url(base_url, line),
            range,
            key: current_key.clone(),
            init: init.clone(),
        });
        seen_media_tags = true;
    }

    if !variants.is_empty() && fragments.is_empty() {
        variants.sort_by(|a, b| b.bandwidth.cmp(&a.bandwidth));
        return Ok(HlsPlaylist::Master(variants));
    }
    if fragments.is_empty() && !seen_media_tags {
        return Err("不是有效的 HLS 播放列表".into());
    }
    Ok(HlsPlaylist::Media(HlsMedia { fragments, init, end_list, media_sequence }))
}

pub fn best_variant(variants: &[HlsVariant]) -> Option<&HlsVariant> {
    variants.iter().max_by_key(|variant| variant.bandwidth)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_master_variants() {
        let text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhigh.m3u8\n";
        let playlist = parse_playlist(text, "https://cdn.example.com/master.m3u8").unwrap();
        match playlist {
            HlsPlaylist::Master(variants) => {
                assert_eq!(variants.len(), 2);
                assert_eq!(variants[0].bandwidth, 2_000_000);
                assert_eq!(variants[0].url, "https://cdn.example.com/high.m3u8");
            }
            _ => panic!("expected master playlist"),
        }
    }

    #[test]
    fn parses_media_sequence_and_byterange() {
        let text = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:4,\nseg0.ts\n#EXT-X-BYTERANGE:100@50\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n";
        let playlist = parse_playlist(text, "https://cdn.example.com/live/index.m3u8").unwrap();
        match playlist {
            HlsPlaylist::Media(media) => {
                assert!(media.end_list);
                assert_eq!(media.media_sequence, 7);
                assert_eq!(media.fragments.len(), 2);
                assert_eq!(media.fragments[0].sequence, 7);
                assert_eq!(media.fragments[1].sequence, 8);
                assert_eq!(media.fragments[1].range, Some((50, 149)));
                assert_eq!(media.fragments[1].url, "https://cdn.example.com/live/seg1.ts");
            }
            _ => panic!("expected media playlist"),
        }
    }

    #[test]
    fn parses_aes_key() {
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x000102030405060708090a0b0c0d0e0f\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST\n";
        let playlist = parse_playlist(text, "https://cdn.example.com/a/index.m3u8").unwrap();
        match playlist {
            HlsPlaylist::Media(media) => {
                let key = media.fragments[0].key.as_ref().unwrap();
                assert_eq!(key.uri, "https://cdn.example.com/a/key.bin");
                assert_eq!(key.iv.as_ref().unwrap().len(), 16);
            }
            _ => panic!("expected media playlist"),
        }
    }
}
