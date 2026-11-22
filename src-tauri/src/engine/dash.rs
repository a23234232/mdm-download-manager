use crate::engine::resolve_url;
use roxmltree::{Document, Node};

#[derive(Clone, Debug)]
pub struct DashFragment {
    pub index: u32,
    pub url: String,
    pub range: Option<(u64, u64)>,
}

#[derive(Clone, Debug)]
pub struct DashTrack {
    pub id: String,
    pub kind: String,
    pub mime_type: Option<String>,
    pub codecs: Option<String>,
    pub bandwidth: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub language: Option<String>,
    pub init_url: Option<String>,
    pub fragments: Vec<DashFragment>,
}

#[derive(Clone, Debug, Default)]
pub struct DashPlan {
    pub video: Option<DashTrack>,
    pub audio: Option<DashTrack>,
    pub duration_seconds: f64,
    pub drm_protected: bool,
}

#[derive(Clone, Debug, Default)]
struct Template {
    media: String,
    initialization: Option<String>,
    start_number: u64,
    duration: Option<u64>,
    timescale: u64,
    timeline: Vec<(Option<u64>, u64, i64)>,
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.is_element() && child.tag_name().name() == name)
}

fn text_of(node: Node) -> Option<String> {
    node.text().map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

fn base_of(node: Node, parent: &str) -> String {
    if let Some(base) = child(node, "BaseURL").and_then(text_of) {
        resolve_url(parent, &base)
    } else {
        parent.to_string()
    }
}

fn number(node: Node, name: &str) -> Option<u64> {
    node.attribute(name).and_then(|value| value.trim().parse::<u64>().ok())
}

fn read_template(node: Node) -> Option<Template> {
    let template = child(node, "SegmentTemplate")?;
    let timeline = child(template, "SegmentTimeline")
        .map(|timeline| {
            timeline
                .children()
                .filter(|child| child.is_element() && child.tag_name().name() == "S")
                .map(|item| {
                    (
                        number(item, "t"),
                        number(item, "d").unwrap_or(0),
                        item.attribute("r").and_then(|value| value.trim().parse::<i64>().ok()).unwrap_or(0),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(Template {
        media: template.attribute("media").unwrap_or("").to_string(),
        initialization: template.attribute("initialization").map(|value| value.to_string()),
        start_number: number(template, "startNumber").unwrap_or(1),
        duration: number(template, "duration"),
        timescale: number(template, "timescale").unwrap_or(1).max(1),
        timeline,
    })
}

fn replace_template(template: &str, rep_id: &str, bandwidth: u64, number: u64, time: u64) -> String {
    let mut result = String::with_capacity(template.len() + 16);
    let mut rest = template;
    while let Some(start) = rest.find('$') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('$') else {
            result.push('$');
            result.push_str(after);
            return result;
        };
        let token = &after[..end];
        let (name, width) = match token.split_once('%') {
            Some((name, format)) => {
                let width = format.trim_end_matches('d').trim_start_matches('0').parse::<usize>().ok();
                (name, width)
            }
            None => (token, None),
        };
        let value = match name {
            "RepresentationID" => rep_id.to_string(),
            "Bandwidth" => bandwidth.to_string(),
            "Number" => number.to_string(),
            "Time" => time.to_string(),
            _ => String::new(),
        };
        if let Some(width) = width {
            result.push_str(&format!("{:0width$}", value, width = width));
        } else {
            result.push_str(&value);
        }
        rest = &after[end + 1..];
    }
    result.push_str(rest);
    result
}

fn build_template_fragments(template: &Template, base: &str, rep_id: &str, bandwidth: u64, duration: f64) -> Vec<DashFragment> {
    let mut urls: Vec<String> = Vec::new();
    if !template.timeline.is_empty() {
        let mut current = 0u64;
        let mut number = template.start_number;
        for (start, duration, repeat) in &template.timeline {
            if let Some(start) = start { current = *start; }
            let repeats = if *repeat >= 0 { *repeat as u64 + 1 } else { 1 };
            for _ in 0..repeats {
                urls.push(resolve_url(
                    base,
                    &replace_template(&template.media, rep_id, bandwidth, number, current),
                ));
                number += 1;
                current = current.saturating_add(*duration);
            }
        }
    } else {
        let segment_duration = template.duration.unwrap_or(4 * template.timescale) as f64 / template.timescale as f64;
        let count = if segment_duration > 0.0 { (duration / segment_duration).ceil() as u64 } else { 1 };
        for index in 0..count.max(1) {
            let number = template.start_number + index;
            let time = index * template.duration.unwrap_or(0);
            urls.push(resolve_url(
                base,
                &replace_template(&template.media, rep_id, bandwidth, number, time),
            ));
        }
    }
    urls.into_iter().enumerate().map(|(index, url)| DashFragment { index: index as u32, url, range: None }).collect()
}

fn build_segment_list(node: Node, base: &str) -> Vec<DashFragment> {
    let Some(list) = child(node, "SegmentList") else { return Vec::new(); };
    list.children()
        .filter(|child| child.is_element() && child.tag_name().name() == "SegmentURL")
        .enumerate()
        .filter_map(|(index, entry)| {
            let media = entry.attribute("media")?.to_string();
            let range = entry.attribute("mediaRange").and_then(|value| {
                let (start, end) = value.split_once('-')?;
                Some((start.parse::<u64>().ok()?, end.parse::<u64>().ok()?))
            });
            Some(DashFragment { index: index as u32, url: resolve_url(base, &media), range })
        })
        .collect()
}

fn init_from_template(template: Option<&Template>, base: &str, rep_id: &str, bandwidth: u64) -> Option<String> {
    let template = template?;
    let init = template.initialization.as_ref()?;
    Some(resolve_url(base, &replace_template(init, rep_id, bandwidth, 0, 0)))
}

fn parse_iso_duration(value: &str) -> f64 {
    let mut total = 0.0;
    let mut number = String::new();
    let mut in_time = false;
    for ch in value.chars() {
        match ch {
            'P' => {}
            'T' => in_time = true,
            '0'..='9' | '.' => number.push(ch),
            'Y' | 'M' | 'D' | 'H' | 'S' => {
                let amount = number.parse::<f64>().unwrap_or(0.0);
                number.clear();
                total += match ch {
                    'Y' => amount * 31_536_000.0,
                    'M' => if in_time { amount * 60.0 } else { amount * 2_592_000.0 },
                    'D' => amount * 86_400.0,
                    'H' => amount * 3_600.0,
                    'S' => amount,
                    _ => 0.0,
                };
            }
            _ => {}
        }
    }
    total
}

pub fn parse_dash_manifest(text: &str, manifest_url: &str) -> Result<DashPlan, String> {
    let document = Document::parse(text).map_err(|error| format!("DASH 清单解析失败：{}", error))?;
    let root = document.root_element();
    let mpd_base = base_of(root, manifest_url);
    let period = root
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "Period")
        .ok_or_else(|| "DASH 清单中没有 Period".to_string())?;
    let period_base = base_of(period, &mpd_base);
    let duration = parse_iso_duration(period.attribute("duration").unwrap_or(""))
        .max(parse_iso_duration(root.attribute("mediaPresentationDuration").unwrap_or("")));

    let mut tracks: Vec<DashTrack> = Vec::new();
    let mut drm_protected = false;
    for adaptation in period.children().filter(|node| node.is_element() && node.tag_name().name() == "AdaptationSet") {
        if adaptation.descendants().any(|node| node.has_tag_name("ContentProtection")) {
            drm_protected = true;
        }
        let adaptation_base = base_of(adaptation, &period_base);
        let adaptation_type = adaptation.attribute("contentType").unwrap_or("").to_ascii_lowercase();
        let adaptation_mime = adaptation.attribute("mimeType").unwrap_or("").to_string();
        let adaptation_template = read_template(adaptation);
        for representation in adaptation.children().filter(|node| node.is_element() && node.tag_name().name() == "Representation") {
            let rep_base = base_of(representation, &adaptation_base);
            let id = representation.attribute("id").unwrap_or("0").to_string();
            let bandwidth = number(representation, "bandwidth").unwrap_or(0);
            let mime = representation.attribute("mimeType").unwrap_or(&adaptation_mime).to_string();
            let kind = if adaptation_type == "video" || mime.starts_with("video/") {
                "video"
            } else if adaptation_type == "audio" || mime.starts_with("audio/") {
                "audio"
            } else {
                continue;
            };
            let template = read_template(representation).or_else(|| adaptation_template.clone());
            let mut fragments = build_segment_list(representation, &rep_base);
            if fragments.is_empty() {
                if let Some(template) = &template {
                    if !template.media.is_empty() {
                        fragments = build_template_fragments(template, &rep_base, &id, bandwidth, duration);
                    }
                }
            }
            if fragments.is_empty() { continue; }
            tracks.push(DashTrack {
                id: id.clone(),
                kind: kind.to_string(),
                mime_type: if mime.is_empty() { None } else { Some(mime) },
                codecs: representation.attribute("codecs").map(|value| value.to_string()),
                bandwidth,
                width: number(representation, "width").map(|value| value as u32),
                height: number(representation, "height").map(|value| value as u32),
                language: adaptation.attribute("lang").map(|value| value.to_string()),
                init_url: init_from_template(template.as_ref(), &rep_base, &id, bandwidth),
                fragments,
            });
        }
    }
    if tracks.is_empty() {
        return Err("DASH 清单中没有可下载的音视频轨道".into());
    }
    let video = tracks.iter().filter(|track| track.kind == "video").max_by_key(|track| track.bandwidth).cloned();
    let audio = tracks.iter().filter(|track| track.kind == "audio").max_by_key(|track| track.bandwidth).cloned();
    if video.is_none() && audio.is_none() {
        return Err("DASH 清单中没有可下载的音视频轨道".into());
    }
    Ok(DashPlan { video, audio, duration_seconds: duration, drm_protected })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_segment_template() {
        let text = r#"<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT30S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" bandwidth="1200000" width="1280" height="720">
        <SegmentTemplate timescale="1" duration="10" startNumber="1" media="seg-$Number$.m4s" initialization="init.mp4" />
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"#;
        let plan = parse_dash_manifest(text, "https://cdn.example.com/movie/manifest.mpd").unwrap();
        let video = plan.video.expect("video track");
        assert_eq!(video.fragments.len(), 3);
        assert_eq!(video.init_url.as_deref(), Some("https://cdn.example.com/movie/init.mp4"));
        assert_eq!(video.fragments[0].url, "https://cdn.example.com/movie/seg-1.m4s");
    }

    #[test]
    fn parses_segment_list_ranges() {
        let text = r#"<MPD><Period><AdaptationSet contentType="audio">
  <Representation id="a1" bandwidth="128000">
    <SegmentList>
      <SegmentURL media="audio.mp4" mediaRange="0-9999"/>
      <SegmentURL media="audio.mp4" mediaRange="10000-19999"/>
    </SegmentList>
  </Representation>
</AdaptationSet></Period></MPD>"#;
        let plan = parse_dash_manifest(text, "https://cdn.example.com/a.mpd").unwrap();
        let audio = plan.audio.expect("audio track");
        assert_eq!(audio.fragments.len(), 2);
        assert_eq!(audio.fragments[1].range, Some((10000, 19999)));
    }
}
