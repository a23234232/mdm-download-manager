use crate::manager::DownloadManager;
use crate::model::{AddInput, ApiStatus};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{extract::Request, Json, Router};
use rand::RngCore;
use serde_json::json;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

pub struct ApiRuntime {
    manager: DownloadManager,
    data_dir: PathBuf,
    port: Mutex<u16>,
    token: Mutex<String>,
    running: AtomicBool,
    requests: AtomicU64,
    last_contact: Mutex<Option<i64>>,
    last_error: Mutex<Option<String>>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl ApiRuntime {
    pub fn new(manager: DownloadManager, data_dir: PathBuf, port: u16) -> Arc<Self> {
        let token_path = data_dir.join("api-token");
        let token = std::fs::read_to_string(&token_path)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| value.len() >= 32 && value.len() <= 96 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
            .unwrap_or_else(|| generate_token());
        let _ = std::fs::create_dir_all(&data_dir);
        let _ = std::fs::write(&token_path, &token);
        let runtime = Arc::new(Self {
            manager,
            data_dir,
            port: Mutex::new(port),
            token: Mutex::new(token),
            running: AtomicBool::new(false),
            requests: AtomicU64::new(0),
            last_contact: Mutex::new(None),
            last_error: Mutex::new(None),
            shutdown: Mutex::new(None),
        });
        runtime.publish();
        runtime
    }

    pub fn port(&self) -> u16 { *self.port.lock().unwrap() }
    pub fn token(&self) -> String { self.token.lock().unwrap().clone() }

    pub fn status(&self) -> ApiStatus {
        let port = self.port();
        ApiStatus {
            running: self.running.load(Ordering::Relaxed),
            port,
            token: self.token(),
            url: format!("http://127.0.0.1:{}/api/v1", port),
            last_extension_contact_at: *self.last_contact.lock().unwrap(),
            last_error: self.last_error.lock().unwrap().clone(),
            requests: self.requests.load(Ordering::Relaxed),
        }
    }

    fn publish(&self) {
        self.manager.set_api_status(self.status());
    }

    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        let port = self.port();
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = match tokio::net::TcpListener::bind(address).await {
            Ok(listener) => listener,
            Err(error) => {
                let message = format!("端口 {} 无法监听：{}", port, error);
                *self.last_error.lock().unwrap() = Some(message.clone());
                self.running.store(false, Ordering::Relaxed);
                self.publish();
                return Err(message);
            }
        };
        let (sender, receiver) = oneshot::channel::<()>();
        *self.shutdown.lock().unwrap() = Some(sender);
        let state = self.clone();
        let app = Router::new()
            .route("/api/v1", get(root))
            .route("/api/v1/ping", get(root))
            .route("/api/v1/health", get(health))
            .route("/api/v1/stats", get(stats))
            .route("/api/v1/tasks", get(list_tasks).post(add_task))
            .route("/api/v1/tasks/clear-completed", post(clear_completed))
            .route("/api/v1/tasks/{id}", get(get_task).delete(remove_task))
            .route("/api/v1/tasks/{id}/pause", post(pause_task))
            .route("/api/v1/tasks/{id}/resume", post(resume_task))
            .route("/api/v1/tasks/{id}/cancel", post(cancel_task))
            .route("/api/v1/tasks/{id}/retry", post(retry_task))
            .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
            .layer(
                CorsLayer::new()
                    .allow_origin(Any)
                    .allow_methods(Any)
                    .allow_headers(Any),
            )
            .layer(middleware::from_fn_with_state(state.clone(), auth))
            .with_state(state.clone());
        self.running.store(true, Ordering::Relaxed);
        *self.last_error.lock().unwrap() = None;
        self.publish();
        tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async {
                let _ = receiver.await;
            });
            if let Err(error) = server.await {
                let _ = error;
            }
            state.running.store(false, Ordering::Relaxed);
            state.publish();
        });
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(sender) = self.shutdown.lock().unwrap().take() {
            let _ = sender.send(());
        }
        self.running.store(false, Ordering::Relaxed);
        self.publish();
    }

    pub async fn set_port(self: &Arc<Self>, port: u16) -> Result<(), String> {
        self.stop().await;
        *self.port.lock().unwrap() = port;
        self.start().await
    }

    pub async fn rotate_token(&self) -> Result<String, String> {
        let token = generate_token();
        *self.token.lock().unwrap() = token.clone();
        let path = self.data_dir.join("api-token");
        tokio::fs::write(&path, &token).await.map_err(|error| format!("保存令牌失败：{}", error))?;
        self.publish();
        Ok(token)
    }

    fn touch(&self) {
        let count = self.requests.fetch_add(1, Ordering::Relaxed) + 1;
        *self.last_contact.lock().unwrap() = Some(crate::util::now_ms());
        self.manager.update_api_contact(count);
        self.publish();
    }
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() { return false; }
    let mut diff = 0u8;
    for (a, b) in left.bytes().zip(right.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    if let Some(value) = headers.get("x-mdm-token").and_then(|value| value.to_str().ok()) {
        if constant_time_eq(value.trim(), token) { return true; }
    }
    if let Some(value) = headers.get("authorization").and_then(|value| value.to_str().ok()) {
        if let Some(value) = value.strip_prefix("Bearer ") {
            if constant_time_eq(value.trim(), token) { return true; }
        }
    }
    false
}

