use serde::{Deserialize, Serialize};

pub const MAX_SEGMENTS: u32 = 64;
pub const MIN_SEGMENT_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SegmentState {
    pub index: u32,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamState {
    pub kind: String,
    pub fragments_total: u32,
    pub fragments_done: u32,
    pub completed_fragments: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remuxed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_kind: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RequestOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookies: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referrer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChecksumSpec {
    pub algorithm: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub protocol: String,
    pub status: String,
    pub file_name: String,
    pub directory: String,
    #[serde(default)]
    pub save_path: String,
    #[serde(default)]
    pub temp_path: String,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub downloaded_bytes: u64,
    #[serde(default)]
    pub speed: f64,
    #[serde(default)]
    pub eta_seconds: Option<f64>,
    #[serde(default = "default_connections")]
    pub connections: u32,
    #[serde(default)]
    pub active_connections: u32,
    #[serde(default)]
    pub range_supported: bool,
    #[serde(default)]
    pub resumable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub segments: Vec<SegmentState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<StreamState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<ChecksumSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_limit_bps: Option<u64>,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment_dir: Option<String>,
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub file_missing: bool,
    #[serde(skip)]
    pub auto_named: bool,
}

fn default_connections() -> u32 { 16 }
fn default_category() -> String { "other".to_string() }
fn default_source() -> String { "app".to_string() }

impl DownloadTask {
    pub fn to_public(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(object) = value.as_object_mut() {
            let has_headers = self.request.as_ref().and_then(|r| r.headers.as_ref()).map(|h| !h.is_empty()).unwrap_or(false);
            let has_cookies = self.request.as_ref().and_then(|r| r.cookies.as_ref()).map(|c| !c.is_empty()).unwrap_or(false);
            object.insert("hasCustomHeaders".into(), serde_json::Value::Bool(has_headers));
            object.insert("hasCookies".into(), serde_json::Value::Bool(has_cookies));
            object.remove("request");
            if let Some(stream) = object.get_mut("stream").and_then(|s| s.as_object_mut()) {
                let count = self.stream.as_ref().map(|s| s.completed_fragments.len()).unwrap_or(0);
                stream.insert("completedFragments".into(), serde_json::json!(count));
            }
        }
        value
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub download_directory: String,
    pub max_concurrent_downloads: u32,
    pub default_connections: u32,
    pub global_speed_limit_bps: u64,
    pub port: u16,
    pub auto_start: bool,
    pub notifications: bool,
    pub remux_streams: bool,
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_directory: String::new(),
            max_concurrent_downloads: 8,
            default_connections: 16,
            global_speed_limit_bps: 0,
            port: 45721,
            auto_start: false,
            notifications: true,
            remux_streams: true,
            theme: "dark".into(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub download_directory: Option<String>,
    pub max_concurrent_downloads: Option<u32>,
    pub default_connections: Option<u32>,
    pub global_speed_limit_bps: Option<u64>,
    pub port: Option<u16>,
    pub auto_start: Option<bool>,
    pub notifications: Option<bool>,
    pub remux_streams: Option<bool>,
    pub theme: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddInput {
    pub url: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub connections: Option<u32>,
    #[serde(default)]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub cookies: Option<String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub checksum: Option<String>,
    #[serde(default)]
    pub speed_limit_bps: Option<u64>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    pub running: bool,
    pub port: u16,
    pub token: String,
    pub url: String,
    pub last_extension_contact_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub requests: u64,
}
