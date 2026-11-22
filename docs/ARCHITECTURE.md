# 架构

## 总览

```text
Chrome MV3 extension ──HTTP(127.0.0.1)──┐
                                        ▼
React renderer ──Tauri IPC──► lib.rs ──► DownloadManager ──► engine/*
                                        │                      ├─ probe
                                        ▼                      ├─ http (Range ×64)
                                  axum /api/v1                 ├─ ftp
                                                               ├─ hls + AES-128
                                                               ├─ dash + ffmpeg
                                                               └─ fragments / stream
```

- **UI**：React 19 + 自定义 CSS，通过 `window.mdm` 抽象调用 Tauri 命令；`tauri-shim.ts` 把 `invoke(channel, payload)` 统一转给 `mdm_invoke`。
- **状态**：`DownloadManager` 是唯一事实来源；每 500ms tick 更新速度/ETA，每 6s 落盘一次，状态变化立即持久化。
- **执行**：每个任务在独立 `tokio` 任务中运行，`AtomicBool` 取消、`AtomicU64` 进度、`AtomicU32` 活跃连接数。
- **前端刷新**：后端每 500ms `emit('state:update', snapshot)`，前端同时保留 4s 兜底刷新。

## 下载流程

1. `add` 校验 URL/目录/校验值，创建 `queued` 任务并持久化。
2. `schedule` 按 `maxConcurrentDownloads` 启动任务，状态 `connecting`。
3. `prepare` 调用 probe：
   - HTTP：`Range: bytes=0-0`，206 + `Content-Range` 才认为支持分片。
   - 文件：按 `min(64, total/256KiB)` 规划分段。
   - HLS/DASH：记录流类型，设置输出扩展名与 `fragment_dir`。
4. 下载：
   - HTTP：预分配临时文件，每个分段 `seek + Range` 写入同一文件；失败重试 4 次；暂停后按临时文件长度恢复。
   - HLS：解析主/媒体播放列表，选最高码率；下载 init + 分片，AES-128 解密，按序 concat；可选 ffmpeg 转封装。
   - DASH：解析最高带宽视频/音频轨，分别下载、concat，再用 ffmpeg 合并。
   - FTP：EPSV/PASV + REST 断点续传，单连接。
5. `finalize`：SHA-256 校验（可选）、重命名到最终路径、清理分片目录、标记 `completed`。

## 关键不变量

- 临时文件永远是 `<最终文件>.mdm-part`；完成后原子重命名。
- HLS/DASH 的分片按 5 位序号命名，暂停/重启时扫描目录恢复已完成的序号。
- 失败不会自动删除用户已完成的文件；`remove` 只删除任务记录与临时文件。
- API 令牌比较使用常量时间比较，服务只监听 `127.0.0.1`。

## 目录

```text
src-tauri/src/
  model.rs       与 src/shared/types.ts 对齐的 camelCase 数据结构
  util.rs        文件名/URL/内容范围/错误文案
  manager.rs     状态机、队列、持久化、tick
  api.rs         axum 路由、鉴权、CORS
  lib.rs         Tauri 命令与窗口控制
  engine/
    mod.rs       HTTP 客户端、请求头、ffmpeg、限速
    probe.rs     协议/类型/大小/分片能力探测
    http.rs      64 分段 Range 下载
    ftp.rs       原生异步 FTP 客户端
    hls.rs       m3u8 解析
    hls_download.rs
    dash.rs      MPD 解析（roxmltree）
    dash_download.rs
    fragments.rs 分片并发、AES-128、重试
    stream.rs    流任务与进度类型
```