async fn auth(State(state): State<Arc<ApiRuntime>>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if path == "/api/v1" || path == "/api/v1/ping" {
        return next.run(request).await;
    }
    let token = state.token();
    if !authorized(request.headers(), &token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "扩展令牌无效，请在 MDM 设置中重新复制令牌", "code": "unauthorized" }))).into_response();
    }
    state.touch();
    next.run(request).await
}

async fn root() -> Json<serde_json::Value> {
    Json(json!({
        "name": "MDM",
        "version": env!("CARGO_PKG_VERSION"),
        "api": "v1",
        "requiresToken": true
    }))
}

async fn health(State(state): State<Arc<ApiRuntime>>) -> Json<serde_json::Value> {
    let snapshot = state.manager.snapshot();
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "stats": snapshot.get("stats").cloned().unwrap_or(serde_json::Value::Null)
    }))
}

async fn stats(State(state): State<Arc<ApiRuntime>>) -> Json<serde_json::Value> {
    let snapshot = state.manager.snapshot();
    Json(snapshot.get("stats").cloned().unwrap_or(serde_json::Value::Null))
}

async fn list_tasks(State(state): State<Arc<ApiRuntime>>) -> Json<serde_json::Value> {
    let tasks = state.manager.public_tasks();
    let active = tasks.iter().filter(|task| {
        task.get("status").and_then(|value| value.as_str()).map(|status| matches!(status, "downloading" | "connecting" | "queued")).unwrap_or(false)
    }).count();
    Json(json!({ "tasks": tasks, "active": active }))
}

async fn get_task(State(state): State<Arc<ApiRuntime>>, Path(id): Path<String>) -> Response {
    match state.manager.get_task(&id) {
        Some(task) => Json(task.to_public()).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "任务不存在" }))).into_response(),
    }
}

async fn add_task(State(state): State<Arc<ApiRuntime>>, Json(input): Json<AddInput>) -> Response {
    match state.manager.add(input).await {
        Ok(id) => {
            let task = state.manager.get_task(&id).map(|task| task.to_public()).unwrap_or(serde_json::Value::Null);
            (StatusCode::CREATED, Json(json!({ "id": id, "task": task }))).into_response()
        }
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

async fn remove_task(State(state): State<Arc<ApiRuntime>>, Path(id): Path<String>) -> Response {
    action_response(state.manager.remove(&id).await)
}

async fn pause_task(State(state): State<Arc<ApiRuntime>>, Path(id): Path<String>) -> Response {
    action_response(state.manager.pause(&id).await)
}

async fn resume_task(State(state): State<Arc<ApiRuntime>>, Path(id): Path<String>) -> Response {
    action_response(state.manager.resume(&id).await)
}

async fn cancel_task(State(state): State<Arc<ApiRuntime>>, Path(id): Path<String>) -> Response {
    action_response(state.manager.cancel(&id).await)
}

async fn retry_task(State(state): State<Arc<ApiRuntime>>, Path(id): Path<String>) -> Response {
    action_response(state.manager.retry(&id).await)
}

async fn clear_completed(State(state): State<Arc<ApiRuntime>>) -> Response {
    action_response(state.manager.clear_completed().await)
}

fn action_response(result: Result<(), String>) -> Response {
    match result {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}
