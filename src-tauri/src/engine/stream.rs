use crate::model::RequestOptions;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub type ProgressFn = Arc<dyn Fn(u32, u64) + Send + Sync>;

#[derive(Clone)]
pub struct StreamJob {
    pub url: String,
    pub output_path: PathBuf,
    pub fragment_dir: PathBuf,
    pub connections: u32,
    pub speed_limit_bps: u64,
    pub request: Option<RequestOptions>,
    pub cancel: Arc<AtomicBool>,
    pub remux_streams: bool,
    pub existing_fragments: Vec<u32>,
    pub on_fragment: ProgressFn,
}

#[derive(Clone, Debug, Default)]
pub struct StreamOutput {
    pub total_bytes: u64,
    pub fragments_total: u32,
    pub encryption: Option<String>,
    pub variant: Option<String>,
    pub remuxed: bool,
    pub output_kind: String,
    pub kind: String,
}
